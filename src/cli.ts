#!/usr/bin/env bun
/**
 * list-tokens: manage Zhipu GLM Coding Plan API keys and show remaining quota.
 *
 * Keys live in ~/.list-tokens.json (override with LIST_TOKENS_CONFIG). Listing
 * is best-effort: a key whose quota cannot be fetched shows an error line
 * instead of failing the whole run.
 */

import { Command, InvalidArgumentError } from "commander";
import { type ClaudeEndpoint, renderChecks, runChecks } from "./checks";
import {
  applyKeySwap,
  claudeConfigFiles,
  gatherClaudeTargets,
  maskKey,
  planKeySwap,
  serverCarriesKey,
} from "./claude";
import { fetchQuota } from "./quota";
import { type KeyReport, renderHuman, renderJson } from "./report";
import {
  addKey,
  configPath,
  loadStore,
  notFoundMessage,
  type QueryContext,
  removeKey,
  renameKey,
  type StoredKey,
  saveStore,
  setContext,
} from "./store";

const TOOL = "list-tokens";
// Keep in sync with package.json version.
const VERSION = "0.0.1";

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
  .command("use")
  .description("Point Claude Code (settings + MCP servers) at a stored key")
  .arguments("<name>")
  .option("--dry-run", "show what would change without writing")
  .option("--check", "verify the key against Claude Code and MCP servers after switching")
  .action(async (name: string, options: { dryRun?: boolean; check?: boolean }) => {
    const storePath = configPath();
    const data = await loadStore(storePath);
    const target = data.keys.find((key) => key.name === name.trim());
    if (!target) {
      throw new Error(notFoundMessage(data, name.trim()));
    }
    const files = claudeConfigFiles();
    const plans = await planKeySwap(files, target.apiKey);
    for (const plan of plans) {
      if (plan.problem) {
        process.stderr.write(`${TOOL}: ${plan.file}: ${plan.problem}\n`);
        continue;
      }
      for (const change of plan.replacements) {
        const field = change.field.replace(/^\./, "") || "(root)";
        console.log(`${plan.file}: ${field}  ${change.maskedOld} → ${maskKey(target.apiKey)}`);
      }
    }
    const total = plans.reduce((sum, plan) => sum + plan.replacements.length, 0);
    if (total === 0) {
      throw new Error(
        `no API keys found to replace in: ${plans.map((plan) => plan.file).join(", ")} (missing files are skipped)`,
      );
    }
    if (options.dryRun !== true) {
      for (const plan of plans) {
        if (plan.replacements.length > 0 && plan.next !== undefined) {
          await applyKeySwap(plan);
          console.log(`Backed up ${plan.file} → ${plan.file}.list-tokens.bak`);
        }
      }
      console.log(
        `Switched Claude Code to "${target.name}" (${total} replacement${total === 1 ? "" : "s"}). Restart Claude Code to pick it up.`,
      );
      if (options.check === true) {
        const ok = await runChecksFor(target.name);
        if (!ok) process.exitCode = 1;
      }
    } else {
      console.log(
        `Dry run — nothing written (would make ${total} replacement${total === 1 ? "" : "s"}).`,
      );
    }
  });

program
  .command("check")
  .description("Verify a stored key against the quota API, Claude Code's endpoint, and MCP servers")
  .arguments("<name>")
  .action(async (name: string) => {
    const ok = await runChecksFor(name);
    if (!ok) process.exitCode = 1;
  });

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

/** Probe the named key: quota API, the Anthropic-compatible endpoint from
 * settings.json, and every MCP server carrying this key. Returns false when
 * any probe failed (results are printed). */
async function runChecksFor(name: string): Promise<boolean> {
  const data = await loadStore(configPath());
  const target = data.keys.find((key) => key.name === name.trim());
  if (!target) {
    throw new Error(notFoundMessage(data, name.trim()));
  }
  const { env, servers } = await gatherClaudeTargets(claudeConfigFiles());
  const endpoint: ClaudeEndpoint = {
    baseUrl: env.ANTHROPIC_BASE_URL,
    model:
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
      env.ANTHROPIC_MODEL ??
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
  const matching = servers.filter((server) => serverCarriesKey(server, target.apiKey));
  const results = await runChecks(target, endpoint, matching);
  process.stdout.write(renderChecks(results, useColor()));
  return results.every((result) => result.ok);
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
