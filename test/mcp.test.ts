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
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");

/** Arguments good enough to exercise every tool's happy-ish path. */
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  find_api: { capability: "embeddings" },
  list_keys: {},
  key_status: { alias: ALIAS },
  request_access: { platform: "Voyage AI", reason: "embed a corpus", est_budget: 5 },
  register_key: { alias: "new-key", platform: "Apify", domain: "api.apify.com" },
  ledger: { alias: ALIAS, limit: 50 },
  disable: { alias: ALIAS, reason: "test" },
  discover_api: { capability: "CVE lookup", vendor: "NVD" },
  propose_entry: {
    name: "probe-vendor",
    url: "https://probe.test/docs",
    domain: "api.probe.test",
    access_mode: "own-account",
    source_urls: ["https://probe.test/docs"],
  },
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
    ctx = { home, apisFile: APIS_YAML, apiShardDirs: [SHARD_DIR], allowTtyPrompt: false };
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
      "discover_api",
      "propose_entry",
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

  it("find_api reaches the generated shards, not just apis.yaml", async () => {
    const result = await callSkeletonKeyTool("find_api", { capability: "technographics" }, ctx);
    const parsed = JSON.parse(text(result)) as {
      index_counts: { apis_yaml: number; shards: number; merged_duplicates: number };
      matches: { name: string; index_origin: string; index_category?: string }[];
    };
    expect(parsed.index_counts.shards).toBeGreaterThan(100);
    const shardRow = parsed.matches.find((match) => match.name === "builtwith");
    expect(shardRow).toBeDefined();
    expect(shardRow?.index_origin).toBe("shard");
    expect(shardRow?.index_category).toBe("people-company-data");
  });

  it("find_api finds Apollo, and prefers the apis.yaml row over the shard", async () => {
    const result = await callSkeletonKeyTool("find_api", { capability: "Apollo" }, ctx);
    const parsed = JSON.parse(text(result)) as {
      match_count: number;
      matches: {
        name: string;
        index_origin: string;
        auth: { auth_header: string | null; auth_format: string | null; base_url: string | null };
      }[];
    };
    expect(parsed.match_count).toBeGreaterThan(0);
    const apollo = parsed.matches.find((match) => match.name === "example-apollo-contacts");
    expect(apollo).toBeDefined();
    expect(apollo?.index_origin).toBe("apis.yaml");
    // The whole point: the agent is told x-api-key instead of guessing Bearer.
    expect(apollo?.auth.auth_header).toBe("x-api-key");
    expect(apollo?.auth.auth_format).toBe("{key}");
    expect(apollo?.auth.base_url).toBe("https://api.apollo.io/api/v1");
    // The shard's own `apollo` row is merged away, not shown twice.
    expect(parsed.matches.filter((match) => match.name === "apollo")).toEqual([]);
  });

  it("find_api says a shard row's auth header is unknown rather than Bearer", async () => {
    const result = await callSkeletonKeyTool("find_api", { capability: "builtwith" }, ctx);
    const parsed = JSON.parse(text(result)) as {
      matches: { name: string; domain: string | null; auth: { auth_header: string | null; note: string | null } }[];
    };
    const row = parsed.matches.find((match) => match.name === "builtwith");
    expect(row?.auth.auth_header).toBeNull();
    expect(row?.domain).toBeNull();
    expect(row?.auth.note).toMatch(/null means nobody checked/i);
  });

  it("find_api caps what it returns but reports the true total", async () => {
    // "data" on its own is a generic word now, so ask for something a lot of
    // rows really do offer.
    const all = await callSkeletonKeyTool(
      "find_api",
      { capability: "company enrichment", limit: 200 },
      ctx,
    );
    const total = (JSON.parse(text(all)) as { match_count: number }).match_count;
    expect(total).toBeGreaterThan(3);

    const capped = await callSkeletonKeyTool(
      "find_api",
      { capability: "company enrichment", limit: 3 },
      ctx,
    );
    const parsed = JSON.parse(text(capped)) as {
      match_count: number;
      returned: number;
      truncated?: string;
      matches: { index_origin: string }[];
    };
    expect(parsed.match_count).toBe(total);
    expect(parsed.returned).toBe(3);
    expect(parsed.truncated).toContain("of " + String(total));
    // The best-scoring row comes first, and on a tie apis.yaml order holds, so
    // the hand-written facts survive the cap.
    expect(parsed.matches[0]?.index_origin).toBe("apis.yaml");
  });

  it("find_api says which words it searched on and which it ignored", async () => {
    const result = await callSkeletonKeyTool(
      "find_api",
      { capability: "any data api for web scraping" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      search_terms: string[];
      ignored_terms: string[];
      matches: { name: string; match_score: number; matched_terms: string[] }[];
    };
    expect(parsed.search_terms).toEqual(["web", "scrap"]);
    expect(parsed.ignored_terms).toEqual(["any", "data", "api", "for"]);
    const apify = parsed.matches.find((match) => match.name === "example-apify-scraping");
    expect(apify?.matched_terms).toEqual(["web", "scrap"]);
    expect(apify?.match_score).toBeGreaterThan(0);
  });

  it("find_api refuses to answer a query made only of generic words", async () => {
    const result = await callSkeletonKeyTool("find_api", { capability: "any data api" }, ctx);
    const parsed = JSON.parse(text(result)) as {
      match_count: number;
      search_terms: string[];
      no_search_terms?: string;
    };
    expect(parsed.match_count).toBe(0);
    expect(parsed.search_terms).toEqual([]);
    expect(parsed.no_search_terms).toMatch(/generic/);
  });

  it("find_api does not match a word inside another word", async () => {
    // "zzz-vendor-not-in-any-index" used to return 41 rows: `any` is inside
    // `company`, and `index` is inside plenty of prose.
    const result = await callSkeletonKeyTool(
      "find_api",
      { capability: "zzz-vendor-not-in-any-index", limit: 200 },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as { match_count: number; matches: unknown[] };
    expect(parsed.match_count).toBe(0);
    expect(parsed.matches).toEqual([]);

    const cve = await callSkeletonKeyTool("find_api", { capability: "CVE lookup" }, ctx);
    expect((JSON.parse(text(cve)) as { match_count: number }).match_count).toBe(0);
  });

  it("find_api can be pointed at apis.yaml alone", async () => {
    const result = await callSkeletonKeyTool(
      "find_api",
      { capability: "technographics" },
      { ...ctx, apiShardDirs: [] },
    );
    const parsed = JSON.parse(text(result)) as {
      index_counts: { shards: number };
      match_count: number;
    };
    expect(parsed.index_counts.shards).toBe(0);
    expect(parsed.match_count).toBe(0);
  });

  it("request_access hands back the vendor's auth facts and ready-made register_key args", async () => {
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "example-apollo-contacts", reason: "enrich 50 contacts" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      has_key: boolean;
      auth: { auth_header: string; auth_format: string; signup_url: string; key_page_url: string | null };
      register_key_args: {
        domain: string;
        header: string;
        format: string;
        header_source: string;
        note: string;
      };
    };
    expect(parsed.has_key).toBe(false);
    expect(parsed.auth.auth_header).toBe("x-api-key");
    expect(parsed.auth.auth_format).toBe("{key}");
    expect(parsed.auth.signup_url).toBe("https://app.apollo.io/#/signup");
    expect(parsed.auth.key_page_url).toBeNull();
    expect(parsed.register_key_args.domain).toBe("api.apollo.io");
    expect(parsed.register_key_args.header).toBe("x-api-key");
    expect(parsed.register_key_args.format).toBe("{key}");
    expect(parsed.register_key_args.header_source).toBe("api-index");
  });

  it("request_access defaults loudly when no auth header is recorded", async () => {
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "zzzqqq-unlisted-vendor" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      apis_yaml_entry: unknown;
      auth: { auth_header: string | null; note: string | null };
      register_key_args: { header: string; format: string; header_source: string; note: string };
      signup_plan: { cautions: string[] };
    };
    expect(parsed.apis_yaml_entry).toBeNull();
    expect(parsed.auth.auth_header).toBeNull();
    expect(parsed.register_key_args.header).toBe("Authorization");
    expect(parsed.register_key_args.format).toBe("Bearer {key}");
    expect(parsed.register_key_args.header_source).toBe("skeletonkey-default");
    expect(parsed.register_key_args.note).toMatch(/not this vendor's documented header/);
    expect(parsed.signup_plan.cautions.join("\n")).toMatch(/not in the API index/);
  });

  it("request_access lists the human gates explicitly, with their source", async () => {
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "example-x-twitter-api", reason: "recent search" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      signup_plan: {
        human_gates: { gate: string; why: string; source: string }[];
        steps: { step: number; actor: string; action: string }[];
      };
    };
    const gates = parsed.signup_plan.human_gates;
    expect(gates.length).toBeGreaterThanOrEqual(5);
    const joined = gates.map((gate) => gate.gate).join("\n");
    // X records requires_card: true, so the card gate is stated as a fact.
    expect(joined).toMatch(/payment card/i);
    expect(gates.find((gate) => /payment card/i.test(gate.gate))?.source).toBe("apis.yaml");
    expect(joined).toMatch(/Terms-of-Service/);
    expect(joined).toMatch(/Typing the key into the vault/);
    // Captcha was never probed for any vendor: it is reported as unknown, not absent.
    const captcha = gates.find((gate) => /captcha/i.test(gate.gate));
    expect(captcha?.source).toBe("unknown");
    // human_steps from the index become gates too.
    expect(joined).toMatch(/developer console/i);
    expect(gates.every((gate) => gate.why.length > 0)).toBe(true);
    expect(["apis.yaml", "skeletonkey-policy", "unknown"]).toContain(gates[0]?.source);
  });

  it("request_access gives an email-verification step the agent runs on its own inbox", async () => {
    // DropLeads, not Voyage: this home already holds a key for api.voyageai.com,
    // so Voyage would return a proxy URL instead of a plan.
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "example-dropleads-contacts" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      signup_plan: {
        steps: { step: number; action: string; actor: string; capability?: string }[];
        email_verification: {
          mailbox: string | null;
          address_to_use: string;
          alias_allowed: boolean;
          how: string;
          note: string | null;
        };
      };
    };
    const verify = parsed.signup_plan.steps.find((step) => step.capability === "inbox");
    expect(verify).toBeDefined();
    expect(verify?.actor).toBe("agent");
    expect(verify?.action).toMatch(/verification code or confirmation link/i);
    expect(verify?.action).toMatch(/own inbox|OWN inbox/);

    const email = parsed.signup_plan.email_verification;
    expect(email.mailbox).toBe("dev@example.test");
    expect(email.alias_allowed).toBe(true);
    expect(email.address_to_use).toContain("+exampledropleadscontacts@");
    expect(email.how).toMatch(/inbox/i);
    expect(email.note).toBeNull();
    // A browser step and an inbox step are both the agent's own capabilities.
    expect(parsed.signup_plan.steps.some((step) => step.capability === "browser")).toBe(true);
  });

  it("request_access refuses the +alias trick where a work email is required", async () => {
    const result = await callSkeletonKeyTool(
      "request_access",
      { platform: "example-apollo-contacts" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      signup_plan: {
        steps: { step: number; action: string; actor: string }[];
        human_gates: { gate: string; source: string }[];
        email_verification: { address_to_use: string; alias_allowed: boolean; note: string | null };
        cautions: string[];
      };
    };
    const email = parsed.signup_plan.email_verification;
    expect(email.alias_allowed).toBe(false);
    expect(email.address_to_use).toBe("dev@example.test");
    expect(email.address_to_use).not.toContain("+");
    expect(email.note).toMatch(/work email/i);
    // The signup step itself becomes the human's, and the gate says why.
    const signupStep = parsed.signup_plan.steps.find((step) => /Sign up as/.test(step.action));
    expect(signupStep?.actor).toBe("human");
    expect(signupStep?.action).toMatch(/Do NOT add a \+alias/);
    expect(
      parsed.signup_plan.human_gates.find((gate) => /work email/i.test(gate.gate))?.source,
    ).toBe("apis.yaml");
    expect(parsed.signup_plan.cautions.join("\n")).toMatch(/\+alias/);
  });

  it("register_key defaults its header from the index, not to Bearer", async () => {
    const apollo = await callSkeletonKeyTool(
      "register_key",
      { alias: "apollo-personal", platform: "Apollo", domain: "api.apollo.io" },
      ctx,
    );
    const parsedApollo = JSON.parse(text(apollo)) as {
      stored: boolean;
      injected_header: string;
      injected_format: string;
      header_source: string;
      command_for_human: string;
      header_warning?: string;
    };
    expect(parsedApollo.stored).toBe(false);
    expect(parsedApollo.injected_header).toBe("x-api-key");
    expect(parsedApollo.injected_format).toBe("{key}");
    expect(parsedApollo.header_source).toContain("api-index");
    expect(parsedApollo.command_for_human).toContain("--header x-api-key");
    expect(parsedApollo.header_warning).toBeUndefined();

    // A subdomain of a known base URL still resolves to the right header.
    const voyage = await callSkeletonKeyTool(
      "register_key",
      { alias: "voyage-2", platform: "Voyage AI", domain: "api.voyageai.com" },
      ctx,
    );
    const parsedVoyage = JSON.parse(text(voyage)) as { injected_header: string; header_source: string };
    expect(parsedVoyage.injected_header).toBe("Authorization");
    expect(parsedVoyage.header_source).toContain("api-index");
  });

  it("register_key falls back to Bearer for an unknown domain, and says so", async () => {
    const result = await callSkeletonKeyTool(
      "register_key",
      { alias: "mystery", platform: "Mystery", domain: "api.mystery-vendor.test" },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      injected_header: string;
      injected_format: string;
      header_source: string;
      header_warning: string;
    };
    expect(parsed.injected_header).toBe("Authorization");
    expect(parsed.injected_format).toBe("Bearer {key}");
    expect(parsed.header_source).toBe("skeletonkey-default");
    expect(parsed.header_warning).toMatch(/x-api-key/);
  });

  it("register_key still lets an explicit header argument win", async () => {
    const result = await callSkeletonKeyTool(
      "register_key",
      {
        alias: "apollo-odd",
        platform: "Apollo",
        domain: "api.apollo.io",
        header: "X-Custom-Key",
        format: "Token {key}",
      },
      ctx,
    );
    const parsed = JSON.parse(text(result)) as {
      injected_header: string;
      injected_format: string;
      header_source: string;
      format_source: string;
    };
    expect(parsed.injected_header).toBe("X-Custom-Key");
    expect(parsed.injected_format).toBe("Token {key}");
    expect(parsed.header_source).toBe("argument");
    expect(parsed.format_source).toBe("argument");
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
    // The only mutating tools are the three that need to be -- and the one
    // added in v0.2 writes index metadata, never a credential.
    const mutating = SKELETONKEY_TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name);
    expect(mutating.sort()).toEqual(["disable", "propose_entry", "register_key"]);
  });
});

// --- v0.2: billing, routing, and discover-on-miss --------------------------

describe("billing and routing in the tool responses", () => {
  let home: string;
  let ctx: McpContext;

  beforeEach(async () => {
    home = makeHome();
    ctx = {
      home,
      apisFile: APIS_YAML,
      apiShardDirs: [SHARD_DIR],
      userIndexFile: path.join(home, "discovered.yaml"),
      allowTtyPrompt: false,
    };
    await initWithKey(home, { alias: ALIAS, secret: SECRET, domain: DOMAIN });
  });
  afterEach(() => removeHome(home));

  const parse = async (tool: string, args: Record<string, unknown>): Promise<any> =>
    JSON.parse(text(await callSkeletonKeyTool(tool, args, ctx)));

  it("gives every find_api match a billing block and a {route, reason}", async () => {
    const parsed = await parse("find_api", { capability: "web scraping" });
    expect(parsed.matches.length).toBeGreaterThan(0);
    for (const match of parsed.matches) {
      expect(match.billing, match.name).toHaveProperty("model");
      expect(match.route, match.name).toHaveProperty("route");
      expect(typeof match.route.reason, match.name).toBe("string");
      expect(Array.isArray(match.aggregators), match.name).toBe(true);
    }
    const apify = parsed.matches.find((match: any) => match.name === "example-apify-scraping");
    expect(apify.billing.model).toBe("free_tier+subscription");
    expect(apify.billing.verified_url).toBe("https://apify.com/pricing");
    expect(apify.route.route).toBe("direct");
    expect(apify.aggregators.find((item: any) => item.name === "glasser").per_call_price_usd).toBe(0.001);
  });

  it("says `price unverified` for a shard row that verified nothing", async () => {
    const parsed = await parse("find_api", { capability: "technographics" });
    const shardRow = parsed.matches.find((match: any) => match.index_origin === "shard");
    expect(shardRow).toBeDefined();
    expect(shardRow.billing.model).toBeNull();
    expect(shardRow.billing.note).toMatch(/null means nobody checked, NOT free/);
    expect(shardRow.route.route).toBe("unknown");
    expect(shardRow.route.reason).toContain("price unverified");
    expect(shardRow.route.price_unverified).toBe(true);
  });

  it("warns in find_api's reminders about nulls and the discovery path", async () => {
    const parsed = await parse("find_api", { capability: "embeddings" });
    const reminders = parsed.reminders.join(" ");
    expect(reminders).toMatch(/billing\.model: null means nobody checked/);
    expect(reminders).toMatch(/price unverified/);
    expect(reminders).toMatch(/discover_api/);
  });

  it("routes Apollo through the cheapest verified aggregator in request_access", async () => {
    const parsed = await parse("request_access", {
      platform: "example-apollo-contacts",
      reason: "enrich 50 contacts",
    });
    expect(parsed.has_key).toBe(false);
    expect(parsed.routing.route).toBe("aggregator:monid");
    expect(parsed.routing.per_call_price_usd).toBe(0.026);
    expect(parsed.routing.price_verified_url).toMatch(/^https:\/\/api\.monid\.ai\//);
    expect(parsed.routing.billing_model).toBe("free_tier+subscription");
    // The dearer carrier, the direct subscription, and x402 all stay visible.
    const alternatives = parsed.routing.alternatives.map((option: any) => option.route);
    expect(alternatives).toContain("aggregator:glasser");
    expect(alternatives).toContain("direct");
  });

  it("routes to the proxy once a key exists, and still shows the billing facts", async () => {
    const parsed = await parse("request_access", { platform: "Voyage AI" });
    expect(parsed.has_key).toBe(true);
    expect(parsed.routing.route).toBe("direct");
    expect(parsed.routing.reason).toMatch(/already in the vault/);
    expect(parsed.billing.model).toBe("free_tier+payg");
  });

  it("tells an unindexed platform to discover rather than guess", async () => {
    const parsed = await parse("request_access", { platform: "zzz-no-such-vendor-anywhere" });
    expect(parsed.routing.route).toBe("unknown");
    expect(parsed.routing.reason).toContain("price unverified");
    expect(parsed.billing.model).toBeNull();
  });
});

describe("discover_api and propose_entry", () => {
  let home: string;
  let ctx: McpContext;
  let userIndex: string;

  beforeEach(async () => {
    home = makeHome();
    userIndex = path.join(home, "discovered.yaml");
    ctx = {
      home,
      apisFile: APIS_YAML,
      apiShardDirs: [SHARD_DIR],
      userIndexFile: userIndex,
      allowTtyPrompt: false,
    };
    await initWithKey(home, { alias: ALIAS, secret: SECRET, domain: DOMAIN });
  });
  afterEach(() => removeHome(home));

  const parse = async (tool: string, args: Record<string, unknown>): Promise<any> =>
    JSON.parse(text(await callSkeletonKeyTool(tool, args, ctx)));

  const DISCOVERY = {
    name: "demo-cve-api",
    url: "https://vendor.test/docs",
    domain: "api.vendor.test",
    access_mode: "own-account",
    capabilities: ["cve lookup", "vulnerability data"],
    auth_header: "apiKey",
    auth_format: "{key}",
    base_url: "https://api.vendor.test/v1",
    signup_url: "https://vendor.test/request-a-key",
    billing: {
      model: "free",
      free_tier_note: "no paid tier at all; a key only raises the rate limit",
      verified_url: "https://vendor.test/pricing",
      verified_date: "2026-10-24",
      free_tier_covers_api: true,
    },
    source_urls: ["https://vendor.test/docs", "https://vendor.test/pricing"],
  };

  it("hands back an ordered research recipe and the rules, without touching the network", async () => {
    const parsed = await parse("discover_api", { capability: "CVE lookup", vendor: "NVD" });
    expect(parsed.research_plan.map((source: any) => source.order)).toEqual([1, 2, 3, 4, 5, 6]);
    const plan = JSON.stringify(parsed.research_plan);
    expect(plan).toMatch(/pricing page/i);
    expect(plan).toMatch(/openapi/i);
    expect(plan).toMatch(/apis\.guru/i);
    expect(parsed.rules.join(" ")).toMatch(/status: unverified/);
    expect(parsed.rules.join(" ")).toMatch(/null means nobody checked/);
    expect(parsed.promotion).toMatch(/2xx/);
    expect(parsed.write_to.user_index_file).toBe(userIndex);
    expect(parsed.write_to.user_index_exists).toBe(false);
  });

  it("shows what the index nearly matched, so a row is not duplicated", async () => {
    const parsed = await parse("discover_api", { capability: "embeddings" });
    expect(parsed.near_matches.some((match: any) => match.name === "example-voyage-embeddings")).toBe(true);
    expect(parsed.near_match_note).toMatch(/use it instead of/);
  });

  it("writes an unverified row that find_api then returns", async () => {
    const written = await parse("propose_entry", DISCOVERY);
    expect(written.written).toBe(true);
    expect(written.entry.status).toBe("unverified");
    expect(written.routing.route).toBe("direct");
    expect(written.next_steps.join(" ")).toMatch(/promotes this row/);
    expect(written.reminder).toMatch(/No secret was written/);

    const found = await parse("find_api", { capability: "CVE lookup" });
    const row = found.matches.find((match: any) => match.name === "demo-cve-api");
    expect(row.index_origin).toBe("user");
    expect(row.status).toBe("unverified");
    expect(row.auth.auth_header).toBe("apiKey");
    expect(row.billing.model).toBe("free");
    expect(found.index_counts.user_index).toBe(1);
  });

  it("promotes the row to verified after a 2xx, and names the ledger row", async () => {
    await parse("propose_entry", DISCOVERY);
    const ledger = openLedger(home);
    ledger.record({
      alias: null,
      domain: "api.vendor.test",
      status: 200,
      bytes: 321,
      timestamp: "2026-10-24T09:00:00.000Z",
    });
    ledger.close();

    const found = await parse("find_api", { capability: "CVE lookup" });
    expect(found.promoted_since_last_call[0].name).toBe("demo-cve-api");
    expect(found.promoted_since_last_call[0].promoted_by).toContain("ledger: 200 from api.vendor.test");
    const row = found.matches.find((match: any) => match.name === "demo-cve-api");
    expect(row.status).toBe("verified");
    // Promotion is recorded on disk, not just in the response.
    expect(fs.readFileSync(userIndex, "utf8")).toMatch(/status: verified/);
  });

  it("will not promote on a failed call", async () => {
    await parse("propose_entry", DISCOVERY);
    const ledger = openLedger(home);
    ledger.record({ alias: null, domain: "api.vendor.test", status: 403, bytes: 10 });
    ledger.close();
    const found = await parse("find_api", { capability: "CVE lookup" });
    expect(found.promoted_since_last_call).toBeUndefined();
    expect(found.matches.find((match: any) => match.name === "demo-cve-api").status).toBe("unverified");
  });

  it("refuses a row with no source, a price with no URL, and a reviewed-row collision", async () => {
    const unsourced = await parse("propose_entry", { ...DISCOVERY, source_urls: [] });
    expect(unsourced.written).toBe(false);
    expect(JSON.stringify(unsourced.errors)).toMatch(/at least one http\(s\) URL/);

    const unpriced = await parse("propose_entry", {
      ...DISCOVERY,
      aggregators: [{ name: "monid", carries: true, per_call_price: 0.01 }],
    });
    expect(unpriced.written).toBe(false);
    expect(JSON.stringify(unpriced.errors)).toMatch(/never ship a price with no source/);

    const collision = await parse("propose_entry", { ...DISCOVERY, domain: "api.apollo.io" });
    expect(collision.written).toBe(false);
    expect(JSON.stringify(collision.errors)).toMatch(/already covered by a reviewed row/);
  });

  it("ignores a `verified` status the caller asked for", async () => {
    const written = await parse("propose_entry", { ...DISCOVERY, status: "verified" });
    expect(written.entry.status).toBe("unverified");
    expect(JSON.stringify(written.notes)).toMatch(/forced to `unverified`/);
  });

  it("refuses to write a row with a credential in it, and writes nothing at all", async () => {
    const result = await parse("propose_entry", {
      ...DISCOVERY,
      tos_notes: `the key is ${SECRET}`,
    });
    expect(result.written).toBe(false);
    expect(JSON.stringify(result.errors)).toMatch(/looks like an `sk-\.\.\.` API key/);
    expect(JSON.stringify(result.errors)).toMatch(/a key belongs in the vault/);
    expect(fs.existsSync(userIndex)).toBe(false);
    // And no tool response ever echoes the vault's secret back either.
    const list = await parse("list_keys", {});
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it("still accepts an honest note about the header name and template", async () => {
    const result = await parse("propose_entry", {
      ...DISCOVERY,
      auth_format: "Bearer {key}",
      tos_notes: "Auth is `Authorization: Bearer {key}` per the vendor's own docs.",
    });
    expect(result.errors ?? []).toEqual([]);
    expect(result.written).toBe(true);
  });
});

// --- v0.2: staleness warnings and the per-key upstream scheme --------------

describe("staleness warnings in find_api and request_access", () => {
  let home: string;
  let ctx: McpContext;
  let apisFile: string;
  /** Fixed "today", so the ages below never drift with the wall clock. */
  const TODAY = "2026-10-25";

  const row = (
    name: string,
    checked: string | null,
    billingVerified: string | null,
    extra: string[] = [],
  ): string =>
    [
      `  - name: ${name}`,
      `    url: https://${name}.test/docs`,
      `    domain: api.${name}.test`,
      "    capabilities:",
      "      - widget telemetry",
      "    access_mode: own-account",
      "    min_topup: null",
      "    billing_unit: null",
      "    signup_automatable: null",
      "    tos_notes: null",
      `    source: ${checked === null ? "null" : `https://${name}.test/pricing`}`,
      `    checked_date: ${checked ?? "null"}`,
      ...(billingVerified === null
        ? []
        : [
            "    billing:",
            "      model: payg",
            `      verified_url: https://${name}.test/pricing`,
            `      verified_date: ${billingVerified}`,
          ]),
      ...extra,
    ].join("\n");

  beforeEach(async () => {
    home = makeHome();
    apisFile = path.join(home, "fixture-apis.yaml");
    fs.writeFileSync(
      apisFile,
      [
        "version: 1",
        "entries:",
        // Verified 20 months ago: every fact on it has aged out.
        row("stale-vendor", "2025-02-01", "2025-02-01"),
        // Verified last week: nothing to warn about.
        row("fresh-vendor", "2026-10-18", "2026-10-18"),
        // Presents itself as a real row and has never been checked at all.
        row("unchecked-vendor", null, null),
        // An example row is honest about being a placeholder, so a null date
        // on it is not a warning.
        row("placeholder-vendor", null, null, ["    example: true"]),
        "",
      ].join("\n"),
    );
    ctx = {
      home,
      apisFile,
      apiShardDirs: [],
      userIndexFile: null,
      allowTtyPrompt: false,
      today: TODAY,
    };
    await initWithKey(home, { alias: ALIAS, secret: SECRET, domain: DOMAIN });
  });
  afterEach(() => removeHome(home));

  const parse = async (tool: string, args: Record<string, unknown>): Promise<any> =>
    JSON.parse(text(await callSkeletonKeyTool(tool, args, ctx)));

  it("flags a row whose facts have aged past the window, and says how old", async () => {
    const parsed = await parse("find_api", { capability: "widget telemetry" });
    const byName = new Map<string, any>(parsed.matches.map((match: any) => [match.name, match]));

    expect(parsed.stale_after_days).toBe(90);
    const stale = byName.get("stale-vendor");
    expect(stale.freshness.stale).toBe(true);
    expect(stale.freshness.checked_age_days).toBeGreaterThan(600);
    expect(stale.freshness.warnings.join(" ")).toMatch(/checked_date is 2025-02-01/);
    expect(stale.freshness.warnings.join(" ")).toMatch(/90-day window/);
    expect(stale.freshness.warnings.join(" ")).toMatch(/billing\.verified_date is 2025-02-01/);
    expect(parsed.stale_matches_returned).toBeGreaterThan(0);
    expect(parsed.reminders.join(" ")).toMatch(/freshness\.stale/);
  });

  it("leaves a freshly verified row alone", async () => {
    const parsed = await parse("find_api", { capability: "widget telemetry" });
    const fresh = parsed.matches.find((match: any) => match.name === "fresh-vendor");
    expect(fresh.freshness.stale).toBe(false);
    expect(fresh.freshness.warnings).toEqual([]);
    expect(fresh.freshness.checked_age_days).toBe(7);
  });

  it("treats a null checked_date as a warning, unless the row says it is an example", async () => {
    const parsed = await parse("find_api", { capability: "widget telemetry" });
    const byName = new Map<string, any>(parsed.matches.map((match: any) => [match.name, match]));

    const unchecked = byName.get("unchecked-vendor");
    expect(unchecked.freshness.stale).toBe(true);
    expect(unchecked.freshness.checked_age_days).toBeNull();
    expect(unchecked.freshness.warnings.join(" ")).toMatch(/checked_date is null/);

    const placeholder = byName.get("placeholder-vendor");
    expect(placeholder.is_example_row).toBe(true);
    expect(placeholder.freshness.stale).toBe(false);
  });

  it("takes the window from the caller", async () => {
    const strict = await parse("find_api", { capability: "widget telemetry", max_age_days: 3 });
    expect(strict.stale_after_days).toBe(3);
    const fresh = strict.matches.find((match: any) => match.name === "fresh-vendor");
    expect(fresh.freshness.stale).toBe(true);
    expect(fresh.freshness.warnings.join(" ")).toMatch(/3-day window/);

    const lax = await parse("find_api", { capability: "widget telemetry", max_age_days: 5000 });
    const stale = lax.matches.find((match: any) => match.name === "stale-vendor");
    expect(stale.freshness.stale).toBe(false);
  });

  it("warns in request_access too, for the row it is about to recommend", async () => {
    const parsed = await parse("request_access", {
      platform: "stale-vendor",
      reason: "read some telemetry",
    });
    expect(parsed.has_key).toBe(false);
    expect(parsed.freshness.stale).toBe(true);
    expect(parsed.staleness_warning.join(" ")).toMatch(/older than the 90-day window/);

    const clean = await parse("request_access", { platform: "fresh-vendor" });
    expect(clean.freshness.stale).toBe(false);
    expect(clean.staleness_warning).toBeUndefined();
  });

  it("says nothing about staleness when there is no row at all", async () => {
    const parsed = await parse("request_access", { platform: "zzz-unindexed-vendor" });
    expect(parsed.freshness).toBeNull();
    expect(parsed.staleness_warning).toBeUndefined();
  });
});

describe("the upstream scheme a key is called over", () => {
  let home: string;
  let ctx: McpContext;

  beforeEach(async () => {
    home = makeHome();
    ctx = { home, apisFile: APIS_YAML, apiShardDirs: [], allowTtyPrompt: false };
    await initWithKey(home, { alias: ALIAS, secret: SECRET, domain: DOMAIN });
  });
  afterEach(() => removeHome(home));

  const parse = async (tool: string, args: Record<string, unknown>): Promise<any> =>
    JSON.parse(text(await callSkeletonKeyTool(tool, args, ctx)));

  it("reports https for a normal vendor domain, and where that came from", async () => {
    const parsed = await parse("list_keys", {});
    const key = parsed.keys.find((row: any) => row.alias === ALIAS);
    expect(key.upstream_scheme).toBe("https");
    expect(key.upstream_scheme_source).toBe("default");
  });

  it("passes a per-key scheme through to the command the human runs", async () => {
    const parsed = await parse("register_key", {
      alias: "lab-box",
      platform: "LabBox",
      domain: "box.lab.test",
      scheme: "http",
    });
    expect(parsed.stored).toBe(false);
    expect(parsed.command_for_human).toContain("--scheme http");
  });

  it("rejects a scheme it does not know rather than inventing one", async () => {
    const result = await callSkeletonKeyTool(
      "register_key",
      { alias: "lab-box", platform: "LabBox", domain: "box.lab.test", scheme: "ftp" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("`scheme` must be `https` or `http`");
  });

  it("tells the agent what a disabled key now does at the proxy", async () => {
    const disabled = await parse("disable", { alias: ALIAS, reason: "rotating" });
    expect(disabled.proxy_behaviour).toContain("key_disabled");
    const parsed = await parse("request_access", { platform: "ExampleCo" });
    expect(parsed.disabled).toBe(true);
    expect(parsed.proxy_behaviour).toContain("403");
    expect(parsed.hint).toContain("skeletonkey enable");
  });
});
