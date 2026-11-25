/**
 * `monitor.anomaly_multiplier` / `anomaly_absolute_threshold` /
 * `remaining_drop_pct_threshold` have a floor below which they would make
 * nearly any usage look anomalous (a multiplier of 0 makes the bound 0; a
 * negative remaining-drop threshold alerts on every run). A config typo like
 * that should not take the whole monitor down, so values below the floor
 * fall back to the safe default -- with a warning, so the typo does not go
 * unnoticed. See `src/monitor/thresholds.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { readConfig, writeConfig } from "../src/config.js";
import { upsertKey } from "../src/keys.js";
import { runMonitor } from "../src/monitor/run.js";
import {
  DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD,
  DEFAULT_ANOMALY_MULTIPLIER,
  DEFAULT_REMAINING_DROP_PCT_THRESHOLD,
  resolveMonitorThresholds,
} from "../src/monitor/thresholds.js";
import type { HttpTransport, TransportResponse } from "../src/monitor/types.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

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

describe("monitor threshold floor: resolveMonitorThresholds (unit)", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("anomaly_multiplier <= 0 falls back to the default, with a warning", () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: { anomaly_multiplier: 0 },
      },
      home,
    );
    const thresholds = resolveMonitorThresholds(readConfig(home));
    expect(thresholds.anomalyMultiplier).toBe(DEFAULT_ANOMALY_MULTIPLIER);
    expect(thresholds.warnings?.join(" ")).toContain("anomaly_multiplier");
  });

  it("a negative anomaly_absolute_threshold falls back to the default, with a warning", () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: { anomaly_absolute_threshold: -1 },
      },
      home,
    );
    const thresholds = resolveMonitorThresholds(readConfig(home));
    expect(thresholds.anomalyAbsoluteThreshold).toBe(DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD);
    expect(thresholds.warnings?.join(" ")).toContain("anomaly_absolute_threshold");
  });

  it("a negative remaining_drop_pct_threshold falls back to the default, with a warning", () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: { remaining_drop_pct_threshold: -5 },
      },
      home,
    );
    const thresholds = resolveMonitorThresholds(readConfig(home));
    expect(thresholds.remainingDropPctThreshold).toBe(DEFAULT_REMAINING_DROP_PCT_THRESHOLD);
    expect(thresholds.warnings?.join(" ")).toContain("remaining_drop_pct_threshold");
  });

  it("0 for anomaly_absolute_threshold and remaining_drop_pct_threshold falls back to the default", () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: { anomaly_absolute_threshold: 0, remaining_drop_pct_threshold: 0 },
      },
      home,
    );
    const thresholds = resolveMonitorThresholds(readConfig(home));
    expect(thresholds.anomalyAbsoluteThreshold).toBe(DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD);
    expect(thresholds.remainingDropPctThreshold).toBe(DEFAULT_REMAINING_DROP_PCT_THRESHOLD);
    expect(thresholds.warnings?.length).toBe(2);
  });

  it("a multiplier of exactly 1 (the floor) is honoured, not rejected", () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: { anomaly_multiplier: 1 },
      },
      home,
    );
    const thresholds = resolveMonitorThresholds(readConfig(home));
    expect(thresholds.anomalyMultiplier).toBe(1);
    expect(thresholds.warnings).toBeUndefined();
  });

  it("no monitor: section at all -> defaults, and no warnings key present", () => {
    writeConfig(
      { email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" },
      home,
    );
    const thresholds = resolveMonitorThresholds(readConfig(home));
    expect(thresholds).toEqual({
      anomalyMultiplier: DEFAULT_ANOMALY_MULTIPLIER,
      anomalyAbsoluteThreshold: DEFAULT_ANOMALY_ABSOLUTE_THRESHOLD,
      remainingDropPctThreshold: DEFAULT_REMAINING_DROP_PCT_THRESHOLD,
    });
  });
});

describe("monitor threshold floor: runMonitor end-to-end", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("anomaly_multiplier: 0 does not make every delta an alert, and the report explains why", async () => {
    writeConfig(
      {
        email: "dev@example.test",
        backend: "file",
        created: "2026-11-01T00:00:00.000Z",
        monitor: { anomaly_multiplier: 0 },
      },
      home,
    );
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-threshold-floor" });

    const transport: HttpTransport = async () => jsonResponse(200, { data: { monthlyUsageUsd: 1 } });
    const baseline = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(baseline.accounts[0]?.status).toBe("ok");

    const second = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: async () => jsonResponse(200, { data: { monthlyUsageUsd: 2 } }),
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    });

    // With the (dangerous) configured multiplier of 0 any positive delta
    // would alert; with the floor in place, a 1-unit delta against a
    // zero-call ledger stays within the default bound and does not alert.
    expect(second.accounts[0]?.status).toBe("ok");
    expect(second.reportText).toContain("anomaly_multiplier");
    expect(second.reportText).toContain("Warning:");
  });
});
