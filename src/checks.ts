/**
 * Fast post-switch verification. Every probe is read-only and cheap: the
 * quota endpoint, a 1-token request to the Anthropic-compatible chat endpoint
 * Claude Code actually uses (base URL and model come from settings.json), and
 * an MCP `initialize` handshake for each configured server carrying the key.
 */

import type { McpServerConfig } from "./claude";
import { fetchQuota } from "./quota";
import type { StoredKey } from "./store";

export interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ClaudeEndpoint {
  /** ANTHROPIC_BASE_URL from settings, e.g. https://open.bigmodel.cn/api/anthropic. */
  baseUrl?: string;
  /** Cheapest configured model (haiku alias), used for the 1-token ping. */
  model?: string;
}

const CHECK_TIMEOUT_MS = 10_000;
// stdio servers launched via npx can spend tens of seconds on a cold package
// download before they answer the handshake.
const STDIO_TIMEOUT_MS = 30_000;

const INIT_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "list-tokens", version: "0.0.2" },
  },
};

function firstSseJson(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) return line.slice(5).trim();
  }
  return undefined;
}

async function checkQuota(key: StoredKey): Promise<CheckResult> {
  try {
    const quota = await fetchQuota(key.apiKey, {
      type: key.type,
      org: key.org,
      project: key.project,
    });
    const summary = quota.windows
      .map((w) => `${w.window} ${Math.round(w.usedPercent ?? 0)}%`)
      .join(", ");
    return {
      label: "quota",
      ok: true,
      detail: [quota.level, summary || "no windows"].filter(Boolean).join(" · "),
    };
  } catch (cause) {
    return {
      label: "quota",
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function checkAnthropic(endpoint: ClaudeEndpoint, apiKey: string): Promise<CheckResult> {
  const label = "anthropic endpoint";
  if (endpoint.baseUrl === undefined) {
    return { label, ok: true, detail: "skipped (no ANTHROPIC_BASE_URL in settings)" };
  }
  const model = endpoint.model ?? "glm-5.3-flash";
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const elapsed = Date.now() - startedAt;
    const body = await response.text();
    if (!response.ok) {
      const message = body.slice(0, 200).replace(/\s+/g, " ");
      return {
        label: `${label} (${model})`,
        ok: false,
        detail: `HTTP ${response.status}: ${message}`,
      };
    }
    return { label: `${label} (${model})`, ok: true, detail: `${elapsed}ms` };
  } catch (cause) {
    return {
      label: `${label} (${model})`,
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function checkMcpHttp(server: McpServerConfig): Promise<CheckResult> {
  const label = `mcp ${server.name}`;
  if (server.url === undefined) {
    return { label, ok: false, detail: "server has no url" };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...server.headers,
      },
      body: JSON.stringify(INIT_REQUEST),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      return { label, ok: false, detail: `HTTP ${response.status}` };
    }
    const payload = firstSseJson(body) ?? body;
    if (!/"result"/.test(payload)) {
      return { label, ok: false, detail: "handshake returned no result" };
    }
    return { label, ok: true, detail: `${Date.now() - startedAt}ms` };
  } catch (cause) {
    return { label, ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function checkMcpStdio(server: McpServerConfig): Promise<CheckResult> {
  const label = `mcp ${server.name}`;
  if (server.command === undefined) {
    return { label, ok: false, detail: "server has no command" };
  }
  const startedAt = Date.now();
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([server.command, ...(server.args ?? [])], {
      env: { ...process.env, ...server.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    return { label, ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }
  try {
    await proc.stdin.write(`${JSON.stringify(INIT_REQUEST)}\n`);
    await proc.stdin.end();
  } catch {
    proc.kill();
    return { label, ok: false, detail: "server closed stdin before responding" };
  }
  // Real servers keep running after replying, so watch stdout for the
  // initialize result instead of waiting for the process to exit.
  const deadline = startedAt + STDIO_TIMEOUT_MS;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ok = false;
  let timedOut = false;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          // Clear the timer after the race or it keeps the process alive.
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        timedOut = true;
        break;
      }
      if (outcome.done) break;
      buffer += decoder.decode(outcome.value, { stream: true });
      if (buffer.includes('"result"')) {
        ok = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    proc.kill();
  }
  if (ok) return { label, ok: true, detail: `${Date.now() - startedAt}ms` };
  return { label, ok: false, detail: timedOut ? "timed out" : "handshake returned no result" };
}

export async function runChecks(
  key: StoredKey,
  endpoint: ClaudeEndpoint,
  servers: McpServerConfig[],
): Promise<CheckResult[]> {
  const probes: Array<Promise<CheckResult>> = [
    checkQuota(key),
    checkAnthropic(endpoint, key.apiKey),
    ...servers.map((server) =>
      server.url !== undefined ? checkMcpHttp(server) : checkMcpStdio(server),
    ),
  ];
  return Promise.all(probes);
}

const GREEN = (text: string) => `\x1b[32m${text}\x1b[39m`;
const RED = (text: string) => `\x1b[31m${text}\x1b[39m`;

export function renderChecks(results: CheckResult[], color: boolean): string {
  const mark = (ok: boolean): string => (color ? (ok ? GREEN("✓") : RED("✗")) : ok ? "✓" : "✗");
  return `${results.map((r) => `${mark(r.ok)} ${r.label}: ${r.detail}`).join("\n")}\n`;
}
