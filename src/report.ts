/**
 * Rendering of quota reports: an aligned human-readable table (colors when on
 * a TTY) or machine-readable JSON. Pure functions — no I/O.
 */

import type { QuotaInfo } from "./quota";

export interface KeyReport {
  name: string;
  apiKey?: string;
  /** True when Claude Code's settings currently authenticate with this key. */
  inUse?: boolean;
  quota?: QuotaInfo;
  error?: string;
}

/** What Claude Code currently authenticates with, for the list output. */
export interface ClaudeUsage {
  /** Name of the stored key in use, or null when it is not in the store. */
  using: string | null;
  /** Masked ANTHROPIC_AUTH_TOKEN when it matches no stored key. */
  unrecognized?: string;
}

export interface RenderOptions {
  /** Epoch milliseconds treated as "now"; used for reset countdowns. */
  now: number;
  color: boolean;
}

interface Style {
  bold(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const PLAIN: Style = {
  bold: (text) => text,
  red: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  cyan: (text) => text,
};

const ANSI: Style = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  red: (text) => `\x1b[31m${text}\x1b[39m`,
  green: (text) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text) => `\x1b[33m${text}\x1b[39m`,
  cyan: (text) => `\x1b[36m${text}\x1b[39m`,
};

/**
 * Duration until a reset, e.g. formatDuration(2h31m in ms) → "2h31m".
 * Anything under a minute (or already past) renders as "now".
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** Bar of used percent, e.g. percentBar(29) → "██████░░░░░░░░░░░░░░" (20 segments, 5% each). */
export function percentBar(usedPercent: number, width = 20): string {
  const ratio = Math.min(100, Math.max(0, usedPercent)) / 100;
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

interface WindowRow {
  label: string;
  kind: string;
  used: string;
  limit: string;
  left: string;
  pct: number | null;
  reset: string;
}

interface Block {
  header: string;
  error?: string;
  rows: WindowRow[];
}

export function renderHuman(reports: KeyReport[], options: RenderOptions): string {
  if (reports.length === 0) return "";
  const style = options.color ? ANSI : PLAIN;

  const blocks: Block[] = reports.map((report) => {
    const plan = report.quota?.level !== undefined ? `  (plan: ${report.quota.level})` : "";
    const keyText = report.apiKey !== undefined ? `  ${report.apiKey}` : "";
    const inUse = report.inUse === true ? `  ${style.cyan("← claude code")}` : "";
    const header = `${style.bold(report.name)}${plan}${keyText}${inUse}`;
    if (report.error) {
      return { header, error: report.error, rows: [] };
    }
    const rows: WindowRow[] = (report.quota?.windows ?? []).map((window) => ({
      label: window.window,
      kind: window.kind,
      used: window.used !== undefined ? formatCount(window.used) : "",
      limit: window.limit !== undefined ? formatCount(window.limit) : "",
      left: window.remaining !== undefined ? formatCount(window.remaining) : "",
      pct: window.usedPercent !== undefined ? Math.round(window.usedPercent) : null,
      reset:
        window.resetAt === undefined
          ? "resets n/a"
          : formatDuration(window.resetAt - options.now) === "now"
            ? "resets now"
            : `resets in ${formatDuration(window.resetAt - options.now)}`,
    }));
    return { header, rows };
  });

  const windows = blocks.flatMap((block) => block.rows);
  const labelWidth = Math.max(6, ...windows.map((row) => row.label.length));
  const kindWidth = Math.max(...windows.map((row) => row.kind.length), 1);
  const usedWidth = Math.max(...windows.map((row) => row.used.length), 1);
  const limitWidth = Math.max(...windows.map((row) => row.limit.length), 1);
  const leftWidth = Math.max(...windows.map((row) => row.left.length), 1);
  const countsWidth = usedWidth + 3 + limitWidth;
  const leftSegWidth = leftWidth + 5;

  const blockTexts = blocks.map((block) => {
    const lines = [block.header];
    if (block.error) {
      lines.push(`  ${style.red(`error: ${block.error}`)}`);
    } else if (block.rows.length === 0) {
      lines.push("  no quota windows reported");
    } else {
      for (const row of block.rows) {
        // Percent-only windows (some plans) keep the column layout with blanks.
        const counts =
          row.limit !== ""
            ? `${row.used.padStart(usedWidth)} / ${row.limit.padStart(limitWidth)}`
            : " ".repeat(countsWidth);
        const leftSeg =
          row.left !== "" ? `${row.left.padStart(leftWidth)} left` : " ".repeat(leftSegWidth);
        const bar =
          row.pct !== null
            ? // Traffic light by how much of the window is left: green while
              // more than half remains, yellow as it tightens, red when nearly gone.
              (row.pct >= 80 ? style.red : row.pct >= 50 ? style.yellow : style.green)(
                `${String(row.pct).padStart(3)}%  [${percentBar(row.pct)}]`,
              )
            : ` --%  [${percentBar(0)}]`;
        lines.push(
          `  ${row.label.padEnd(labelWidth)}  ${counts}  ${row.kind.padEnd(kindWidth)}  ${leftSeg}  ${bar}  ${row.reset}`,
        );
      }
    }
    return lines.join("\n");
  });
  return `${blockTexts.join("\n\n")}\n`;
}

export function renderJson(reports: KeyReport[], claude?: ClaudeUsage): string {
  const keys = reports.map((report) =>
    report.quota
      ? {
          name: report.name,
          level: report.quota.level,
          windows: report.quota.windows,
          ...(report.inUse === true ? { inUse: true } : {}),
        }
      : {
          name: report.name,
          error: report.error ?? "unknown error",
          ...(report.inUse === true ? { inUse: true } : {}),
        },
  );
  return `${JSON.stringify({ keys, claudeCode: claude ?? { using: null } }, null, 2)}\n`;
}
