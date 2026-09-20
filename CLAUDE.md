# Engineering Guidelines

This file is the single source of truth; `CLAUDE.md` symlinks to it. Edit only this file.
This project is a TypeScript CLI using Bun and Commander.js, distributed as standalone executables through GitHub Releases.

## Project Workflow

- Use `bun install`, `bun run`, and `bun test`. Define Commander commands in `src/cli.ts` and CLI behavior tests in `tests/cli.test.ts`, including invalid input.
- `bun run build` creates `dist/list-tokens` (`dist/list-tokens.exe` on Windows); `bun run test:compiled` tests that executable.
- `bun run check` runs Biome CI, TypeScript, source tests, compilation, and the same tests against the binary. Keep CI and release checks aligned.
- Pre-commit runs all checks in parallel without editing or staging source files. Run it manually with `bunx lefthook run pre-commit --force`.

## Stack Practices and Documentation

- Before changing library APIs, tooling configuration, or dependencies, read the Context7 skill when available and use it to check documentation for the versions in `package.json` and `bun.lock`. If unavailable, use official versioned docs and local types; do not guess APIs or claim a lookup you did not perform.
- Read applicable installed skills before using their workflows. Keep lookups focused on the task; record significant compatibility constraints in code or project docs.
- TypeScript: preserve strict checks and use type-only imports where appropriate. Keep runtime validation separate from static types; compiling with Bun does not replace `tsc`.
- Bun: prefer built-in runtime and test APIs when they meet the need. Verify standalone-executable compatibility, including file paths and assets; do not assume the user's working directory is the repository.
- Commander: use its argument, option, validation, and help APIs rather than duplicating parsing. Use `parseAsync` when adding async actions and handle failures at the CLI boundary.
- Biome and Lefthook: keep formatting and lint rules in `biome.json`, reuse package scripts in hooks and CI, and keep automatic fixes explicit.
- Dependencies: check runtime support and maintenance before adding one. Put shipped libraries in `dependencies`, development tools in `devDependencies`, and update manifests and lockfiles together.

## Design and Interfaces

- Prefer deep modules: small, stable interfaces that hide complex implementations. Split by responsibility and invariants, not line count.
- Expose capabilities, not internal steps. Define inputs, outputs, errors, and side effects; avoid accumulating boolean switches.
- Keep the CLI layer focused on arguments, invocation, and presentation. Keep business logic independent of Commander, terminals, and process exits.
- Validate external data at boundaries; use types to represent valid internal states. Make defaults explicit and preserve error causes and context.
- Implement current needs directly. Abstract around real variation, not hypothetical requirements; add dependencies only when justified.

## Code and Comments

- Use strict TypeScript. Narrow external `unknown` values; avoid `any`, non-null assertions, and type assertions that hide errors.
- Name things by intent and keep control flow clear. Isolate side effects, release resources promptly, and remove dead code; never swallow errors.
- Keep comments concise: explain purpose, why, constraints, or tradeoffs. Do not narrate code line by line; update comments when behavior changes.
- Document public or non-obvious functions with brief TSDoc contracts, including errors and side effects when relevant. Prefer illustrative input → output examples.
- Use examples to clarify tricky semantics: `normalizeName("  Ada  ") → "Ada"`, or empty input throws. Do not add comments to obvious functions merely for completeness.

## CLI Conventions

- Preserve command, option, and exit-code compatibility. Send successful output and requested help to stdout, diagnostics to stderr; return nonzero on failure.
- Errors should identify the problem and a practical remedy. Never log secrets or sensitive input.
- Keep defaults predictable. Require explicit selection of destructive operations; never wait for input in non-interactive environments.

## Testing and Verification

- Test observable behavior and contracts, not private implementation details. Prioritize normal, boundary, failure, and regression cases.
- Assert stdout, stderr, and exit codes in CLI integration tests. Run the same suite against source and compiled executables.
- Keep tests deterministic, independent, and fast. Isolate filesystem effects in temporary directories; rep[118;1:3ulace network, time, and similar dependencies only at external boundaries.
- Run `bun run check` after code or configuration changes. For documentation-only changes, review content, links, and diffs. Report actual verification and remaining gaps.

## Tooling and Delivery

- Use the Bun version pinned in `package.json`. Commit `bun.lock`; use `bun install --frozen-lockfile` in CI.
- Use Biome for formatting, linting, and import organization; do not add ESLint/Prettier. `bun run format` applies fixes.
- Pre-commit checks are read-only and may run in parallel; never rewrite or stage files automatically. CI must run checks independently of local hooks.
- Keep changes focused and reviewable. Commit messages explain motivation and behavior changes; update usage docs, and exclude secrets and build artifacts.
- Release tags must match `package.json.version`. Validate artifacts on matching platforms before publishing together; grant release permissions only to the publishing job.
- Validate new executables before replacing installed versions. Preserve the working installation on failure and keep previous releases available for rollback.
