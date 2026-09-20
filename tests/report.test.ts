import { describe, expect, test } from "bun:test";
import { fetchQuota, QuotaError, type QuotaInfo } from "../src/quota";
import { formatDuration, type KeyReport, percentBar, renderHuman, renderJson } from "../src/report";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

const SAMPLE_BODY = {
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
        nextResetTime: 60_000,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 140000,
        currentValue: 41746,
        remaining: 98253,
        percentage: 29,
        nextResetTime: 120_000,
      },
    ],
    level: "max",
  },
};

describe("fetchQuota", () => {
  test("parses the observed coding-plan response", async () => {
    const quota = await fetchQuota("k", {
      baseUrl: "http://test",
      fetchImpl: async () => jsonResponse(SAMPLE_BODY),
    });

    expect(quota.level).toBe("max");
    expect(quota.windows).toHaveLength(2);
    expect(quota.windows[0]).toMatchObject({
      kind: "credits",
      window: "5h",
      limit: 28000,
      used: 1665,
      remaining: 26334,
      usedPercent: 5,
      resetAt: 60_000,
    });
    expect(quota.windows[1]).toMatchObject({ kind: "credits", window: "weekly", usedPercent: 29 });
  });

  test("maps the legacy TOKENS_LIMIT type and unknown units", async () => {
    const body = {
      code: 200,
      success: true,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 4, number: 2, usage: 100, currentValue: 10, remaining: 90 },
        ],
      },
    };
    const quota = await fetchQuota("k", {
      baseUrl: "http://test",
      fetchImpl: async () => jsonResponse(body),
    });
    expect(quota.windows[0]?.kind).toBe("tokens");
    expect(quota.windows[0]?.window).toBe("unit4x2");
    // percentage missing → computed from used/limit
    expect(quota.windows[0]?.usedPercent).toBeCloseTo(10, 5);
    expect(quota.windows[0]?.resetAt).toBeUndefined();
  });

  test("rejects server-side errors with status and message", async () => {
    const body = { code: 429, msg: "rate limited", success: false };
    await expect(
      fetchQuota("k", {
        baseUrl: "http://test",
        fetchImpl: async () => jsonResponse(body, { status: 200 }),
      }),
    ).rejects.toThrow(/429.*rate limited|rate limited.*429/s);
  });

  test("rejects HTTP errors with non-JSON bodies", async () => {
    await expect(
      fetchQuota("k", {
        baseUrl: "http://test",
        fetchImpl: async () => new Response("boom", { status: 502 }),
      }),
    ).rejects.toThrow(QuotaError);
    await expect(
      fetchQuota("k", {
        baseUrl: "http://test",
        fetchImpl: async () => new Response("boom", { status: 502 }),
      }),
    ).rejects.toThrow("HTTP 502");
  });

  test("surfaces network failures", async () => {
    await expect(
      fetchQuota("k", {
        baseUrl: "http://test",
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toThrow("could not reach http://test");
  });

  test("rejects malformed limit entries", async () => {
    const body = {
      code: 200,
      success: true,
      data: { limits: [{ type: "CREDIT_LIMIT" }] },
    };
    await expect(
      fetchQuota("k", { baseUrl: "http://test", fetchImpl: async () => jsonResponse(body) }),
    ).rejects.toThrow(QuotaError);
  });

  test("sends type query and org/project headers for team context", async () => {
    const seen: Array<{
      url: string;
      auth: string | null;
      org: string | null;
      project: string | null;
    }> = [];
    const quota = await fetchQuota("k", {
      baseUrl: "http://test",
      type: 2,
      org: "org-123",
      project: "proj_456",
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          auth: headers.get("Authorization"),
          org: headers.get("bigmodel-organization"),
          project: headers.get("bigmodel-project"),
        });
        return jsonResponse(SAMPLE_BODY);
      },
    });
    expect(quota.windows).toHaveLength(2);
    expect(seen[0]?.url).toBe("http://test/api/monitor/usage/quota/limit?type=2");
    expect(seen[0]?.auth).toBe("k");
    expect(seen[0]?.org).toBe("org-123");
    expect(seen[0]?.project).toBe("proj_456");
  });

  test("empty data hints at the org-based context fix", async () => {
    const body = { code: 200, msg: "操作成功", data: {}, success: true };
    await expect(
      fetchQuota("k", { baseUrl: "http://test", fetchImpl: async () => jsonResponse(body) }),
    ).rejects.toThrow(/org-based.*list-tokens set/s);
  });

  test("parses team-plan percent-only windows and the monthly tool quota", async () => {
    const body = {
      code: 200,
      msg: "操作成功",
      success: true,
      data: {
        level: "pro",
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 3 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 11, nextResetTime: 60_000 },
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            usage: 1000,
            currentValue: 40,
            remaining: 960,
            percentage: 4,
            nextResetTime: 120_000,
            usageDetails: [{ modelCode: "zread", usage: 40 }],
          },
        ],
      },
    };
    const quota = await fetchQuota("k", {
      baseUrl: "http://test",
      fetchImpl: async () => jsonResponse(body),
    });

    expect(quota.level).toBe("pro");
    expect(quota.windows.map((w) => w.window)).toEqual(["5h", "weekly", "monthly"]);
    expect(quota.windows[0]).toMatchObject({ kind: "tokens", usedPercent: 3 });
    expect(quota.windows[0]?.limit).toBeUndefined();
    expect(quota.windows[0]?.resetAt).toBeUndefined();
    expect(quota.windows[1]).toMatchObject({ kind: "tokens", usedPercent: 11, resetAt: 60_000 });
    expect(quota.windows[2]).toMatchObject({
      kind: "time",
      limit: 1000,
      used: 40,
      remaining: 960,
      usedPercent: 4,
      resetAt: 120_000,
    });
  });
});

describe("formatDuration", () => {
  test("renders common ranges", () => {
    expect(formatDuration(-1)).toBe("now");
    expect(formatDuration(59_999)).toBe("now");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(9_060_000)).toBe("2h31m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(392_400_000)).toBe("4d13h");
    expect(formatDuration(345_600_000)).toBe("4d");
  });
});

describe("percentBar", () => {
  test("clamps and fills proportionally", () => {
    expect(percentBar(0)).toBe("░".repeat(20));
    expect(percentBar(5)).toBe("█".repeat(1) + "░".repeat(19));
    expect(percentBar(29)).toBe("█".repeat(6) + "░".repeat(14));
    expect(percentBar(100)).toBe("█".repeat(20));
    expect(percentBar(120)).toBe("█".repeat(20));
    expect(percentBar(-5)).toBe("░".repeat(20));
  });
});

describe("renderHuman", () => {
  test("renders aligned windows, bars, and reset countdowns", async () => {
    const quota = await fetchQuota("k", {
      baseUrl: "http://test",
      fetchImpl: async () => jsonResponse(SAMPLE_BODY),
    });
    const reports: KeyReport[] = [
      { name: "work", apiKey: "id-123.secret-456", quota },
      { name: "bad", apiKey: "bad.key", error: "HTTP 401: invalid key" },
    ];
    const text = renderHuman(reports, { now: 0, color: false });

    expect(text).toContain("work  (plan: max)  id-123.secret-456");
    expect(text).toContain("bad  bad.key");
    expect(text).toMatch(/5h\s+1,665 \/ +28,000\s+credits/);
    expect(text).toMatch(/weekly\s+41,746 \/ +140,000\s+credits/);
    expect(text).toContain("5%  [█░░░░░░░░░░░░░░░░░░░]");
    expect(text).toContain("29%  [██████░░░░░░░░░░░░░░]");
    expect(text).toContain("resets in 1m");
    expect(text).toContain("resets in 2m");
    expect(text).toContain("bad");
    expect(text).toContain("error: HTTP 401: invalid key");
  });

  test("renders percent-only windows with blank number columns", () => {
    const quota: QuotaInfo = {
      level: "pro",
      windows: [
        { kind: "tokens", window: "5h", usedPercent: 3 },
        { kind: "tokens", window: "weekly", usedPercent: 11, resetAt: 60_000 },
        {
          kind: "time",
          window: "monthly",
          limit: 1000,
          used: 40,
          remaining: 960,
          usedPercent: 4,
          resetAt: 120_000,
        },
      ],
    };
    const text = renderHuman([{ name: "team", apiKey: "k", quota }], { now: 0, color: false });

    expect(text).toContain("team  (plan: pro)");
    expect(text).toMatch(/5h\s+tokens\s+3%/);
    expect(text).toMatch(/weekly\s+tokens\s+11%/);
    expect(text).toMatch(/monthly\s+40 \/ +1,000\s+time/);
    expect(text).toContain("960 left");
    expect(text).toContain("resets n/a");
    expect(text).toContain("resets in 1m");
    expect(text).toContain("resets in 2m");
  });

  test("colors the bar by remaining quota", () => {
    const quota = (usedPercent: number): QuotaInfo => ({
      level: "max",
      windows: [
        {
          kind: "credits",
          window: "5h",
          limit: 100,
          used: usedPercent,
          remaining: 100 - usedPercent,
          usedPercent,
        },
      ],
    });
    const render = (usedPercent: number): string =>
      renderHuman([{ name: "k", apiKey: "key", quota: quota(usedPercent) }], {
        now: 0,
        color: true,
      });

    // More than half left → green, 20–50% left → yellow, under 20% → red.
    expect(render(30)).toContain("\x1b[32m 30%");
    expect(render(60)).toContain("\x1b[33m 60%");
    expect(render(90)).toContain("\x1b[31m 90%");
  });
});

describe("renderJson", () => {
  test("emits quota and error entries", () => {
    const text = renderJson([{ name: "bad", error: "nope" }]);
    const parsed = JSON.parse(text) as { keys: Array<{ name: string; error: string }> };
    expect(parsed.keys[0]).toEqual({ name: "bad", error: "nope" });
  });
});
