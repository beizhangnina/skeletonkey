/**
 * ND-6: sudden 401/403 handling, and what happens when a vendor's usage
 * endpoint answers 200 with a body that cannot actually be parsed into usage.
 * No test here ever reaches the network.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { writeConfig } from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";
import { upsertKey } from "../src/keys.js";
import type { Notification, Notifier } from "../src/notify.js";
import { monitorStatePath } from "../src/paths.js";
import { runMonitor } from "../src/monitor/run.js";
import { readMonitorState } from "../src/monitor/state.js";
import type { HttpTransport, TransportResponse } from "../src/monitor/types.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const CANARY_KEY = "ND6CANARYb2c3d4e5f6a7b8c9d0e1f2";
const CANARY_KEY_SHAPED = "sk-ND6CANARYb2c3d4e5f6a7b8c9d0e1f2";

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

class RecordingNotifier implements Notifier {
  readonly id = "fake";
  notifications: Notification[] = [];
  async notify(notification: Notification): Promise<boolean> {
    this.notifications.push(notification);
    return true;
  }
}

function jsonResponse(status: number, body: unknown): TransportResponse {
  return { status, text: async () => JSON.stringify(body) };
}

function textResponse(status: number, body: string): TransportResponse {
  return { status, text: async () => body };
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

describe("ND-6: sudden 401/403 and non-parseable 200 responses", () => {
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

  async function runOnce(
    apisFile: string,
    transport: HttpTransport,
    now: string,
    notifier?: Notifier,
  ) {
    return runMonitor({
      home,
      apisFile,
      notify: notifier !== undefined,
      ...(notifier !== undefined ? { notifier } : {}),
      transport,
      now: () => new Date(now),
    });
  }

  it("401 after a previous ok run: invalid_key, 'sudden' in reason, alert, exit 78, notified, state preserved", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const baseline = await runOnce(
      apisFile,
      async () => jsonResponse(200, { data: { monthlyUsageUsd: 4 } }),
      "2026-11-01T00:00:00.000Z",
    );
    expect(baseline.accounts[0]?.status).toBe("ok");

    const notifier = new RecordingNotifier();
    const second = await runOnce(
      apisFile,
      async () => jsonResponse(401, { message: "Bad credentials" }),
      "2026-11-08T00:00:00.000Z",
      notifier,
    );

    expect(second.accounts[0]?.status).toBe("invalid_key");
    expect(second.accounts[0]?.reasons.join(" ")).toContain("sudden");
    expect(second.accounts[0]?.isAlert).toBe(true);
    expect(second.exitCode).toBe(EXIT.monitor_alert);
    expect(notifier.notifications).toHaveLength(1);

    const state = readMonitorState(home);
    expect(state.accounts["apify-main"]?.last_status).toBe("invalid_key");
    expect(state.accounts["apify-main"]?.last_usage).toEqual(baseline.accounts[0]?.usage);
  });

  it("403 after a previous ok run: same sudden invalid_key behaviour", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const baseline = await runOnce(
      apisFile,
      async () => jsonResponse(200, { data: { monthlyUsageUsd: 4 } }),
      "2026-11-01T00:00:00.000Z",
    );
    expect(baseline.accounts[0]?.status).toBe("ok");

    const second = await runOnce(
      apisFile,
      async () => jsonResponse(403, { message: "Forbidden" }),
      "2026-11-08T00:00:00.000Z",
    );

    expect(second.accounts[0]?.status).toBe("invalid_key");
    expect(second.accounts[0]?.reasons.join(" ")).toContain("sudden");
    expect(second.accounts[0]?.isAlert).toBe(true);
    expect(second.exitCode).toBe(EXIT.monitor_alert);
  });

  it("previous run was usage_anomaly, this run is 401: still invalid_key, no crash, no 'sudden'", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    // First run establishes a small baseline; a null `previous` never alerts.
    const first = await runOnce(
      apisFile,
      async () => jsonResponse(200, { data: { monthlyUsageUsd: 1 } }),
      "2026-11-01T00:00:00.000Z",
    );
    expect(first.accounts[0]?.status).toBe("ok");

    const spike = await runOnce(
      apisFile,
      async () => jsonResponse(200, { data: { monthlyUsageUsd: 100000 } }),
      "2026-11-08T00:00:00.000Z",
    );
    expect(spike.accounts[0]?.status).toBe("usage_anomaly");

    const third = await runOnce(
      apisFile,
      async () => jsonResponse(401, { message: "Bad credentials" }),
      "2026-11-15T00:00:00.000Z",
    );

    expect(third.accounts[0]?.status).toBe("invalid_key");
    expect(third.accounts[0]?.isAlert).toBe(true);
    expect(third.accounts[0]?.reasons.join(" ")).not.toContain("sudden");
  });

  it("first run ever is 401 (no previous state): invalid_key alert, reason does not say 'sudden'", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const result = await runOnce(
      apisFile,
      async () => jsonResponse(401, { message: "Bad credentials" }),
      "2026-11-01T00:00:00.000Z",
    );

    expect(result.accounts[0]?.status).toBe("invalid_key");
    expect(result.accounts[0]?.isAlert).toBe(true);
    expect(result.accounts[0]?.reasons.join(" ")).not.toContain("sudden");
  });

  it("401 with an HTML body containing the canary key: no crash, canary absent everywhere", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const body = `<html><body>Error: key ${CANARY_KEY} is invalid</body></html>`;
    const result = await runOnce(apisFile, async () => textResponse(401, body), "2026-11-01T00:00:00.000Z");

    expect(result.accounts[0]?.status).toBe("invalid_key");
    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    const surfaces = [result.reportText, stateText, JSON.stringify(result)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY_KEY);
    }
  });

  it("transport throws an Error whose message embeds the full URL (serpapi key as query param)", async () => {
    const apisFile = writeApisFixture(home, [SERPAPI_ENTRY]);
    await setupAccount(home, { name: "serpapi-main", vendor: "serpapi", secret: CANARY_KEY });

    const transport: HttpTransport = async (url) => {
      throw new Error(`connection reset while fetching ${url}`);
    };
    const result = await runOnce(apisFile, transport, "2026-11-01T00:00:00.000Z");

    expect(result.accounts[0]?.status).toBe("error");
    expect(result.accounts[0]?.isAlert).toBe(true);
    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    const surfaces = [result.reportText, stateText, JSON.stringify(result)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY_KEY);
    }
  });

  it.each([500, 429, 302])("HTTP %i -> status error, alert, not ok", async (status) => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const result = await runOnce(
      apisFile,
      async () => textResponse(status, "upstream trouble"),
      "2026-11-01T00:00:00.000Z",
    );

    expect(result.accounts[0]?.status).toBe("error");
    expect(result.accounts[0]?.isAlert).toBe(true);
    expect(result.accounts[0]?.status).not.toBe("ok");
  });

  // ND-6 FINDING: a 200 response whose body is not valid JSON makes parseApify
  // return null, so outcome.usage is null and detectAnomaly(null, ...) short
  // circuits to "no alert" -- the account is reported as a bare "ok" with
  // usage "unknown" and zero reasons. A human reading the report cannot tell
  // the difference between "usage really is zero/unchanged" and "the vendor's
  // response could not be parsed at all".
  it("200 with a non-JSON body is not reported as a bare, unexplained ok", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const result = await runOnce(
      apisFile,
      async () => textResponse(200, "<html>maintenance</html>"),
      "2026-11-01T00:00:00.000Z",
    );

    const account = result.accounts[0];
    const explainsFailure =
      account?.status !== "ok" ||
      account.reasons.some((reason) => /could not be parsed|cannot auto-compare|unparseable/i.test(reason));
    expect(explainsFailure).toBe(true);
  });

  // ND-6 FINDING: a 200 response of `{}` parses to an all-null NormalizedUsage
  // object (not `null`), so it is NOT caught by detectAnomaly's `current ===
  // null` short-circuit either, and is reported as bare "ok" with reasons: [].
  it("200 with an empty JSON object `{}` is not reported as a bare, unexplained ok", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const result = await runOnce(apisFile, async () => jsonResponse(200, {}), "2026-11-01T00:00:00.000Z");

    const account = result.accounts[0];
    const explainsFailure =
      account?.status !== "ok" ||
      account.reasons.some((reason) => /could not be parsed|cannot auto-compare|unparseable/i.test(reason));
    expect(explainsFailure).toBe(true);
  });

  it("recovery: a 200 after invalid_key goes back to ok, with no 'sudden' text", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY_KEY });

    const first = await runOnce(
      apisFile,
      async () => jsonResponse(401, { message: "Bad credentials" }),
      "2026-11-01T00:00:00.000Z",
    );
    expect(first.accounts[0]?.status).toBe("invalid_key");

    const second = await runOnce(
      apisFile,
      async () => jsonResponse(200, { data: { monthlyUsageUsd: 2 } }),
      "2026-11-08T00:00:00.000Z",
    );

    expect(second.accounts[0]?.status).toBe("ok");
    expect(second.accounts[0]?.reasons.join(" ")).not.toContain("sudden");
    expect(second.reportText).not.toContain(CANARY_KEY);
    expect(second.reportText).not.toContain(CANARY_KEY_SHAPED);
  });
});
