/**
 * The HARD RULE for ND-5, as a test: a vendor's key, a serpapi-style response
 * carrying `api_key`/`account_email`, and a defillama/semrush-style key
 * embedded in a URL PATH all have to be unfindable in the report file,
 * state.json, the notification body, stdout/stderr-equivalent returns, JSON
 * output, and any error message -- even though `monitor run` really did send
 * the key to a fake transport.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { writeConfig } from "../src/config.js";
import { upsertKey } from "../src/keys.js";
import type { Notification, Notifier } from "../src/notify.js";
import { monitorStatePath } from "../src/paths.js";
import { redactShapes } from "../src/redact.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { runMonitor } from "../src/monitor/run.js";
import type { HttpTransport, TransportResponse } from "../src/monitor/types.js";
import { makeHome, removeHome } from "./helpers/env.js";

const CANARY_KEY = "sk-test-FAKE-canary-REDACT-0xDEADFEED";
const CANARY_EMAIL = "canary-0xDEADFEED@example.test";
const FRAGMENT = "0xDEADFEED";

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

class RecordingNotifier implements Notifier {
  readonly id = "fake";
  notifications: Notification[] = [];
  async notify(notification: Notification): Promise<boolean> {
    this.notifications.push(notification);
    return true;
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

function writeApisFixture(home: string, entries: Record<string, unknown>[]): string {
  const file = path.join(home, "fixture-apis.yaml");
  fs.writeFileSync(file, YAML.stringify({ version: 1, entries }));
  return file;
}

async function setupAccount(home: string, name: string, vendor: string, secret: string): Promise<AccountMeta> {
  const store = openEntryStore(home);
  await store.putApiKey(name, secret);
  upsertKey(
    {
      alias: name,
      platform: vendor,
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
    name,
    vendor,
    registered: "2026-11-01",
    email_hint: "b**********@gmail.com",
    key_alias: name,
    login_entry: null,
    created: "2026-11-01T00:00:00.000Z",
    disabled: false,
    disabled_at: null,
  };
  upsertAccount(meta, home);
  return meta;
}

describe("monitor run never leaks a secret", () => {
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

  it("redacts a serpapi-style response carrying api_key and account_email", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({
        name: "serpapi",
        usage_api: {
          available: true,
          method: "GET",
          path: "https://serpapi.com/account.json",
          docs_url: "https://serpapi.com/account-api",
          limits: null,
          notes: null,
          checked_date: "2026-11-24",
        },
      }),
    ]);
    await setupAccount(home, "serpapi-main", "serpapi", CANARY_KEY);

    const transport: HttpTransport = async (url): Promise<TransportResponse> => {
      // The real serpapi account.json echoes the key and the account email.
      const body = {
        api_key: new URL(url).searchParams.get("api_key"),
        account_email: CANARY_EMAIL,
        this_month_usage: 5,
        plan_searches_left: 95,
        searches_per_month: 100,
      };
      return { status: 200, text: async () => JSON.stringify(body) };
    };

    const notifier = new RecordingNotifier();
    const result = await runMonitor({
      home,
      apisFile,
      notifier,
      transport,
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const stateText = fs.readFileSync(monitorStatePath(home), "utf8");
    const surfaces = [
      result.reportText,
      stateText,
      JSON.stringify(result),
      JSON.stringify(notifier.notifications),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY_KEY);
      expect(surface).not.toContain(CANARY_EMAIL);
      expect(surface).not.toContain(FRAGMENT);
    }
    // The call really did carry the key -- the key WAS sent, just never stored.
    expect(result.accounts[0]?.status).toBe("ok");
  });

  it("redacts the key from an upstream error message, even though it embeds the request URL", async () => {
    const apisFile = writeApisFixture(home, [
      apiEntry({
        name: "serpapi",
        usage_api: {
          available: true,
          method: "GET",
          path: "https://serpapi.com/account.json",
          docs_url: "https://serpapi.com/account-api",
          limits: null,
          notes: null,
          checked_date: "2026-11-24",
        },
      }),
    ]);
    await setupAccount(home, "serpapi-main", "serpapi", CANARY_KEY);

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
    const surfaces = [result.reportText, JSON.stringify(result)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY_KEY);
      expect(surface).not.toContain(FRAGMENT);
    }
  });
});

describe("generic URL-embedded-key redaction (shape layer)", () => {
  it("redacts a defillama-style key in a /usage/<key> path", () => {
    const text = "GET https://pro-api.llama.fi/usage/sk-test-FAKE-canary-llama-0001 -> 200";
    const redacted = redactShapes(text);
    expect(redacted).not.toContain("sk-test-FAKE-canary-llama-0001");
    expect(redacted).toContain("/usage/[redacted]");
  });

  it("redacts a semrush-style key in a /limits/key/<key> path", () => {
    const text = "https://api.semrush.com/analytics/v1/limits/key/sk-test-FAKE-canary-semrush-0001";
    const redacted = redactShapes(text);
    expect(redacted).not.toContain("sk-test-FAKE-canary-semrush-0001");
    expect(redacted).toContain("/limits/key/[redacted]");
  });

  it("leaves an ordinary /usage/monthly path (no key) alone", () => {
    const text = "https://api.apify.com/v2/users/me/usage/monthly";
    expect(redactShapes(text)).toBe(text);
  });
});
