/**
 * `skeletonkey monitor run` (ND-5): classification, state, the weekly report,
 * and the one OS notification. No test here ever reaches the network -- every
 * call goes through a fake `HttpTransport`, and a test that expects zero
 * calls asserts it by making the fake throw.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountMeta } from "../src/accounts/store.js";
import { upsertAccount } from "../src/accounts/store.js";
import { writeConfig } from "../src/config.js";
import { EXIT } from "../src/exit-codes.js";
import { upsertKey } from "../src/keys.js";
import { openLedger } from "../src/ledger.js";
import type { Notification, Notifier } from "../src/notify.js";
import { monitorReportsDir, monitorStatePath } from "../src/paths.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { monitorInstallHelpText } from "../src/monitor/install-help.js";
import { findLatestReport } from "../src/monitor/latest.js";
import { runMonitor, type MonitorRunOptions } from "../src/monitor/run.js";
import { readMonitorState } from "../src/monitor/state.js";
import type { HttpTransport, TransportResponse } from "../src/monitor/types.js";
import { makeHome, removeHome } from "./helpers/env.js";

function jsonResponse(status: number, body: unknown): TransportResponse {
  return { status, text: async () => JSON.stringify(body) };
}

/**
 * Belt-and-suspenders, on top of the fake `HttpTransport` every test here
 * passes explicitly: even if some path ever fell back to the real `fetch`,
 * it would hit this and fail loudly instead of making a real network call.
 */
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

/** A fake transport that records every call and answers from a queue, by host. */
class FakeTransport {
  calls: { url: string; init?: { method?: string; headers?: Record<string, string> } }[] = [];
  private queues = new Map<string, TransportResponse[]>();

  queue(host: string, response: TransportResponse): void {
    const list = this.queues.get(host) ?? [];
    list.push(response);
    this.queues.set(host, list);
  }

  asTransport(): HttpTransport {
    return async (url, init) => {
      this.calls.push({ url, init });
      const host = new URL(url).host;
      const list = this.queues.get(host);
      if (list === undefined || list.length === 0) {
        throw new Error(`FakeTransport: no queued response for ${host}`);
      }
      return list.shift() as TransportResponse;
    };
  }
}

/** Throws on any call: proves a scenario makes zero network calls. */
const refusingTransport: HttpTransport = async () => {
  throw new Error("refusingTransport: no call was supposed to happen");
};

class RecordingNotifier implements Notifier {
  readonly id = "fake";
  notifications: Notification[] = [];
  constructor(private readonly outcome = true) {}
  async notify(notification: Notification): Promise<boolean> {
    this.notifications.push(notification);
    return this.outcome;
  }
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

/** Writes a fixture apis.yaml with the given entries and returns its path. */
function writeApisFixture(home: string, entries: Record<string, unknown>[]): string {
  const file = path.join(home, "fixture-apis.yaml");
  fs.writeFileSync(file, YAML.stringify({ version: 1, entries }));
  return file;
}

const APIFY_ENTRY = apiEntry({
  name: "apify",
  usage_api: usageApi({ path: "https://api.apify.com/v2/users/me/usage/monthly" }),
});
const GITHUB_ENTRY = apiEntry({
  name: "github",
  usage_api: usageApi({ path: "https://api.github.com/rate_limit" }),
});
const SERPAPI_ENTRY = apiEntry({
  name: "serpapi",
  usage_api: usageApi({ path: "https://serpapi.com/account.json" }),
});
const EXA_ENTRY = apiEntry({
  name: "exa",
  usage_api: usageApi({ path: "https://admin-api.exa.ai/team-management/credits" }),
});
const NO_USAGE_API_ENTRY = apiEntry({
  name: "acme-noapi",
  usage_api: usageApi({
    available: null,
    method: null,
    path: null,
    notes: "not verified in official docs",
  }),
});
const HOST_MISMATCH_ENTRY = apiEntry({
  name: "apify",
  usage_api: usageApi({ path: "https://evil.test/v2/users/me/usage/monthly" }),
});

async function setupAccount(
  home: string,
  options: { name: string; vendor: string; secret: string; serviceSecret?: string; disabled?: boolean },
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
  if (options.serviceSecret !== undefined) {
    const serviceAlias = `${options.name}-service`;
    await store.putApiKey(serviceAlias, options.serviceSecret);
    upsertKey(
      {
        alias: serviceAlias,
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
    key_alias: options.name,
    login_entry: null,
    created: "2026-11-01T00:00:00.000Z",
    disabled: options.disabled ?? false,
    disabled_at: null,
  };
  upsertAccount(meta, home);
  return meta;
}

describe("skeletonkey monitor run", () => {
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

  it("flags a usage anomaly: official usage jumped far beyond what the ledger implies", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-apify-0001" });

    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 10 } }));
    const t0 = new Date("2026-11-01T00:00:00.000Z");
    const baseline = await runMonitor({
      home,
      apisFile,
      offline: false,
      notify: false,
      transport: transport.asTransport(),
      now: () => t0,
    });
    expect(baseline.accounts[0]?.status).toBe("ok");
    expect(baseline.exitCode).toBe(EXIT.ok);

    // A couple of ledger calls in the window, implying only a tiny bit of spend.
    const ledger = openLedger(home);
    ledger.record({
      alias: "apify-main",
      domain: "api.apify.com",
      status: 200,
      bytes: 10,
      cost: 0.5,
      timestamp: "2026-11-03T00:00:00.000Z",
    });
    ledger.record({
      alias: "apify-main",
      domain: "api.apify.com",
      status: 200,
      bytes: 10,
      cost: 0.5,
      timestamp: "2026-11-04T00:00:00.000Z",
    });
    ledger.close();

    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 500 } }));
    const notifier = new RecordingNotifier();
    const t1 = new Date("2026-11-08T00:00:00.000Z");
    const second = await runMonitor({
      home,
      apisFile,
      transport: transport.asTransport(),
      notifier,
      now: () => t1,
    });

    expect(second.accounts[0]?.status).toBe("usage_anomaly");
    expect(second.accounts[0]?.isAlert).toBe(true);
    expect(second.alertCount).toBe(1);
    expect(second.exitCode).toBe(EXIT.monitor_alert);
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]?.title).toContain("1 issue");
    expect(second.notified).toBe(true);
  });

  it("flags a sudden 401 after the previous run was ok", async () => {
    const apisFile = writeApisFixture(home, [GITHUB_ENTRY]);
    await setupAccount(home, { name: "github-main", vendor: "github", secret: "ghp_FAKE0001" });

    const transport = new FakeTransport();
    transport.queue("api.github.com", jsonResponse(200, { rate: { limit: 5000, remaining: 4990, used: 10 } }));
    const baseline = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(baseline.accounts[0]?.status).toBe("ok");

    transport.queue("api.github.com", jsonResponse(401, { message: "Bad credentials" }));
    const notifier = new RecordingNotifier();
    const second = await runMonitor({
      home,
      apisFile,
      transport: transport.asTransport(),
      notifier,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    });

    expect(second.accounts[0]?.status).toBe("invalid_key");
    expect(second.accounts[0]?.isAlert).toBe(true);
    expect(second.accounts[0]?.reasons.join(" ")).toContain("sudden");
    expect(second.exitCode).toBe(EXIT.monitor_alert);
    expect(notifier.notifications).toHaveLength(1);
  });

  it("reports 'cannot auto-compare' for a vendor with no verified usage API, and raises no alert", async () => {
    const apisFile = writeApisFixture(home, [NO_USAGE_API_ENTRY]);
    await setupAccount(home, { name: "acme-main", vendor: "acme-noapi", secret: "sk-test-FAKE-acme" });

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
    expect(result.reportText).toContain("cannot auto-compare");
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("skips a disabled account and reports it as skipped", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, {
      name: "apify-off",
      vendor: "apify",
      secret: "sk-test-FAKE-off",
      disabled: true,
    });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("skipped");
    expect(result.accounts[0]?.isAlert).toBe(false);
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("--offline makes zero transport calls and carries the last known status forward", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-apify-0002" });

    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 3 } }));
    await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const offlineResult = await runMonitor({
      home,
      apisFile,
      notify: false,
      offline: true,
      transport: refusingTransport,
      now: () => new Date("2026-11-08T00:00:00.000Z"),
    });

    expect(offlineResult.accounts[0]?.status).toBe("ok");
    expect(offlineResult.accounts[0]?.reasons.join(" ")).toContain("offline");
    expect(offlineResult.exitCode).toBe(EXIT.ok);
  });

  it("refuses to send a key when usage_api.path's host does not match the official host", async () => {
    const apisFile = writeApisFixture(home, [HOST_MISMATCH_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-apify-0003" });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("error");
    expect(result.accounts[0]?.isAlert).toBe(true);
    expect(result.accounts[0]?.reasons.join(" ")).toContain("does not match the official host");
    expect(result.exitCode).toBe(EXIT.monitor_alert);
  });

  it("skips Exa with a clear note when no <key_alias>-service vault entry exists", async () => {
    const apisFile = writeApisFixture(home, [EXA_ENTRY]);
    await setupAccount(home, { name: "exa-main", vendor: "exa", secret: "sk-test-FAKE-exa" });

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("no_usage_api");
    expect(result.accounts[0]?.reasons.join(" ")).toContain("requires Team Management service key");
  });

  it("calls Exa with the service key when the <key_alias>-service entry exists", async () => {
    const apisFile = writeApisFixture(home, [EXA_ENTRY]);
    await setupAccount(home, {
      name: "exa-main",
      vendor: "exa",
      secret: "sk-test-FAKE-exa-normal",
      serviceSecret: "sk-test-FAKE-exa-SERVICE",
    });

    const transport = new FakeTransport();
    transport.queue(
      "admin-api.exa.ai",
      jsonResponse(200, { credits_used: 10, credits_remaining: 90, credits_limit: 100 }),
    );
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts[0]?.status).toBe("ok");
    expect(result.accounts[0]?.usage?.remaining).toBe(90);
    expect(transport.calls[0]?.init?.headers?.["x-api-key"]).toBe("sk-test-FAKE-exa-SERVICE");
  });

  it("writes a 0600 state.json and a 0600 report, and state.json never names the secret", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    const CANARY = "sk-test-FAKE-canary-0xBADC0DE";
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY });

    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 1 } }));
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const stateFile = monitorStatePath(home);
    const stateText = fs.readFileSync(stateFile, "utf8");
    expect(stateText).not.toContain(CANARY);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(result.reportPath).mode & 0o777).toBe(0o600);
    expect(result.reportText).not.toContain(CANARY);

    const state = readMonitorState(home);
    expect(state.accounts["apify-main"]?.last_status).toBe("ok");
  });

  it("monitor report finds the latest report written by monitor run", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-latest" });
    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 1 } }));
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const latest = findLatestReport(home);
    expect(latest).not.toBeNull();
    expect(latest?.path).toBe(result.reportPath);
    expect(latest?.content).toBe(result.reportText);
  });

  it("monitor report reports nothing found when no run has happened yet", () => {
    expect(findLatestReport(home)).toBeNull();
  });

  it("--report-dir writes the report to a custom directory", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-dir" });
    const customDir = path.join(home, "custom-reports");
    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 1 } }));
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      reportDir: customDir,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.reportPath.startsWith(customDir)).toBe(true);
    expect(fs.existsSync(result.reportPath)).toBe(true);
    // The default reports dir was never created.
    expect(fs.existsSync(monitorReportsDir(home))).toBe(false);
  });

  it("--account limits the run to one account", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY, GITHUB_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-a" });
    await setupAccount(home, { name: "github-main", vendor: "github", secret: "sk-test-FAKE-b" });

    const result = await runMonitor({
      home,
      apisFile,
      account: "apify-main",
      notify: false,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.name).toBe("apify-main");
  });

  it("--no-notify sends no notification even when an alert is raised", async () => {
    const apisFile = writeApisFixture(home, [HOST_MISMATCH_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-c" });
    const notifier = new RecordingNotifier();

    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      notifier,
      transport: refusingTransport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.alertCount).toBe(1);
    expect(result.notified).toBe(false);
    expect(notifier.notifications).toHaveLength(0);
    expect(result.reportText).toContain("skipped (--no-notify)");
  });

  it("every account's report section states the login/billing limitation honestly", async () => {
    const apisFile = writeApisFixture(home, [APIFY_ENTRY]);
    await setupAccount(home, { name: "apify-main", vendor: "apify", secret: "sk-test-FAKE-d" });
    const transport = new FakeTransport();
    transport.queue("api.apify.com", jsonResponse(200, { data: { monthlyUsageUsd: 1 } }));
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: transport.asTransport(),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    expect(result.reportText).toContain("login/billing anomaly check: not available via official API");
  });
});

describe("skeletonkey monitor install-help", () => {
  it("prints example schedules without touching the filesystem", () => {
    const text = monitorInstallHelpText();
    expect(text).toContain("cron");
    expect(text).toContain("systemd");
    expect(text).toContain("launchd");
    expect(text).toContain("never installs");
  });
});
