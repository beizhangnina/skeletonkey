/**
 * ND-6: degraded cases where there is no usable official usage API -- the
 * monitor must say so honestly (no_usage_api, "cannot auto-compare") and
 * must never make a network call or pretend things are fine. No test here
 * ever reaches the network.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { writeConfig } from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";
import { upsertKey } from "../src/keys.js";
import { runMonitor } from "../src/monitor/run.js";
import type { HttpTransport } from "../src/monitor/types.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const CANARY_KEY = "ND6CANARYc3d4e5f6a7b8c9d0e1f2a3";

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

const refusingTransport: HttpTransport = async () => {
  throw new Error("refusingTransport: no call was supposed to happen");
};

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
  options: { name: string; vendor: string; secret?: string; keyAlias?: string | null },
): Promise<AccountMeta> {
  const keyAlias = options.keyAlias === undefined ? options.name : options.keyAlias;
  if (keyAlias !== null) {
    const store = openEntryStore(home);
    await store.putApiKey(keyAlias, options.secret ?? CANARY_KEY);
    upsertKey(
      {
        alias: keyAlias,
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
  }
  const meta: AccountMeta = {
    name: options.name,
    vendor: options.vendor,
    registered: "2026-11-01",
    email_hint: "b**********@gmail.com",
    key_alias: keyAlias,
    login_entry: null,
    created: "2026-11-01T00:00:00.000Z",
    disabled: false,
    disabled_at: null,
  };
  upsertAccount(meta, home);
  return meta;
}

describe("ND-6: no usage API / degraded checks", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    writeConfig(
      { email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" },
      home,
    );
  });

  afterEach(() => {
    removeHome(home);
  });

  async function assertNoUsageApi(apisFile: string, accountName: string) {
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
    const account = result.accounts.find((a) => a.name === accountName) ?? result.accounts[0];
    expect(account?.status).toBe("no_usage_api");
    expect(account?.isAlert).toBe(false);
    expect(account?.reasons.join(" ")).toContain("cannot auto-compare");
    expect(result.exitCode).toBe(EXIT.ok);
    expect(account?.usage).toBeNull();
    expect(result.reportText).toContain("usage: unknown");
    return result;
  }

  it("usage_api.available: null -> no_usage_api, cannot auto-compare, no transport call", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({ name: "acme-null", usage_api: usageApi({ available: null, method: null }) }),
    ]);
    await setupAccount(home, { name: "acme-main", vendor: "acme-null" });
    await assertNoUsageApi(apisFile, "acme-main");
  });

  it("usage_api.available: false -> no_usage_api, cannot auto-compare, no transport call", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({ name: "acme-false", usage_api: usageApi({ available: false, method: null }) }),
    ]);
    await setupAccount(home, { name: "acme-main", vendor: "acme-false" });
    await assertNoUsageApi(apisFile, "acme-main");
  });

  it("usage_api entirely missing from the entry -> no_usage_api, cannot auto-compare, no transport call", async () => {
    const apisFile = writeApisFixture(home, [apiEntry({ name: "acme-missing" })]);
    await setupAccount(home, { name: "acme-main", vendor: "acme-missing" });
    await assertNoUsageApi(apisFile, "acme-main");
  });

  it("vendor not in the index at all -> no_usage_api, cannot auto-compare, no transport call", async () => {
    const apisFile = writeApisFixture(home, []);
    await setupAccount(home, { name: "acme-main", vendor: "ghost-vendor" });
    await assertNoUsageApi(apisFile, "acme-main");
  });

  it("usage_api.available: true but no checker implemented -> no_usage_api with 'no checker' text, no transport call", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({ name: "mystery-vendor", usage_api: usageApi({ available: true, path: "https://mystery.test/usage" }) }),
    ]);
    await setupAccount(home, { name: "mystery-main", vendor: "mystery-vendor" });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("no_usage_api");
    expect(result.accounts[0]?.reasons.join(" ")).toContain("no checker");
    expect(result.accounts[0]?.isAlert).toBe(false);
  });

  it("exa without a <key_alias>-service vault entry -> no_usage_api, no main key is ever sent anywhere", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({
        name: "exa",
        usage_api: usageApi({ path: "https://admin-api.exa.ai/team-management/credits" }),
      }),
    ]);
    await setupAccount(home, { name: "exa-main", vendor: "exa", secret: CANARY_KEY });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("no_usage_api");
    expect(result.accounts[0]?.reasons.join(" ")).toContain("requires Team Management service key");
    expect(result.reportText).not.toContain(CANARY_KEY);
  });

  it("account with key_alias: null -> no_usage_api, no transport call", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({
        name: "apify",
        usage_api: usageApi({ path: "https://api.apify.com/v2/users/me/usage/monthly" }),
      }),
    ]);
    await setupAccount(home, { name: "noalias-main", vendor: "apify", keyAlias: null });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("no_usage_api");
    expect(result.accounts[0]?.isAlert).toBe(false);
    expect(result.accounts[0]?.reasons.join(" ")).toContain("cannot auto-compare");
  });

  it("--offline with no prior state does not pretend ok, and makes no transport call", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({
        name: "apify",
        usage_api: usageApi({ path: "https://api.apify.com/v2/users/me/usage/monthly" }),
      }),
    ]);
    await setupAccount(home, { name: "apify-main", vendor: "apify" });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      offline: true,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).not.toBe("ok");
  });

  it("every non-skipped account carries the honest login/billing anomaly note", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({ name: "acme-null", usage_api: usageApi({ available: null, method: null }) }),
    ]);
    await setupAccount(home, { name: "acme-main", vendor: "acme-null" });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.reportText).toContain("login/billing anomaly check: not available via official API");
  });
});
