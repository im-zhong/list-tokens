/**
 * Switching Claude Code to a stored key: finds GLM API keys by their shape
 * (32 lowercase hex chars, dot, 16 alphanumeric chars) inside Claude config
 * files and replaces them — covers `env.ANTHROPIC_AUTH_TOKEN` in settings.json
 * and per-server env blocks like `Z_AI_API_KEY` in ~/.claude.json, without
 * hard-coding field names. Every write is preceded by a backup and is atomic.
 */

import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shape of a Zhipu API key, e.g. "0123456789abcdef...ef.0123456789abcdef". */
export const GLM_KEY_SOURCE = "[0-9a-f]{32}\\.[A-Za-z0-9]{16}";

export const CLAUDE_CONFIGS_ENV_VAR = "LIST_TOKENS_CLAUDE_CONFIGS";

export interface KeyReplacement {
  /** Dotted path of the replaced value inside the JSON document. */
  field: string;
  /** Masked old value, e.g. "394ce79c…mKomt7". */
  maskedOld: string;
}

export interface ClaudeFilePlan {
  file: string;
  /** Replacement plans; empty when the file contains no keys. */
  replacements: KeyReplacement[];
  /** Parsed document with replacements applied; undefined when unusable. */
  next?: unknown;
  /** Set when the file exists but could not be used. */
  problem?: string;
}

export function claudeConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[CLAUDE_CONFIGS_ENV_VAR];
  if (override && override.trim() !== "") {
    return override
      .split(/[:\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  const home = homedir();
  return [
    join(home, ".claude.json"),
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
  ];
}

export function maskKey(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** One MCP server entry from a Claude config file, reduced to the fields we use. */
export interface McpServerConfig {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeTargets {
  /** Merged `env` objects from settings-style files (ANTHROPIC_* values). */
  env: Record<string, string>;
  servers: McpServerConfig[];
}

/** Does this server entry carry the given API key anywhere (env or headers)? */
export function serverCarriesKey(server: McpServerConfig, apiKey: string): boolean {
  return JSON.stringify(server).includes(apiKey);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/**
 * Read every config file and collect the merged env plus all MCP server
 * entries. Missing or broken files contribute nothing.
 */
export async function gatherClaudeTargets(files: string[]): Promise<ClaudeTargets> {
  const env: Record<string, string> = {};
  const servers: McpServerConfig[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (isRecord(parsed.env)) Object.assign(env, stringRecord(parsed.env));
    const mcp = parsed.mcpServers;
    if (isRecord(mcp)) {
      for (const [name, entry] of Object.entries(mcp)) {
        if (!isRecord(entry)) continue;
        const args = Array.isArray(entry.args)
          ? entry.args.filter((item): item is string => typeof item === "string")
          : undefined;
        servers.push({
          name,
          ...(typeof entry.url === "string" ? { url: entry.url } : {}),
          ...(isRecord(entry.headers) ? { headers: stringRecord(entry.headers) } : {}),
          ...(typeof entry.command === "string" ? { command: entry.command } : {}),
          ...(args !== undefined ? { args } : {}),
          ...(isRecord(entry.env) ? { env: stringRecord(entry.env) } : {}),
        });
      }
    }
  }
  return { env, servers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(cause: unknown): boolean {
  return isRecord(cause) && cause.code === "ENOENT";
}

function replaceInNode(
  node: unknown,
  newKey: string,
  field: string,
  replacements: KeyReplacement[],
): unknown {
  if (typeof node === "string") {
    const pattern = new RegExp(GLM_KEY_SOURCE);
    if (!pattern.test(node)) return node;
    replacements.push({ field, maskedOld: maskKey(node) });
    return node.replace(new RegExp(GLM_KEY_SOURCE, "g"), newKey);
  }
  if (Array.isArray(node)) {
    return node.map((item, index) =>
      replaceInNode(item, newKey, `${field}[${index}]`, replacements),
    );
  }
  if (isRecord(node)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = replaceInNode(value, newKey, `${field}.${key}`, replacements);
    }
    return result;
  }
  return node;
}

/**
 * Read each config file and plan the key replacement. Missing files are
 * skipped; files that exist but are not valid JSON get a `problem` and are
 * never written.
 */
export async function planKeySwap(files: string[], newKey: string): Promise<ClaudeFilePlan[]> {
  const plans: ClaudeFilePlan[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (cause) {
      if (isMissingFile(cause)) continue;
      plans.push({
        file,
        replacements: [],
        problem: `cannot read: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      plans.push({
        file,
        replacements: [],
        problem: `not valid JSON (${cause instanceof Error ? cause.message : String(cause)}) — skipped`,
      });
      continue;
    }
    const replacements: KeyReplacement[] = [];
    const next = replaceInNode(parsed, newKey, "", replacements);
    plans.push({ file, replacements, next });
  }
  return plans;
}

/**
 * Write a planned document: copy the original to `<file>.list-tokens.bak`,
 * then atomically replace the file (temp file + rename in the same directory).
 */
export async function applyKeySwap(plan: ClaudeFilePlan): Promise<void> {
  await copyFile(plan.file, `${plan.file}.list-tokens.bak`);
  const tmp = `${plan.file}.list-tokens-tmp`;
  await writeFile(tmp, `${JSON.stringify(plan.next, null, 2)}\n`);
  await rename(tmp, plan.file);
}
