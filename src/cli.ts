#!/usr/bin/env bun
/**
 * list-tokens: manage Zhipu GLM Coding Plan API keys and show remaining quota.
 *
 * Keys live in ~/.list-tokens.json (override with LIST_TOKENS_CONFIG). Listing
 * is best-effort: a key whose quota cannot be fetched shows an error line
 * instead of failing the whole run.
 */

import { Command, InvalidArgumentError } from "commander";
import { fetchQuota } from "./quota";
import { type KeyReport, renderHuman, renderJson } from "./report";
import {
  addKey,
  configPath,
  loadStore,
  type QueryContext,
  removeKey,
  renameKey,
  type StoredKey,
  saveStore,
  setContext,
} from "./store";

const TOOL = "list-tokens";
// Keep in sync with package.json version.
const VERSION = "0.1.0";

/** Commander parser for --type: quota index 1 (legacy personal) or 2 (org-based). */
function parseType(value: string): number {
  if (value !== "1" && value !== "2") {
    throw new InvalidArgumentError("type must be 1 (legacy personal) or 2 (org-based)");
  }
  return Number(value);
}

const program = new Command()
  .name(TOOL)
  .description("Manage Zhipu GLM Coding Plan API keys and show their remaining quota.")
  .version(VERSION)
  .allowExcessArguments() // unmatched operands are reported by the default action below
  .option("--json", "print machine-readable JSON instead of a table");

function contextFromOptions(options: {
  type?: number;
  org?: string;
  project?: string;
}): QueryContext {
  const context: QueryContext = {};
  if (options.type !== undefined) context.type = options.type;
  if (options.org !== undefined) context.org = options.org;
  if (options.project !== undefined) context.project = options.project;
  return context;
}

program
  .command("add")
  .description("Save an API key under a name, e.g. add work <apiKey>")
  .arguments("<name> <apiKey>")
  .option("--type <plan>", "quota index: 1 legacy personal, 2 org-based", parseType)
  .option("--org <id>", "organization id, e.g. org-xxxx (requires --type 2)")
  .option("--project <id>", "project id, e.g. proj_xxxx (requires --type 2)")
  .action(
    async (
      name: string,
      apiKey: string,
      options: { type?: number; org?: string; project?: string },
    ) => {
      const path = configPath();
      const { data, duplicateOf } = addKey(
        await loadStore(path),
        name,
        apiKey,
        contextFromOptions(options),
      );
      await saveStore(path, data);
      const finalName = name.trim();
      console.log(
        duplicateOf
          ? `Added "${finalName}" (same API key as "${duplicateOf}").`
          : `Added "${finalName}".`,
      );
    },
  );

program
  .command("rename")
  .description("Rename a stored key")
  .arguments("<from> <to>")
  .action(async (from: string, to: string) => {
    const path = configPath();
    const data = renameKey(await loadStore(path), from, to);
    await saveStore(path, data);
    console.log(`Renamed "${from.trim()}" to "${to.trim()}".`);
  });

program
  .command("remove")
  .alias("rm")
  .description("Remove a stored key")
  .arguments("<name>")
  .action(async (name: string) => {
    const path = configPath();
    const data = removeKey(await loadStore(path), name);
    await saveStore(path, data);
    console.log(`Removed "${name.trim()}".`);
  });

program
  .command("set")
  .description("Update a key's quota-query context (org-based accounts need type/org/project)")
  .arguments("<name>")
  .option("--type <plan>", "quota index: 1 legacy personal, 2 org-based", parseType)
  .option("--org <id>", "organization id, e.g. org-xxxx (requires --type 2)")
  .option("--project <id>", "project id, e.g. proj_xxxx (requires --type 2)")
  .option("--clear-context", "remove type/org/project from the key")
  .action(
    async (
      name: string,
      options: { type?: number; org?: string; project?: string; clearContext?: boolean },
    ) => {
      const path = configPath();
      const { data, context } = setContext(
        await loadStore(path),
        name,
        contextFromOptions(options),
        {
          clearContext: options.clearContext === true,
        },
      );
      await saveStore(path, data);
      const summary =
        context.type === undefined && context.org === undefined
          ? "query context cleared"
          : [
              context.type !== undefined ? `type ${context.type}` : undefined,
              context.org !== undefined ? `org ${context.org}` : undefined,
              context.project !== undefined ? `project ${context.project}` : undefined,
            ]
              .filter(Boolean)
              .join(", ");
      console.log(`Set "${name.trim()}": ${summary}.`);
    },
  );

program
  .command("list")
  .alias("ls")
  .description("Show quota for every stored key (default when no command is given)")
  .action(async () => {
    await runList(jsonRequested());
  });

// Bare `list-tokens` lists; any unmatched operand is an unknown command.
program.action(async (_options: unknown, command: Command) => {
  const args = command.args;
  if (args.length > 0) {
    throw new Error(`unknown command "${args[0]}" — try "${TOOL} --help"`);
  }
  await runList(jsonRequested());
});

// --json lives on the program: Commander hoists recognised program options out
// of subcommand arguments, so `list --json` lands here either way.
function jsonRequested(): boolean {
  return program.opts<{ json?: boolean }>().json === true;
}

async function runList(json: boolean): Promise<void> {
  const path = configPath();
  const data = await loadStore(path);
  if (data.keys.length === 0) {
    console.log(`No API keys configured yet. Add one with:\n  ${TOOL} add <name> <api-key>`);
    return;
  }
  const reports = await Promise.all(data.keys.map(reportForKey));
  const output = json
    ? renderJson(reports)
    : renderHuman(reports, { now: Date.now(), color: useColor() });
  process.stdout.write(output);
}

async function reportForKey(key: StoredKey): Promise<KeyReport> {
  try {
    return {
      name: key.name,
      apiKey: key.apiKey,
      quota: await fetchQuota(key.apiKey, {
        type: key.type,
        org: key.org,
        project: key.project,
      }),
    };
  } catch (cause) {
    return {
      name: key.name,
      apiKey: key.apiKey,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function useColor(): boolean {
  const noColor = process.env.NO_COLOR;
  return process.stdout.isTTY === true && !(noColor !== undefined && noColor !== "");
}

try {
  await program.parseAsync(process.argv);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${TOOL}: ${message}\n`);
  process.exitCode = 1;
}
