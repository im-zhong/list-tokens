# list-tokens

Manage Zhipu GLM Coding Plan API keys and show their remaining quota.

```
work  (plan: max)  3f9c2a1b8e7d4f6c.9xYzWv
  5h       1,665 /  28,000 credits  26,334 left    5%  [█░░░░░░░░░░░░░░░░░░░]  resets in 2h31m
  weekly  41,746 /  140,000 credits  98,253 left   29%  [██████░░░░░░░░░░░░░░]  resets in 4d13h
```

Keys are stored in `~/.list-tokens.json` (mode `0600` — the file contains
secrets). Quotas are fetched in parallel from
`https://open.bigmodel.cn/api/monitor/usage/quota/limit`; a key that fails to
answer shows an `error:` line instead of failing the run.

On a color terminal the percentage bar is a traffic light by how much of the
window is left: green (>50% left), yellow (20–50%), red (<20%). Set `NO_COLOR`
to disable.

## Build

Requires [Bun](https://bun.sh):

```sh
bun install
bun run build        # produces dist/list-tokens (dist/list-tokens.exe on Windows)
```

The executable is standalone; copy it anywhere on your `PATH`.

## Usage

```sh
list-tokens add <name> <api-key>   # save a key under a name
list-tokens rename <from> <to>     # rename a stored key
list-tokens remove <name>          # remove a stored key (alias: rm)
list-tokens set <name> [--type 1|2] [--org <id>] [--project <id>]   # quota-query context
list-tokens list                   # show quota for every key (alias: ls)
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
