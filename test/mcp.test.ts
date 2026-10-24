import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callSkeletonKeyTool,
  SKELETONKEY_TOOLS,
  SKELETONKEY_TOOL_NAMES,
  type McpContext,
  type McpToolResult,
} from "../src/mcp.js";
import { openLedger } from "../src/ledger.js";
import { readKeys } from "../src/keys.js";
import { REPO_ROOT, initWithKey, makeHome, removeHome } from "./helpers/env.js";

/** A fake key with enough shape to be recognisable if it ever leaked. */
const SECRET = "sk-test-FAKE-mcp-leak-canary-0xDEADBEEF";
const ALIAS = "voyage-personal";
const DOMAIN = "api.voyageai.com";
const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");

/** Arguments good enough to exercise every tool's happy-ish path. */
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  find_api: { capability: "embeddings" },
  list_keys: {},
  key_status: { alias: ALIAS },
  request_access: { platform: "Voyage AI", reason: "embed a corpus", est_budget: 5 },
  register_key: { alias: "new-key", platform: "Apify", domain: "api.apify.com" },
  ledger: { alias: ALIAS, limit: 50 },
  disable: { alias: ALIAS, reason: "test" },
};

function text(result: McpToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

describe("skeletonkey MCP server", () => {
  let home: string;
  let ctx: McpContext;

  beforeEach(async () => {
    home = makeHome();
    // `allowTtyPrompt: false` keeps register_key from reaching for /dev/tty,
    // which must never be the path by which a secret reaches the agent anyway.
    ctx = { home, apisFile: APIS_YAML, allowTtyPrompt: false };
    await initWithKey(home, { alias: ALIAS, secret: SECRET, domain: DOMAIN });

    // One ledger row so the spend/ledger tools have something to report.
    const ledger = openLedger(home);
    ledger.record({ alias: ALIAS, domain: DOMAIN, status: 200, bytes: 128, cost: 0.0012 });
    ledger.record({ alias: ALIAS, domain: DOMAIN, status: 200, bytes: 64, cost: null });
    ledger.close();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("covers every registered tool in this test's argument table", () => {
    expect(Object.keys(TOOL_ARGS).sort()).toEqual([...SKELETONKEY_TOOL_NAMES].sort());
    expect(SKELETONKEY_TOOL_NAMES).toEqual([
      "find_api",
      "list_keys",
      "key_status",
      "request_access",
      "register_key",
      "ledger",
      "disable",
    ]);
  });

  it("never returns the stored secret from ANY tool", async () => {
    // Sanity check: the secret really is in the vault, so a leak would be possible.
    const vaultFile = fs.readFileSync(path.join(home, "dev-vault.json"), "utf8");
    expect(vaultFile).toContain(SECRET);

    const seen: string[] = [];
    for (const tool of SKELETONKEY_TOOLS) {
      const args = TOOL_ARGS[tool.name] ?? {};
      const result = await callSkeletonKeyTool(tool.name, args, ctx);
      const body = text(result);
      seen.push(tool.name);

      expect(body, `${tool.name} returned the secret`).not.toContain(SECRET);
      // Also reject a recognisable prefix, in case something truncated it.
      expect(body, `${tool.name} returned a secret fragment`).not.toContain("sk-test-FAKE");
      expect(body, `${tool.name} mentioned the canary`).not.toContain("DEADBEEF");
      // And the raw object, not just the rendered text.
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    expect(seen.sort()).toEqual([...SKELETONKEY_TOOL_NAMES].sort());
  });

  it("never returns a secret when called with junk or missing arguments", async () => {
    const junk = [
      {},
      { alias: ALIAS },
      { alias: "../../etc/passwd", capability: "*", platform: "*", domain: "*" },
      { alias: ALIAS, limit: -1, est_budget: -5 },
    ];
    for (const tool of SKELETONKEY_TOOLS) {
      for (const args of junk) {
        const result = await callSkeletonKeyTool(tool.name, args, ctx);
        expect(JSON.stringify(result), `${tool.name} ${JSON.stringify(args)}`).not.toContain(
          SECRET,
        );
      }
    }
  });

  it("find_api matches by capability and reports which keys exist", async () => {
    const result = await callSkeletonKeyTool("find_api", { capability: "embeddings" }, ctx);
    const parsed = JSON.parse(text(result)) as {
      match_count: number;
      matches: { name: string; min_topup_usd: number | null; key_in_skeletonkey: unknown }[];
    };
    expect(parsed.match_count).toBeGreaterThan(0);
    const voyage = parsed.matches.find((match) => match.name.includes("voyage"));
    expect(voyage).toBeDefined();
    // Prices are never invented.
    for (const match of parsed.matches) expect(match.min_topup_usd).toBeNull();
    expect(voyage?.key_in_skeletonkey).toEqual({ alias: ALIAS, disabled: false });
  });

  it("find_api returns an empty match list rather than guessing", async () => {
    const result = await callSkeletonKeyTool(
      "find_api",
      { capability: "zzz-nonexistent-capability" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as { match_count: number; matches: unknown[] };
    expect(parsed.match_count).toBe(0);
    expect(parsed.matches).toEqual([]);
  });

  it("list_keys returns metadata and the header template, not a filled-in header", async () => {
    const result = await callSkeletonKeyTool("list_keys", {}, ctx);
    const parsed = JSON.parse(text(result)) as {
      count: number;
      keys: { alias: string; header_format: string; domain: string }[];
    };
    expect(parsed.count).toBe(1);
    expect(parsed.keys[0]?.alias).toBe(ALIAS);
    expect(parsed.keys[0]?.domain).toBe(DOMAIN);
    // The placeholder is still a placeholder.
    expect(parsed.keys[0]?.header_format).toBe("Bearer {key}");
  });

  it("key_status reports ledger spend and flags unknown cost honestly", async () => {
    const result = await callSkeletonKeyTool("key_status", { alias: ALIAS }, ctx);
    const parsed = JSON.parse(text(result)) as {
      found: boolean;
      usable: boolean;
      spend: { calls: number; cost_usd: number | null; calls_without_reported_cost: number; note: string };
      recent_calls: { cost_usd: number | null }[];
    };
    expect(parsed.found).toBe(true);
    expect(parsed.usable).toBe(true);
    expect(parsed.spend.calls).toBe(2);
    expect(parsed.spend.cost_usd).toBeCloseTo(0.0012);
    expect(parsed.spend.calls_without_reported_cost).toBe(1);
    expect(parsed.spend.note).toMatch(/reported no price/);
    expect(parsed.recent_calls).toHaveLength(2);
  });

  it("key_status on an unknown alias says so instead of throwing", async () => {
    const result = await callSkeletonKeyTool("key_status", { alias: "nope" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result)) as { found: boolean };
    expect(parsed.found).toBe(false);
  });

  it("request_access returns a proxy URL when a key exists", async () => {
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "ExampleCo", reason: "embed a corpus", est_budget: 5 },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      has_key: boolean;
      alias: string;
      proxy: { proxy_url: string; usage: string };
      call_example: string;
      signup_plan: unknown;
    };
    expect(parsed.has_key).toBe(true);
    expect(parsed.alias).toBe(ALIAS);
    expect(parsed.proxy.proxy_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsed.call_example).toContain(DOMAIN);
    expect(parsed.signup_plan).toBeNull();
  });

  it("request_access returns a signup plan ending in human confirmation", async () => {
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "example-apify-scraping", reason: "scrape a site", est_budget: 10 },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      has_key: boolean;
      signup_plan: {
        steps: { step: number; actor: string; skeletonkey_automates: boolean; action: string }[];
        final_step: string;
        cautions: string[];
      };
    };
    expect(parsed.has_key).toBe(false);
    expect(parsed.signup_plan.final_step).toContain("human confirms");
    expect(parsed.signup_plan.steps.length).toBeGreaterThanOrEqual(5);
    // Payment and key entry are the human's job.
    const humanSteps = parsed.signup_plan.steps.filter((step) => step.actor === "human");
    expect(humanSteps.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(parsed.signup_plan)).toMatch(/card/i);
    expect(parsed.signup_plan.cautions.join()).toMatch(/never paste a key/i);
  });

  it("request_access points at the human when the key is disabled", async () => {
    await callSkeletonKeyTool("disable", { alias: ALIAS, reason: "test" }, ctx);
    const result = await callSkeletonKeyTool("request_access", { platform: "ExampleCo" }, ctx);
    const parsed = JSON.parse(text(result)) as { has_key: boolean; disabled?: boolean; hint?: string };
    expect(parsed.has_key).toBe(false);
    expect(parsed.disabled).toBe(true);
    expect(parsed.hint).toContain("skeletonkey enable");
  });

  it("register_key asks the human out of band and stores nothing itself", async () => {
    const result = await callSkeletonKeyTool(
      "register_key",
      { alias: "apify-personal", platform: "Apify", domain: "api.apify.com" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      stored: boolean;
      action_required: string;
      command_for_human: string;
    };
    expect(parsed.stored).toBe(false);
    expect(parsed.action_required).toBe("human");
    expect(parsed.command_for_human).toContain("skeletonkey add apify-personal");
    expect(parsed.command_for_human).toContain("api.apify.com");
    // Nothing was written behind the human's back.
    expect(readKeys(home).keys.map((key) => key.alias)).toEqual([ALIAS]);
  });

  it("register_key validates its inputs before involving anyone", async () => {
    const bad = await callSkeletonKeyTool(
      "register_key",
      { alias: "bad alias!", platform: "X", domain: "api.x.test" },
      ctx,
    );
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("Alias must start with");

    const badFormat = await callSkeletonKeyTool(
      "register_key",
      { alias: "ok", platform: "X", domain: "api.x.test", format: "Bearer oops" },
      ctx,
    );
    expect(badFormat.isError).toBe(true);
    expect(text(badFormat)).toContain("{key}");
  });

  it("ledger reports rows and a spend summary", async () => {
    const result = await callSkeletonKeyTool("ledger", { limit: 10 }, ctx);
    const parsed = JSON.parse(text(result)) as {
      rows: { alias: string; cost_usd: number | null }[];
      summary: { calls: number; cost_usd: number | null; note: string };
    };
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.summary.calls).toBe(2);
    expect(parsed.summary.cost_usd).toBeCloseTo(0.0012);
    expect(parsed.summary.note).toContain("$");
  });

  it("disable flips the flag and leaves the secret in the vault", async () => {
    const result = await callSkeletonKeyTool("disable", { alias: ALIAS, reason: "rotating" }, ctx);
    const parsed = JSON.parse(text(result)) as { disabled: boolean; reason: string; note: string };
    expect(parsed.disabled).toBe(true);
    expect(parsed.reason).toBe("rotating");
    expect(parsed.note).toContain("skeletonkey enable");
    expect(readKeys(home).keys[0]?.disabled).toBe(true);

    const vault = JSON.parse(fs.readFileSync(path.join(home, "dev-vault.json"), "utf8")) as {
      secrets: Record<string, string>;
    };
    expect(vault.secrets[ALIAS]).toBe(SECRET);
  });

  it("surfaces an unknown alias as a tool error, not a crash", async () => {
    const result = await callSkeletonKeyTool("disable", { alias: "ghost" }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Unknown alias");
  });

  it("reports an unknown tool name as an error", async () => {
    const result = await callSkeletonKeyTool("exfiltrate_keys", {}, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unknown tool");
  });

  it("declares no tool that could return a secret", () => {
    for (const tool of SKELETONKEY_TOOLS) {
      const described = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
      expect(described).not.toMatch(/\b(get_secret|reveal|read_key|export_key)\b/);
    }
    // The only mutating tools are the two that need to be.
    const mutating = SKELETONKEY_TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name);
    expect(mutating.sort()).toEqual(["disable", "register_key"]);
  });
});
