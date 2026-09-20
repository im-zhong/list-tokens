import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run against the compiled binary by setting LIST_TOKENS_BIN (see test:compiled).
const cli = process.env.LIST_TOKENS_BIN ?? "bun";
const cliPrefix = process.env.LIST_TOKENS_BIN ? [] : ["src/cli.ts"];

let tmpRoot = "";
let server: Bun.Server<undefined>;

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "list-tokens-test-"));
  // Local stand-in for open.bigmodel.cn, keyed on the Authorization header.
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const auth = request.headers.get("Authorization") ?? "";
      // The endpoint expects the raw key, not "Bearer <key>".
      if (auth.startsWith("Bearer ")) {
        return json({ code: 401, msg: "invalid auth scheme", success: false }, { status: 401 });
      }
      // Org-based team key (like newer team plans): plain queries are rejected,
      // ?type=2 without org/project headers returns empty data.
      if (auth === "org-team-key") {
        const url = new URL(request.url);
        if (url.searchParams.get("type") !== "2") {
          return json({ code: 500, msg: "当前用户不存在coding plan", success: false });
        }
        const org = request.headers.get("bigmodel-organization");
        const project = request.headers.get("bigmodel-project");
        if (org === "org-777" && project === "proj_888") {
          return json(teamBody());
        }
        return json({ code: 200, msg: "操作成功", data: {}, success: true });
      }
      switch (auth) {
        case "good-key":
          return json(successBody());
        case "flat-key":
          return json(flatBody());
        case "team-key":
          return json(teamBody());
        case "down-key":
          return new Response("upstream exploded", { status: 500 });
        default:
          return json({ code: 401, msg: "invalid api key", success: false }, { status: 401 });
      }
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function successBody() {
  return {
    code: 200,
    msg: "操作成功",
    success: true,
    data: {
      limits: [
        {
          type: "CREDIT_LIMIT",
          unit: 3,
          number: 5,
          usage: 28000,
          currentValue: 1665,
          remaining: 26334,
          percentage: 5,
          nextResetTime: Date.now() + 151 * 60_000,
        },
        {
          type: "CREDIT_LIMIT",
          unit: 6,
          number: 1,
          usage: 140000,
          currentValue: 41746,
          remaining: 98253,
          percentage: 29,
          nextResetTime: Date.now() + 6540 * 60_000,
        },
      ],
      level: "max",
    },
  };
}

// Older shape: no percentage, no nextResetTime.
function flatBody() {
  return {
    code: 200,
    success: true,
    data: {
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          usage: 5000,
          currentValue: 1000,
          remaining: 4000,
        },
      ],
    },
  };
}

// Team plan (level "pro"): percent-only token windows plus a monthly TIME_LIMIT.
function teamBody() {
  return {
    code: 200,
    msg: "操作成功",
    success: true,
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 0,
          nextResetTime: Date.now() + 240 * 60_000,
        },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 0,
          remaining: 1000,
          percentage: 0,
          nextResetTime: Date.now() + 16 * 24 * 60 * 60_000,
          usageDetails: [
            { modelCode: "search-prime", usage: 0 },
            { modelCode: "web-reader", usage: 0 },
          ],
        },
      ],
    },
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function newConfig(): string {
  return join(tmpRoot, `${crypto.randomUUID()}.json`);
}

// Async spawn so the in-process mock server stays responsive while the child
// fetches from it (spawnSync would block the event loop and deadlock).
async function run(
  args: string[],
  config = newConfig(),
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const proc = Bun.spawn([cli, ...cliPrefix, ...args], {
    env: {
      ...process.env,
      LIST_TOKENS_CONFIG: config,
      LIST_TOKENS_API_URL: `http://127.0.0.1:${server.port}`,
      NO_COLOR: "1",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode: exitCode ?? 1 };
}

describe("add / rename / remove", () => {
  test("add stores a key and reports duplicates", async () => {
    const config = newConfig();
    const added = await run(["add", "work", "good-key"], config);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('Added "work".');

    const dupName = await run(["add", "work", "other-key"], config);
    expect(dupName.exitCode).toBe(1);
    expect(dupName.stderr).toContain("already exists");

    const dupKey = await run(["add", "backup", "good-key"], config);
    expect(dupKey.exitCode).toBe(0);
    expect(dupKey.stdout).toContain('same API key as "work"');
  });

  test("add rejects empty names and whitespace keys", async () => {
    expect((await run(["add", "  ", "good-key"])).exitCode).toBe(1);
    expect((await run(["add", "x", "has space"])).exitCode).toBe(1);
  });

  test("config file is written with mode 0600", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);
    if (process.platform !== "win32") {
      expect(statSync(config).mode & 0o777).toBe(0o600);
    }
  });

  test("rename renames and rejects unknown targets", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    const renamed = await run(["rename", "work", "personal"], config);
    expect(renamed.exitCode).toBe(0);
    expect(renamed.stdout).toContain('Renamed "work" to "personal".');

    const listed = await run(["list"], config);
    expect(listed.stdout).toContain("personal");

    const missing = await run(["rename", "nope", "x"], config);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no key named "nope"');
  });

  test("rename keeps the quota-query context", async () => {
    const config = newConfig();
    await run(
      [
        "add",
        "org-team",
        "org-team-key",
        "--type",
        "2",
        "--org",
        "org-777",
        "--project",
        "proj_888",
      ],
      config,
    );
    await run(["rename", "org-team", "org-team-renamed"], config);

    const result = await run(["list"], config);
    expect(result.stdout).toContain("org-team-renamed  (plan: pro)");
  });

  test("remove deletes keys and rejects unknown names", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    const removed = await run(["rm", "work"], config);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain('Removed "work".');

    const missing = await run(["remove", "work"], config);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no key named "work"');
  });
});

describe("list", () => {
  test("default command prints human-readable quota", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    const result = await run([], config);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("work  (plan: max)  good-key");
    expect(result.stdout).toMatch(/5h\s+1,665 \/ +28,000\s+credits/);
    expect(result.stdout).toMatch(/weekly\s+41,746 \/ +140,000\s+credits/);
    expect(result.stdout).toContain("26,334");
    expect(result.stdout).toContain("98,253");
    expect(result.stdout).toMatch(/resets in 2h3[01]m/); // minute boundary between fixture and render
    expect(result.stdout).toMatch(/resets in \d+d/);
  });

  test("renders computed percentage and n/a reset for flat responses", async () => {
    const config = newConfig();
    await run(["add", "flat", "flat-key"], config);

    const result = await run(["list"], config);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/1,000 \/ +5,000\s+tokens/);
    expect(result.stdout).toContain("20%");
    expect(result.stdout).toContain("resets n/a");
  });

  test("renders team-plan keys with percent-only windows", async () => {
    const config = newConfig();
    await run(["add", "team", "team-key"], config);

    const result = await run(["list"], config);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("team  (plan: pro)");
    expect(result.stdout).toMatch(/5h\s+tokens\s+0%/);
    expect(result.stdout).toMatch(/weekly\s+tokens\s+0%/);
    expect(result.stdout).toMatch(/monthly\s+0 \/ +1,000\s+time/);
    expect(result.stdout).toMatch(/resets in \d+d/);
  });

  test("org-based team keys need set --type 2 --org --project before they answer", async () => {
    const config = newConfig();
    await run(["add", "org-team", "org-team-key"], config);

    // Plain query: rejected like the real API rejects org-based keys.
    const plain = await run(["list"], config);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toMatch(/error: .*不存在coding plan/);

    // type=2 without org/project: empty data with an actionable hint.
    await run(["set", "org-team", "--type", "2"], config);
    const empty = await run(["list"], config);
    expect(empty.stdout).toMatch(/error: .*org-based.*list-tokens set/s);

    // org/project can be patched on top of an existing type 2.
    const set = await run(["set", "org-team", "--org", "org-777", "--project", "proj_888"], config);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("type 2, org org-777, project proj_888");
    const listed = await run(["list"], config);
    expect(listed.stdout).toContain("org-team  (plan: pro)");

    // Clearing restores the plain (broken) query.
    const cleared = await run(["set", "org-team", "--clear-context"], config);
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout).toContain("query context cleared");
    const after = await run(["list"], config);
    expect(after.stdout).toMatch(/error: .*不存在coding plan/);
  });

  test("set rejects org/project without a team type", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    const orphan = await run(["set", "work", "--org", "org-777", "--project", "proj_888"], config);
    expect(orphan.exitCode).toBe(1);
    expect(orphan.stderr).toContain("--type 2");

    const half = await run(["set", "work", "--type", "2", "--org", "org-777"], config);
    expect(half.exitCode).toBe(1);
    expect(half.stderr).toContain("org and project must be set together");
  });

  test("add accepts team context flags directly", async () => {
    const config = newConfig();
    const added = await run(
      [
        "add",
        "org-team",
        "org-team-key",
        "--type",
        "2",
        "--org",
        "org-777",
        "--project",
        "proj_888",
      ],
      config,
    );
    expect(added.exitCode).toBe(0);
    const listed = await run(["list"], config);
    expect(listed.stdout).toContain("org-team  (plan: pro)");
  });

  test("set rejects unknown names and invalid types", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    const missing = await run(["set", "nope", "--type", "2"], config);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no key named "nope"');

    const badType = await run(["set", "work", "--type", "3"], config);
    expect(badType.exitCode).toBe(1);
    expect(badType.stderr).toContain("type must be 1 (legacy personal) or 2 (org-based)");
  });

  test("--json emits machine-readable output on both command forms", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    for (const args of [["--json"], ["list", "--json"]]) {
      const result = await run(args, config);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        keys: Array<{
          name: string;
          level?: string;
          windows?: Array<{ window: string; limit: number; used: number; remaining: number }>;
        }>;
      };
      const key = parsed.keys[0];
      expect(key?.name).toBe("work");
      expect(key?.level).toBe("max");
      expect(key?.windows?.[0]).toMatchObject({
        window: "5h",
        limit: 28000,
        used: 1665,
        remaining: 26334,
      });
    }
  });

  test("failed keys render an error line but keep exit code 0", async () => {
    const config = newConfig();
    await run(["add", "good", "good-key"], config);
    await run(["add", "bad", "not-a-key"], config);
    await run(["add", "down", "down-key"], config);

    const result = await run(["list"], config);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(plan: max)");
    expect(result.stdout).toContain("bad");
    expect(result.stdout).toMatch(/error: .*401/);
    expect(result.stdout).toMatch(/error: .*500/);
  });

  test("network failures render an error line", async () => {
    const config = newConfig();
    await run(["add", "work", "good-key"], config);

    const result = await run(["list"], config, { LIST_TOKENS_API_URL: "http://127.0.0.1:9" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("could not reach");
  });

  test("suggests adding a key when the store is empty", async () => {
    const result = await run(["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No API keys configured yet");
    expect(result.stdout).toContain("list-tokens add <name> <api-key>");
  });
});

describe("store errors and CLI plumbing", () => {
  test("corrupt config files fail with a fix hint", async () => {
    const config = newConfig();
    writeFileSync(config, "not json");

    const result = await run(["list"], config);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
    expect(result.stderr).toContain("fix or delete the file");
  });

  test("missing required arguments and unknown commands fail on stderr", async () => {
    const missingArg = await run(["add", "only-name"]);
    expect(missingArg.exitCode).toBe(1);
    expect(missingArg.stderr).toContain("missing required argument");

    const unknown = await run(["frobnicate"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('unknown command "frobnicate"');
  });

  test("help goes to stdout with exit code 0", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("rename");
  });
});
