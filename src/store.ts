/**
 * Persistence for named API keys in a single JSON file (default
 * ~/.list-tokens.json, overridable with LIST_TOKENS_CONFIG). The file holds
 * secrets, so it is always written with mode 0600.
 */

import { chmodSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE_NAME = ".list-tokens.json";
export const CONFIG_ENV_VAR = "LIST_TOKENS_CONFIG";

export interface StoredKey {
  name: string;
  apiKey: string;
  /** Quota API plan index: 1 = legacy personal, 2 = org-based accounts. */
  type?: number;
  /** Team context sent as the bigmodel-organization header. */
  org?: string;
  /** Team context sent as the bigmodel-project header. */
  project?: string;
}

/** Optional quota-query context for a key; only meaningful for type 2 (org-based) accounts. */
export interface QueryContext {
  type?: number;
  org?: string;
  project?: string;
}

export interface StoreData {
  version: 1;
  keys: StoredKey[];
}

export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingFile(cause: unknown): boolean {
  return isRecord(cause) && cause.code === "ENOENT";
}

/** Path of the config file: $LIST_TOKENS_CONFIG when set, otherwise ~/.list-tokens.json. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_ENV_VAR];
  return override && override.trim() !== "" ? override : join(homedir(), CONFIG_FILE_NAME);
}

export function emptyStore(): StoreData {
  return { version: 1, keys: [] };
}

/**
 * Load the store; a missing or empty file yields an empty store. Throws
 * {@link StoreError} for unreadable files or malformed content.
 */
export async function loadStore(path: string): Promise<StoreData> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return emptyStore();
    throw new StoreError(`cannot read ${path}: ${errorMessage(cause)}`, { cause });
  }
  if (text.trim() === "") return emptyStore();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new StoreError(
      `${path} is not valid JSON: ${errorMessage(cause)}; fix or delete the file`,
      {
        cause,
      },
    );
  }
  if (!isRecord(parsed)) {
    throw new StoreError(`${path}: expected a JSON object`);
  }
  const version = parsed.version ?? 1;
  if (version !== 1) {
    throw new StoreError(
      `${path}: unsupported config version ${String(version)}; this tool reads version 1`,
    );
  }
  if (!Array.isArray(parsed.keys)) {
    throw new StoreError(`${path}: "keys" must be an array`);
  }

  const keys: StoredKey[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.keys) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.apiKey !== "string") {
      throw new StoreError(`${path}: each entry in "keys" needs string "name" and "apiKey"`);
    }
    const problem = validateEntry(raw.name, raw.apiKey);
    if (problem) throw new StoreError(`${path}: ${problem}`);
    if (seen.has(raw.name)) {
      throw new StoreError(`${path}: duplicate key name "${raw.name}"`);
    }
    seen.add(raw.name);
    keys.push({ name: raw.name, apiKey: raw.apiKey, ...parseContext(path, raw) });
  }
  return { version: 1, keys };
}

/** Validate and extract the optional org-based query context from a stored entry. */
function parseContext(path: string, raw: Record<string, unknown>): QueryContext {
  const context: QueryContext = {};
  if (raw.type !== undefined) {
    if (raw.type !== 1 && raw.type !== 2) {
      throw new StoreError(`${path}: "type" must be 1 (legacy personal) or 2 (org-based)`);
    }
    context.type = raw.type;
  }
  for (const field of ["org", "project"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new StoreError(`${path}: "${field}" must be a non-empty string`);
    }
    context[field] = value;
  }
  return context;
}

/** Write the store as pretty JSON with a trailing newline, enforcing mode 0600. */
export async function saveStore(path: string, data: StoreData): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600); // writeFile's mode only applies at creation; enforce on every save
  } catch (cause) {
    throw new StoreError(`cannot write ${path}: ${errorMessage(cause)}`, { cause });
  }
}

function validateEntry(name: string, apiKey: string): string | undefined {
  if (name.trim() === "") return "key name must not be empty";
  if (apiKey.trim() === "") return "API key must not be empty";
  if (/\s/.test(apiKey)) return "API key must not contain whitespace";
  return undefined;
}

export interface AddResult {
  data: StoreData;
  /** Name of an existing entry that already stores the same API key, if any. */
  duplicateOf?: string;
}

/** Add a key; rejects duplicate names, blank names, and whitespace keys. */
export function addKey(
  data: StoreData,
  name: string,
  apiKey: string,
  context: QueryContext = {},
): AddResult {
  const cleanName = name.trim();
  const cleanKey = apiKey.trim();
  const problem = validateEntry(cleanName, cleanKey);
  if (problem) throw new StoreError(problem);
  const cleanContext = applyContextRules(normalizeContext(context));

  if (data.keys.some((key) => key.name === cleanName)) {
    throw new StoreError(`a key named "${cleanName}" already exists; rename or remove it first`);
  }
  const duplicateOf = data.keys.find((key) => key.apiKey === cleanKey)?.name;
  return {
    data: {
      version: 1,
      keys: [...data.keys, { name: cleanName, apiKey: cleanKey, ...cleanContext }],
    },
    duplicateOf,
  };
}

/** Trim fields and validate the type value; cross-field rules run in {@link applyContextRules}. */
function normalizeContext(context: QueryContext): QueryContext {
  const clean: QueryContext = {};
  if (context.type !== undefined) {
    if (context.type !== 1 && context.type !== 2) {
      throw new StoreError('"type" must be 1 (legacy personal) or 2 (org-based)');
    }
    clean.type = context.type;
  }
  for (const field of ["org", "project"] as const) {
    const value = context[field];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") throw new StoreError(`"${field}" must not be empty`);
    clean[field] = trimmed;
  }
  return clean;
}

/** Enforce the cross-field rules on a complete context and return the canonical form. */
function applyContextRules(context: QueryContext): QueryContext {
  // Type 1 (personal) never carries org/project; setting type 1 drops them.
  const next: QueryContext = { ...context };
  if (next.type === 1) {
    delete next.org;
    delete next.project;
  }
  if ((next.org !== undefined || next.project !== undefined) && next.type !== 2) {
    throw new StoreError("org/project are only used with org-based accounts — also pass --type 2");
  }
  if ((next.org !== undefined) !== (next.project !== undefined)) {
    throw new StoreError("org and project must be set together");
  }
  return next;
}

export interface SetResult {
  data: StoreData;
  /** The query context in effect after the update. */
  context: QueryContext;
}

/**
 * Update a key's quota-query context: patch fields onto the existing context,
 * or pass `clearContext: true` to remove it. Rules apply to the merged result,
 * so `set --type 2` followed by `set --org … --project …` works.
 */
export function setContext(
  data: StoreData,
  name: string,
  patch: QueryContext,
  options: { clearContext?: boolean } = {},
): SetResult {
  const cleanName = name.trim();
  const target = data.keys.find((key) => key.name === cleanName);
  if (!target) {
    throw new StoreError(notFoundMessage(data, cleanName));
  }
  const current: QueryContext = {};
  if (target.type !== undefined) current.type = target.type;
  if (target.org !== undefined) current.org = target.org;
  if (target.project !== undefined) current.project = target.project;

  const next =
    options.clearContext === true
      ? {}
      : applyContextRules({ ...current, ...normalizeContext(patch) });

  const updated: StoredKey = { name: target.name, apiKey: target.apiKey, ...next };
  return {
    data: { version: 1, keys: data.keys.map((key) => (key === target ? updated : key)) },
    context: next,
  };
}

/** Remove a key by exact name. */
export function removeKey(data: StoreData, name: string): StoreData {
  const cleanName = name.trim();
  const remaining = data.keys.filter((key) => key.name !== cleanName);
  if (remaining.length === data.keys.length) {
    throw new StoreError(notFoundMessage(data, cleanName));
  }
  return { version: 1, keys: remaining };
}

/** Rename a key; the new name must not collide with an existing one. */
export function renameKey(data: StoreData, from: string, to: string): StoreData {
  const fromName = from.trim();
  const toName = to.trim();
  if (toName.trim() === "") throw new StoreError("key name must not be empty");
  const target = data.keys.find((key) => key.name === fromName);
  if (!target) {
    throw new StoreError(notFoundMessage(data, fromName));
  }
  if (data.keys.some((key) => key.name === toName && key !== target)) {
    throw new StoreError(`a key named "${toName}" already exists; pick another name`);
  }
  return {
    version: 1,
    // Spread the whole entry so the query context (type/org/project) survives.
    keys: data.keys.map((key) => (key === target ? { ...key, name: toName } : key)),
  };
}

function notFoundMessage(data: StoreData, name: string): string {
  const known = data.keys.map((key) => key.name);
  const hint =
    known.length === 0
      ? "no keys are configured yet"
      : `known keys: ${known.map((n) => `"${n}"`).join(", ")}`;
  return `no key named "${name}"; ${hint}`;
}
