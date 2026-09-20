/**
 * Quota API client for Zhipu GLM Coding Plan keys.
 *
 * GET {base}/api/monitor/usage/quota/limit with the raw API key in the
 * Authorization header (no "Bearer" prefix). The endpoint is undocumented but
 * is what Zhipu's own coding-plan usage plugin calls, so treat it as
 * best-effort: a failure here must never block other work.
 *
 * Field names in the response are misleading: "usage" is the window's ceiling,
 * "currentValue" is what has been consumed, and "percentage" is percent used.
 */

export const DEFAULT_API_BASE_URL = "https://open.bigmodel.cn";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface QuotaWindow {
  /** What is counted: "credits" (CREDIT_LIMIT), "tokens" (TOKENS_LIMIT), "time" (TIME_LIMIT). */
  kind: string;
  /** Window label: "5h", "weekly", "monthly", or `unit${unit}x${number}` for unknown units. */
  window: string;
  /** Ceiling for the window (server field "usage"); plans on org-based accounts may report percent-only windows without it. */
  limit?: number;
  /** Consumed amount (server field "currentValue"). */
  used?: number;
  remaining?: number;
  /** Percent of the ceiling already used (server "percentage", computed when absent and possible). */
  usedPercent?: number;
  /** Epoch milliseconds when the window resets, if reported. */
  resetAt?: number;
}

export interface QuotaInfo {
  /** Plan tier, e.g. "max". */
  level?: string;
  windows: QuotaWindow[];
}

export class QuotaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QuotaError";
  }
}

/** Narrow fetch signature so tests can stub it (Bun's `typeof fetch` adds `preconnect`). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchQuotaOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Plan index appended as ?type=N: 1 legacy personal, 2 org-based accounts. */
  type?: number;
  /** Org context sent as the bigmodel-organization header (type 2 only). */
  org?: string;
  /** Org context sent as the bigmodel-project header (type 2 only). */
  project?: string;
  /** Injectable fetch implementation for tests. */
  fetchImpl?: FetchLike;
}

const KIND_BY_TYPE: Record<string, string> = {
  CREDIT_LIMIT: "credits",
  TOKENS_LIMIT: "tokens",
  TIME_LIMIT: "time",
};

/**
 * Map the server's unit enum to a human window label.
 * Observed values: unit 3 counts hours, unit 6 counts weeks, and unit 5 counts
 * months (inferred from ~30-day reset distances on team plans).
 */
export function windowLabel(unit: number, span: number): string {
  if (unit === 6) return span === 1 ? "weekly" : `${span}w`;
  if (unit === 5) return span === 1 ? "monthly" : `${span}mo`;
  if (unit === 3) return `${span}h`;
  return `unit${unit}x${span}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QuotaError(`unexpected response: field "${key}" is not a finite number`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new QuotaError(`unexpected response: field "${key}" is not a string`);
  }
  return value;
}

/** Rank windows so "5h" prints before "weekly" before "monthly" before anything unknown. */
function windowRank(window: QuotaWindow): number {
  if (window.window === "5h") return 0;
  if (window.window === "weekly") return 1;
  if (window.window === "monthly") return 2;
  return 3;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(raw: unknown): QuotaWindow {
  if (!isRecord(raw)) {
    throw new QuotaError("unexpected response: limit entry is not an object");
  }
  const type = requireString(raw, "type");
  const unit = requireNumber(raw, "unit");
  const span = requireNumber(raw, "number");
  // Legacy personal plans send every count; org-based accounts may send percentage-only windows.
  const limit = optionalNumber(raw, "usage");
  const used = optionalNumber(raw, "currentValue");
  const remaining = optionalNumber(raw, "remaining");
  const percentage = optionalNumber(raw, "percentage");
  const resetAt = optionalNumber(raw, "nextResetTime");
  const usedPercent =
    percentage ??
    (limit !== undefined && used !== undefined && limit > 0 ? (used / limit) * 100 : undefined);

  const window: QuotaWindow = {
    kind: KIND_BY_TYPE[type] ?? type,
    window: windowLabel(unit, span),
  };
  if (limit !== undefined) window.limit = limit;
  if (used !== undefined) window.used = used;
  if (remaining !== undefined) window.remaining = remaining;
  if (usedPercent !== undefined) window.usedPercent = usedPercent;
  if (resetAt !== undefined) window.resetAt = resetAt;
  return window;
}

function parseBody(body: unknown): QuotaInfo {
  if (!isRecord(body) || body.code !== 200) {
    const msg = isRecord(body) && typeof body.msg === "string" ? body.msg : undefined;
    const code = isRecord(body) && typeof body.code === "number" ? body.code : undefined;
    const detail = [msg, code !== undefined ? `code ${code}` : undefined]
      .filter(Boolean)
      .join(", ");
    throw new QuotaError(`API rejected the request${detail ? `: ${detail}` : ""}`);
  }
  const data = body.data;
  if (!isRecord(data)) {
    throw new QuotaError("unexpected response: data is missing");
  }
  if (!Array.isArray(data.limits)) {
    // The API answers 200 with empty data for org-based keys queried
    // without their organization/project context.
    throw new QuotaError(
      "quota response contained no limits — for org-based (type 2) keys, configure the query context with: list-tokens set <name> --type 2 --org <org> --project <project>",
    );
  }
  const level = typeof data.level === "string" ? data.level : undefined;
  const windows = [...data.limits.map(parseWindow)].sort((a, b) => windowRank(a) - windowRank(b));
  const info: QuotaInfo = { windows };
  if (level !== undefined) {
    info.level = level;
  }
  return info;
}

/** Fetch the coding-plan quota for one API key. Throws {@link QuotaError} on failure. */
export async function fetchQuota(
  apiKey: string,
  options: FetchQuotaOptions = {},
): Promise<QuotaInfo> {
  const baseUrl = (
    options.baseUrl ??
    process.env.LIST_TOKENS_API_URL ??
    DEFAULT_API_BASE_URL
  ).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${baseUrl}/api/monitor/usage/quota/limit${
    options.type !== undefined ? `?type=${options.type}` : ""
  }`;
  const headers: Record<string, string> = {
    Authorization: apiKey, // raw key — the endpoint rejects "Bearer <key>"
    "Content-Type": "application/json",
    "Accept-Language": "en-US,en",
  };
  if (options.org !== undefined) headers["bigmodel-organization"] = options.org;
  if (options.project !== undefined) headers["bigmodel-project"] = options.project;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new QuotaError(`could not reach ${baseUrl}: ${errorMessage(cause)}`, { cause });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new QuotaError(`HTTP ${response.status}: response is not valid JSON`, { cause });
  }
  if (!response.ok) {
    const msg = isRecord(body) && typeof body.msg === "string" ? body.msg : undefined;
    throw new QuotaError(`HTTP ${response.status}${msg ? `: ${msg}` : ""}`);
  }
  return parseBody(body);
}
