/**
 * ND-6: anomaly detection, unit-level (detectAnomaly) and end-to-end
 * (runMonitor with a FakeTransport). No test here ever reaches the network.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { writeConfig, readConfig } from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";
import { upsertKey } from "../src/keys.js";
import { configPath } from "../src/paths.js";
import type { Notification, Notifier } from "../src/notify.js";
import { detectAnomaly, type LedgerWindowStats } from "../src/monitor/anomaly.js";
import { runMonitor } from "../src/monitor/run.js";
import {
  DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD,
  DEFAULT_ANOMALY_MULTIPLIER,
  DEFAULT_REMAINING_DROP_PCT_THRESHOLD,
  resolveMonitorThresholds,
} from "../src/monitor/thresholds.js";
import type { HttpTransport, NormalizedUsage, TransportResponse } from "../src/monitor/types.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const CANARY_KEY = "ND6CANARYa1b2c3d4e5f6a7b8c9d0e1";
const CANARY_KEY_SHAPED = "sk-ND6CANARYa1b2c3d4e5f6a7b8c9d0e1";

const DEFAULT_THRESHOLDS = {
  anomalyMultiplier: DEFAULT_ANOMALY_MULTIPLIER,
  anomalyAbsoluteThreshold: DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD,
  remainingDropPctThreshold: DEFAULT_REMAINING_DROP_PCT_THRESHOLD,
};

function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return { used: null, limit: null, remaining: null, unit: null, period: null, ...overrides };
}

function ledgerStats(calls: number, cost: number | null = null): LedgerWindowStats {
  return { calls, cost };
}

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

class FakeTransport {
  calls: { url: string }[] = [];
  private queues = new Map<string, TransportResponse[]>();

  queue(host: string, response: TransportResponse): void {
    const list = this.queues.get(host) ?? [];
    list.push(response);
    this.queues.set(host, list);
  }

  asTransport(): HttpTransport {
    return async (url, init) => {
      this.calls.push({ url });
      void init;
      const host = new URL(url).host;
      const list = this.queues.get(host);
      if (list === undefined || list.length === 0) {
        throw new Error(`FakeTransport: no queued response for ${host}`);
      }
      return list.shift() as TransportResponse;
    };
  }
}

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
const GITHUB_ENTRY = apiEntry({
  name: "github",
  usage_api: usageApi({ path: "https://api.github.com/rate_limit" }),
});

describe("detectAnomaly (unit)", () => {
  it("flags a spike: previous used 10, current used 1000, ledger shows 0 calls", () => {
    const verdict = detectAnomaly(
      usage({ used: 1000, unit: "requests" }),
      usage({ used: 10, unit: "requests" }),
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("usage_anomaly");
  });

  it("flags a usage far above baseline, with a ledger-reported USD cost implying little spend", () => {
    const verdict = detectAnomaly(
      usage({ used: 500, unit: "USD" }),
      usage({ used: 100, unit: "USD" }),
      ledgerStats(2, 10),
      DEFAULT_THRESHOLDS,
    );
    // implied = 10 (reported cost); bound = max(2*10, 10+5) = 20; delta = 400 > 20
    expect(verdict.isAnomaly).toBe(true);
  });

  it("is NOT an anomaly exactly at the bound, and IS an anomaly just past it", () => {
    // implied = ledger calls = 10 (non-USD unit); bound = max(2*10, 10+5) = 20
    const atBound = detectAnomaly(
      usage({ used: 20, unit: "requests" }),
      usage({ used: 0, unit: "requests" }),
      ledgerStats(10),
      DEFAULT_THRESHOLDS,
    );
    expect(atBound.isAnomaly).toBe(false);

    const pastBound = detectAnomaly(
      usage({ used: 20.01, unit: "requests" }),
      usage({ used: 0, unit: "requests" }),
      ledgerStats(10),
      DEFAULT_THRESHOLDS,
    );
    expect(pastBound.isAnomaly).toBe(true);
  });

  it("zero usage this run and last run -> no alert", () => {
    const verdict = detectAnomaly(
      usage({ used: 0, remaining: 100, unit: "requests" }),
      usage({ used: 0, remaining: 100, unit: "requests" }),
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(false);
  });

  it("no previous run (first run ever) -> no alert, whatever the current usage is", () => {
    const verdict = detectAnomaly(
      usage({ used: 99999, remaining: 1, unit: "requests" }),
      null,
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(false);
  });

  it("current.used is null -> no alert from the usage-delta branch", () => {
    const verdict = detectAnomaly(
      usage({ used: null, remaining: null }),
      usage({ used: 10, remaining: null }),
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(false);
  });

  it("previous remaining was 0 -> no division by zero, no alert", () => {
    const verdict = detectAnomaly(
      usage({ used: 10, remaining: 5, unit: "requests" }),
      usage({ used: 5, remaining: 0, unit: "requests" }),
      ledgerStats(100),
      DEFAULT_THRESHOLDS,
    );
    expect(Number.isFinite(verdict.isAnomaly ? 1 : 0)).toBe(true);
    expect(verdict.isAnomaly).toBe(false);
  });

  it("remaining unchanged -> no alert", () => {
    const verdict = detectAnomaly(
      usage({ used: 10, remaining: 50, unit: "requests" }),
      usage({ used: 5, remaining: 50, unit: "requests" }),
      ledgerStats(100),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(false);
  });

  it("delta within normal range: ledger shows 100 calls, official delta 150, multiplier 2 -> no alert", () => {
    // bound = max(2*100, 100+5) = 200; delta 150 < 200
    const verdict = detectAnomaly(
      usage({ used: 150, unit: "requests" }),
      usage({ used: 0, unit: "requests" }),
      ledgerStats(100),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(false);
  });

  it("monthly reset: used drops and remaining rises -> no alert", () => {
    const verdict = detectAnomaly(
      usage({ used: 10, remaining: 500, unit: "requests" }),
      usage({ used: 900, remaining: 10, unit: "requests" }),
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(verdict.isAnomaly).toBe(false);
  });

  it("remaining drop exactly 50% -> no alert; 50.1% -> alert", () => {
    const atHalf = detectAnomaly(
      usage({ used: 0, remaining: 50, unit: "requests" }),
      usage({ used: 0, remaining: 100, unit: "requests" }),
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(atHalf.isAnomaly).toBe(false);

    const justOver = detectAnomaly(
      usage({ used: 0, remaining: 49.9, unit: "requests" }),
      usage({ used: 0, remaining: 100, unit: "requests" }),
      ledgerStats(0),
      DEFAULT_THRESHOLDS,
    );
    expect(justOver.isAnomaly).toBe(true);
  });
});

describe("resolveMonitorThresholds (config overrides)", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("honours custom thresholds from config.yaml's monitor: section", () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: {
          anomaly_multiplier: 5,
          anomaly_absolute_threshold: 1,
          remaining_drop_pct_threshold: 10,
        },
      },
      home,
    );
    const config = readConfig(home);
    const thresholds = resolveMonitorThresholds(config);
    expect(thresholds.anomalyMultiplier).toBe(5);
    expect(thresholds.anomalyAbsoluteThreshold).toBe(1);
    expect(thresholds.remainingDropPctThreshold).toBe(10);

    // A 15% remaining drop would NOT alert under the default 50% threshold,
    // but DOES alert once the config lowers it to 10%.
    const verdict = detectAnomaly(
      usage({ used: 0, remaining: 85, unit: "requests" }),
      usage({ used: 0, remaining: 100, unit: "requests" }),
      ledgerStats(0),
      thresholds,
    );
    expect(verdict.isAnomaly).toBe(true);
  });

  it("ignores non-finite thresholds in config.yaml (e.g. strings) and falls back to defaults", () => {
    const raw = {
      email: "dev@example.test",
      backend: "file",
      created: "2026-11-01T00:00:00.000Z",
      monitor: {
        anomaly_multiplier: "high",
        anomaly_absolute_threshold: "lots",
        remaining_drop_pct_threshold: "half",
      },
    };
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(configPath(home), YAML.stringify(raw));

    const config = readConfig(home);
    const thresholds = resolveMonitorThresholds(config);
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe("usage anomaly end-to-end (runMonitor)", () => {
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

  it("produces status usage_anomaly, exit code 78, and exactly ONE notification for 2 anomalous accounts", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "acct-one", vendor: "apify", secret: `${CANARY_KEY}-one` });
    await setupAccount(home, { name: "acct-two", vendor: "apify", secret: `${CANARY_KEY}-two` });

    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 10 } }));
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 10 } }));
    const baseline = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(baseline.accounts.every((a) => a.status === "ok")).toBe(true);

    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 5000 } }));
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 5000 } }));
    const notifier = new RecordingNotifier();
    const second = await runMonitor({
      home,
      apisFile,
      transport: transport.asTransport(),
      notifier,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    });

    expect(second.accounts.every((a) => a.status === "usage_anomaly")).toBe(true);
    expect(second.alertCount).toBe(2);
    expect(second.exitCode).toBe(EXIT.monitor_alert);
    expect(notifier.notifications).toHaveLength(1);
    expect(second.reportText).not.toContain(CANARY_KEY);
    expect(second.reportText).not.toContain(CANARY_KEY_SHAPED);
  });

  // ND-6 FINDING: detectAnomaly compares raw usage deltas week-over-week with
  // no notion of the checker's reported `period`. github's rate_limit counter
  // resets hourly (parseGithub sets unit "requests", period "hour"), so a
  // used=0 -> used=30 delta between two weekly runs is NOT an anomaly (the
  // hourly counter has reset dozens of times in between and 30 is nothing),
  // but the current code has no period-awareness and flags it anyway.
  it("does not raise a weekly usage_anomaly from an hourly-reset counter (github rate_limit)", async () => {
    const apisFile = writeApisFixture(home, [GITHUB_ENTRY]);
    await setupAccount(home, { name: "gh-main", vendor: "github", secret: `${CANARY_KEY}-gh` });

    const transport = new FakeTransport();
    transport.queue(
      "api.github.com",
      jsonResponse(200, { rate: { limit: 5000, remaining: 5000, used: 0 } }),
    );
    const baseline = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(baseline.accounts[0]?.status).toBe("ok");

    transport.queue(
      "api.github.com",
      jsonResponse(200, { rate: { limit: 5000, remaining: 4970, used: 30 } }),
    );
    const second = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    });

    expect(second.accounts[0]?.status).toBe("ok");
    expect(second.accounts[0]?.isAlert).toBe(false);
  });
});
