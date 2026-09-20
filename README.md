# list-tokens

Manage a pool of Zhipu GLM Coding Plan API keys: see every key's remaining
quota at a glance, and switch Claude Code (including its MCP servers) to any
of them with one command.

```
work  (plan: max)  3f9c2a1b8e7d4f6c.9xYzWv
  5h       1,665 /  28,000 credits  26,334 left    5%  [█░░░░░░░░░░░░░░░░░░░]  resets in 2h31m
  weekly  41,746 /  140,000 credits  98,253 left   29%  [██████░░░░░░░░░░░░░░]  resets in 4d13h
```

What it does:

- **Quota overview** — all keys queried in parallel from
  `https://open.bigmodel.cn/api/monitor/usage/quota/limit`, with 5h / weekly /
  monthly windows, reset countdowns, and a traffic-light bar (green >50% left,
  yellow 20–50%, red <20%). A failing key shows an `error:` line without
  failing the run; `--json` makes the whole thing scriptable for key-pool
  routing.
- **Every plan shape seen in the wild** — legacy personal plans (credits),
  team plans that only report percentages, and newer org-based accounts that
  need `?type=2` plus `bigmodel-organization`/`bigmodel-project` headers.
- **Switch Claude Code** — `use <name>` rewrites the GLM key inside
  `~/.claude/settings.json` (`ANTHROPIC_AUTH_TOKEN`) and every MCP server in
  `~/.claude.json` (env blocks and `Authorization` headers), with backups and
  atomic writes.
- **Verify after switching** — `check <name>` probes the quota API, the
  Anthropic-compatible chat endpoint with a real 1-token request, and MCP
  `initialize` handshakes for the servers carrying the key.

Keys are stored in a single file, `~/.list-tokens.json` (mode `0600` — the
file contains secrets). It is the only configuration this tool owns; `use`
additionally leaves `<file>.list-tokens.bak` backups of the Claude config
files it rewrites.

## Installation

Install the latest release to `~/.local/bin` (macOS arm64, Linux arm64,
Linux x86_64):

```sh
curl -fsSL https://raw.githubusercontent.com/im-zhong/list-tokens/main/install.sh | sh
```

Or pick a binary from the
[releases page](https://github.com/im-zhong/list-tokens/releases) yourself:

```sh
curl -fsSL -o ~/.local/bin/list-tokens \
  https://github.com/im-zhong/list-tokens/releases/latest/download/list-tokens-darwin-arm64
chmod +x ~/.local/bin/list-tokens
```

The binaries are standalone (Bun-compiled, no runtime needed). Building from
source requires [Bun](https://bun.sh):

```sh
bun install
bun run build        # produces dist/list-tokens
```

## Usage

```sh
list-tokens add <name> <api-key>   # save a key under a name
list-tokens rename <from> <to>     # rename a stored key
list-tokens remove <name>          # remove a stored key (alias: rm)
list-tokens set <name> [--type 1|2] [--org <id>] [--project <id>]   # quota-query context
list-tokens list                   # show quota for every key (alias: ls)
list-tokens use <name> [--dry-run] [--check] # switch Claude Code to a stored key
list-tokens check <name>           # verify a key end-to-end
list-tokens                        # bare invocation lists
list-tokens --json                 # machine-readable output
```

Example:

```sh
list-tokens add work xxxxxxxxxxxxxx.yyyy
list-tokens
```

JSON output shape:

```json
{
  "keys": [
    {
      "name": "work",
      "level": "max",
      "windows": [
        {
          "kind": "credits",
          "window": "5h",
          "limit": 28000,
          "used": 1665,
          "remaining": 26334,
          "usedPercent": 5,
          "resetAt": 1789928462473
        }
      ]
    },
    { "name": "bad", "error": "HTTP 401: invalid api key" }
  ]
}
```

`window` maps the server's unit enum: `5h` (unit 3), `weekly` (unit 6), and
`monthly` (unit 5) are the known windows; anything else renders as
`unit<U>x<N>`. `kind` is `credits` for `CREDIT_LIMIT`, `tokens` for
`TOKENS_LIMIT`, and `time` for `TIME_LIMIT` (a monthly tool quota on team
plans). Team plans (e.g. `level: "pro"`) report their token windows as
percentages only — those rows show `N%` without absolute counts.

## Environment

| Variable               | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `LIST_TOKENS_CONFIG`   | Path of the key store (default `~/.list-tokens.json`) |
| `LIST_TOKENS_API_URL`  | Base URL of the quota API (default `https://open.bigmodel.cn`) |
| `LIST_TOKENS_CLAUDE_CONFIGS` | Claude config files scanned by `use`/`check` (colon-separated) |
| `NO_COLOR`             | Disable colored output when set to a non-empty value |

## Org-based keys

Most keys answer a plain quota query. Keys on Zhipu's newer org-based account
system — personal or team plans alike (the API replies `当前用户不存在coding
plan` or returns empty `data`) — additionally need their plan index and
organization context, which the web console sends as `?type=2` plus
`bigmodel-organization`/`bigmodel-project` headers. Get the values once from
the browser: open `bigmodel.cn/coding-plan/`, DevTools → Network → the
`quota/limit` request, and copy the two request headers. Then:

```sh
list-tokens set <name> --type 2 --org org-xxxx --project proj_xxxx
```

`set` patches fields (`--type 2` first, then `--org/--project` works too),
`--type 1` drops org/project, and `--clear-context` removes everything.

## Switching Claude Code

`list-tokens use <name>` rewrites the GLM API key used by Claude Code. It
scans `~/.claude.json` (MCP server env blocks such as `Z_AI_API_KEY`),
`~/.claude/settings.json`, and `~/.claude/settings.local.json`
(`env.ANTHROPIC_AUTH_TOKEN`), replacing every string that looks like a GLM key
(`32 hex chars . 16 alphanumeric chars`) with the selected key — field names
don't matter, so new MCP servers are covered automatically. URLs and other
values are never touched.

Before writing, each modified file is backed up to `<file>.list-tokens.bak`
and the write itself is atomic (temp file + rename). Use `--dry-run` to
preview. Restart Claude Code afterwards — the running process keeps its old
credentials. Override the scanned files with `LIST_TOKENS_CLAUDE_CONFIGS`
(colon-separated paths).

## Verifying a switch

`list-tokens check <name>` (or `use --check`) probes, all in parallel:

- the quota API for the key,
- the Anthropic-compatible chat endpoint Claude Code uses, with a real
  1-token request against the cheapest configured model (base URL and model
  come from `settings.json`; skipped when no `ANTHROPIC_BASE_URL` is set),
- an MCP `initialize` handshake (HTTP or stdio) for every configured server
  that carries this key — servers without it are simply not probed.

```
✓ quota: max · 5h 0%, weekly 0%
✓ anthropic endpoint (glm-5.3-flash): 1797ms
✓ mcp zai-mcp-server: 510ms
```

The exit code is nonzero when any probe fails.

## Caveats

The quota endpoint is undocumented (it is what Zhipu's own coding-plan usage
plugin calls) and the response field names are misleading: `usage` is the
window's ceiling, `currentValue` is what has been consumed, and `percentage`
is percent **used**. Treat the endpoint as best-effort — this tool never lets
a quota failure block key management.

## Development

```sh
bun run check    # lint + typecheck + tests against source and compiled binary
bun run format   # apply Biome fixes
```

Tests run the CLI as a subprocess against an in-process mock of the quota API;
no network access is required.
