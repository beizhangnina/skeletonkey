/**
 * ND-6: canary full-text search for redaction gaps around `skeletonkey
 * monitor`. The main vector here (per the ND-6 handoff correction) is the
 * account's OWN secret being echoed back by a vendor into a string field
 * (`data.usageCycle.startAt`) that the apify parser folds into
 * `NormalizedUsage.period` -- a value that then flows into state.json and the
 * MCP `monitor_status` tool, neither of which goes through the run-scoped
 * `Redactor`. The canary is deliberately shapeless (`zz` + 32 lowercase hex)
 * so none of `redactShapes`' shape rules can catch it by accident: only an
 * actual known-value match (`redactor.add(key)` + `redactor.redact(...)`)
 * can.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAccounts, upsertAccount, writeAccounts, type AccountMeta } from "../src/accounts/store.js";
import { writeConfig } from "../src/config.js";
import { upsertKey } from "../src/keys.js";
import { callSkeletonKeyTool, type McpContext } from "../src/mcp.js";
import { runMonitor, type MonitorRunResult } from "../src/monitor/run.js";
import { monitorStatePath } from "../src/paths.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import type { HttpTransport, TransportResponse } from "../src/monitor/types.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

/** Shapeless on purpose: no `sk-`/`ghp_`/etc prefix, so shape rules cannot catch it. */
const CANARY_PERIOD = `zz${crypto.randomBytes(16).toString("hex")}`;
const CANARY_EMAIL = `nd6canary-${crypto.randomBytes(8).toString("hex")}@example.test`;
const CANARY_SERPAPI = `ND6CANARY${crypto.randomBytes(12).toString("hex")}`;
const CANARY_ERROR = `ND6CANARY${crypto.randomBytes(12).toString("hex")}`;

let realFetchCalled = false;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  realFetchCalled = false;
  globalThis.fetch = (() => {
    realFetchCalled = true;
    throw new Error("real network forbidden in tests");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  expect(realFetchCalled).toBe(false);
});

function jsonResponse(status: number, body: unknown): TransportResponse {
  return { status, text: async () => JSON.stringify(body) };
}

function apiEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: overrides["name"],
    url: "https://example.test/docs",
    access_mode: "own-account",
    min_topup: null,
    billing_unit: null,
    signup_automatable: null,
    tos_notes: null,
    source: null,
    checked_date: "2026-11-01",
    ...overrides,
  };
}

function usageApi(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    available: true,
    method: "GET",
    path: null,
    docs_url: "https://vendor.test/docs/usage",
    limits: null,
    notes: null,
    checked_date: "2026-11-24",
    ...overrides,
  };
}

function writeApisFixture(home: string, entries: Record<string, unknown>[]): string {
  const file = path.join(home, "fixture-apis.yaml");
  fs.writeFileSync(file, YAML.stringify({ version: 1, entries }));
  return file;
}

async function setupAccount(
  home: string,
  options: { name: string; vendor: string; secret: string },
): Promise<AccountMeta> {
  const store = openEntryStore(home);
  await store.putApiKey(options.name, options.secret);
  upsertKey(
    {
      alias: options.name,
      platform: options.vendor,
      domain: "example.test",
      header: "Authorization",
      format: "Bearer {key}",
      created: "2026-11-01T00:00:00.000Z",
      last_used: null,
      disabled: false,
    },
    home,
  );
  const meta: AccountMeta = {
    name: options.name,
    vendor: options.vendor,
    registered: "2026-11-01",
    email_hint: "b**********@gmail.com",
    key_alias: options.name,
    login_entry: null,
    created: "2026-11-01T00:00:00.000Z",
    disabled: false,
    disabled_at: null,
  };
  upsertAccount(meta, home);
  return meta;
}

const APIFY_ENTRY = apiEntry({
  name: "apify",
  usage_api: usageApi({ path: "https://api.apify.com/v2/users/me/usage/monthly" }),
});
const SERPAPI_ENTRY = apiEntry({
  name: "serpapi",
  usage_api: usageApi({ path: "https://serpapi.com/account.json" }),
});

describe("ND-6 redaction: a vendor echoes the account's own key into usageCycle.startAt", () => {
  let home: string;
  let apisFile: string;
  const ACCOUNT = "apify-main";

  beforeEach(() => {
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
    apisFile = writeApisFixture(home, [APIFY_ENTRY]);
  });

  afterEach(() => {
    removeHome(home);
  });

  /** Runs once, with the apify checker echoing the account's own key back as usageCycle.startAt. */
  async function seedTaintedState(): Promise<MonitorRunResult> {
    await setupAccount(home, { name: ACCOUNT, vendor: "apify", secret: CANARY_PERIOD });
    const transport: HttpTransport = async () =>
      jsonResponse(200, {
        data: {
          monthlyUsageUsd: 5,
          usageCycle: { startAt: CANARY_PERIOD, endAt: "2026-12-01T00:00:00.000Z" },
        },
      });
    return runMonitor({
      home,
      apisFile,
      notify: false,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
  }

  it("surface: in-process report text never contains the account's own key", async () => {
    const result = await seedTaintedState();
    expect(result.reportText).not.toContain(CANARY_PERIOD);
  });

  // ND-6 FINDING: run.ts pushes `outcome.usage` (the parsed NormalizedUsage,
  // including `period`) straight into `AccountCheckResult.usage` without ever
  // passing it through the run-scoped Redactor -- only the rendered report
  // text is redacted. `JSON.stringify(result)` -- what both the in-process
  // caller and `monitor run --json` expose -- carries the raw key.
  it("surface: JSON.stringify(runMonitor result) carries the raw key via usage.period", async () => {
    const result = await seedTaintedState();
    expect(JSON.stringify(result)).not.toContain(CANARY_PERIOD);
  });

  // ND-6 FINDING: `writeMonitorState` (src/monitor/state.ts) writes
  // `nextState.accounts[name].last_usage` to disk verbatim; it is never
  // passed through the Redactor that `run.ts` builds for the report. A
  // shapeless secret echoed into `period` lands in state.json in cleartext.
  it("surface: state.json carries the raw key via last_usage.period", async () => {
    await seedTaintedState();
    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    expect(stateText).not.toContain(CANARY_PERIOD);
  });

  // ND-6 FINDING: `monitor_status` reads state.json directly and its result
  // only passes through `globalRedactor.redactDeep` (src/mcp.ts), which is a
  // process-wide redactor that this run's per-call Redactor never registers
  // the key with, and which otherwise only applies shape rules. A shapeless
  // canary is caught by neither, so it reaches the MCP tool's own output.
  it("surface: MCP monitor_status (fresh ctx) carries the raw key via last_usage.period", async () => {
    await seedTaintedState();
    const ctx: McpContext = { home };
    const response = await callSkeletonKeyTool("monitor_status", {}, ctx);
    const text = response.content.map((part) => part.text).join("");
    expect(text).not.toContain(CANARY_PERIOD);
  });

  describe("surface: CLI", () => {
    // ND-6 FINDING: `cmdMonitorRun`'s --json branch (src/cli.ts) prints
    // `result.accounts` straight from runMonitor, which (per above) is
    // unredacted. An --offline run carries the already-tainted state.json
    // value forward into this same unredacted field.
    it("`monitor run --offline --json` carries the leaked period forward", async () => {
      await seedTaintedState();
      const result = await runCli(home, ["monitor", "run", "--offline", "--json", "--no-notify"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(CANARY_PERIOD);
    });

    it("`monitor run --offline` (table output) never prints usage.period at all", async () => {
      await seedTaintedState();
      const result = await runCli(home, ["monitor", "run", "--offline", "--no-notify"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(CANARY_PERIOD);
      expect(result.stderr).not.toContain(CANARY_PERIOD);
    });

    it("`monitor report --latest` prints the redacted report, not the raw period", async () => {
      await seedTaintedState();
      const result = await runCli(home, ["monitor", "report", "--latest"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(CANARY_PERIOD);
    });

    it("`monitor report --json` prints the redacted report, not the raw period", async () => {
      await seedTaintedState();
      const result = await runCli(home, ["monitor", "report", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(CANARY_PERIOD);
    });
  });
});

describe("ND-6 redaction: defense-in-depth against a mis-stored plaintext email", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
  });

  afterEach(() => {
    removeHome(home);
  });

  // ND-6 FINDING: `email_hint` is documented (src/accounts/store.ts) as
  // "Masked ... Never the plaintext email", but nothing downstream
  // (src/monitor/report.ts's `accountSection`, or the result object) checks
  // that invariant at read time -- it is trusted blindly. A hand-edited
  // accounts.yaml with a plaintext email_hint (e.g. a human editing the file
  // directly, or a future bug in whatever writes it) is echoed verbatim into
  // the weekly report instead of being masked or rejected.
  it("a hand-edited accounts.yaml with a plaintext email_hint is not echoed verbatim into the report", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-nd6-emailhint" });

    // Simulate a hand-edited accounts.yaml: write a plaintext email_hint
    // directly through the store's own writer, bypassing whatever masked it
    // on the way in originally.
    const accounts = readAccounts(home);
    const tampered = accounts.accounts.map((account) =>
      account.name === "apify-main" ? { ...account, email_hint: CANARY_EMAIL } : account,
    );
    writeAccounts({ version: 1, accounts: tampered }, home);

    const transport: HttpTransport = async () => jsonResponse(200, { data: { monthlyUsageUsd: 1 } });
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.reportText).not.toContain(CANARY_EMAIL);
    expect(JSON.stringify(result)).not.toContain(CANARY_EMAIL);
  });
});

describe("ND-6 redaction: other item-4 vectors, with ND-6 canaries", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
  });

  afterEach(() => {
    removeHome(home);
  });

  it("a serpapi-style response carrying api_key and account_email never reaches any output", async () => {
    const apisFile = writeApisFixture(home, [SERPAPI_ENTRY]);
    await setupAccount(home, { name: "serpapi-main", vendor: "serpapi", secret: CANARY_SERPAPI });

    const transport: HttpTransport = async (url) => {
      const body = {
        api_key: new URL(url).searchParams.get("api_key"),
        account_email: CANARY_EMAIL,
        this_month_usage: 5,
        plan_searches_left: 95,
        searches_per_month: 100,
      };
      return jsonResponse(200, body);
    };

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    const surfaces = [result.reportText, stateText, JSON.stringify(result)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY_SERPAPI);
      expect(surface).not.toContain(CANARY_EMAIL);
    }
  });

  it("the key never reaches any output when the transport throws an error embedding the full URL", async () => {
    const apisFile = writeApisFixture(home, [SERPAPI_ENTRY]);
    await setupAccount(home, { name: "serpapi-main", vendor: "serpapi", secret: CANARY_ERROR });

    const transport: HttpTransport = async (url) => {
      throw new Error(`connection reset while fetching ${url}`);
    };

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("error");
    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    const surfaces = [result.reportText, stateText, JSON.stringify(result)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY_ERROR);
    }
  });

  it("a key containing +/=/ chars is absent in both raw and URL-encoded form after an error", async () => {
    const apisFile = writeApisFixture(home, [SERPAPI_ENTRY]);
    const oddKey = `ND6CANARY${crypto.randomBytes(9).toString("base64")}`; // contains +, /, possibly =
    await setupAccount(home, { name: "serpapi-main", vendor: "serpapi", secret: oddKey });

    const transport: HttpTransport = async (url) => {
      throw new Error(`connection reset while fetching ${url}`);
    };

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    const surfaces = [result.reportText, stateText, JSON.stringify(result)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(oddKey);
      expect(surface).not.toContain(encodeURIComponent(oddKey));
    }
  });
});
