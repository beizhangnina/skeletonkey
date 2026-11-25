/**
 * ND-6: keys only ever travel to the one official host each checker names in
 * `CHECKERS` (src/monitor/checkers.ts), over https, and never over a
 * cross-origin redirect. Every test except the "redirect" group stubs
 * `fetch` so nothing here ever reaches a real vendor; the redirect group
 * uses the real `fetch` (via `defaultTransport`) against two local
 * 127.0.0.1-only `node:http` servers, never a real vendor host.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { configPath, monitorStatePath } from "../src/paths.js";
import { writeConfig } from "../src/config.js";
import { upsertKey } from "../src/keys.js";
import { CHECKERS, defaultTransport } from "../src/monitor/checkers.js";
import { runMonitor } from "../src/monitor/run.js";
import type { HttpTransport, TransportInit, TransportResponse } from "../src/monitor/types.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const CANARY = `ND6CANARY${crypto.randomBytes(12).toString("hex")}`;
const CANARY_SERVICE = `ND6CANARYSVC${crypto.randomBytes(12).toString("hex")}`;

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
  options: { name: string; vendor: string; secret: string; serviceSecret?: string },
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
    disabled: false,
    disabled_at: null,
  };
  upsertAccount(meta, home);
  return meta;
}

/** Records every call; answers every call with a fixed, parseable response. */
class RecordingTransport {
  calls: { url: string; init?: TransportInit }[] = [];
  asTransport(): HttpTransport {
    return async (url, init) => {
      this.calls.push({ url, init });
      return jsonResponse(200, {});
    };
  }
}

/** Throws on any call: proves a scenario makes zero network calls. */
const refusingTransport: HttpTransport = async () => {
  throw new Error("refusingTransport: no call was supposed to happen");
};

describe("ND-6 egress (stubbed fetch, no real network)", () => {
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

  describe("every checker sends the key only to its own official host, over https", () => {
    let home: string;

    beforeEach(() => {
      home = makeHome();
      writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
    });

    afterEach(() => {
      removeHome(home);
    });

    it("all 6 first-wave checkers", async () => {
      const vendors: { name: string; vendor: string; path: string; needsService?: boolean }[] = [
        { name: "apify-main", vendor: "apify", path: "https://api.apify.com/v2/users/me/usage/monthly" },
        { name: "serpapi-main", vendor: "serpapi", path: "https://serpapi.com/account.json" },
        { name: "firecrawl-main", vendor: "firecrawl", path: "https://api.firecrawl.dev/v2/team/credit-usage" },
        {
          name: "apollo-main",
          vendor: "apollo",
          path: "https://api.apollo.io/api/v1/usage_stats/credit_usage_stats",
        },
        {
          name: "exa-main",
          vendor: "exa",
          path: "https://admin-api.exa.ai/team-management/credits",
          needsService: true,
        },
        { name: "github-main", vendor: "github", path: "https://api.github.com/rate_limit" },
      ];
      const apisFile = writeApisFixture(
        home,
        vendors.map((v) => apiEntry({ name: v.vendor, usage_api: usageApi({ path: v.path }) })),
      );
      for (const v of vendors) {
        await setupAccount(home, {
          name: v.name,
          vendor: v.vendor,
          secret: CANARY,
          ...(v.needsService ? { serviceSecret: CANARY_SERVICE } : {}),
        });
      }

      const recorder = new RecordingTransport();
      const result = await runMonitor({
        home,
        apisFile,
        notify: false,
        transport: recorder.asTransport(),
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      });

      expect(result.accounts.map((a) => a.status)).not.toContain("error");
      expect(recorder.calls).toHaveLength(vendors.length);

      const officialHosts = new Set(Object.values(CHECKERS).map((c) => c.host));
      let sawCanary = false;
      for (const call of recorder.calls) {
        const url = new URL(call.url);
        expect(url.protocol).toBe("https:");
        expect(officialHosts.has(url.host)).toBe(true);

        const haystack = [
          call.url,
          JSON.stringify(call.init?.headers ?? {}),
          call.init?.body ?? "",
        ].join(" ");
        if (haystack.includes(CANARY) || haystack.includes(CANARY_SERVICE)) sawCanary = true;
      }
      expect(sawCanary).toBe(true);
    });
  });

  describe("tampered index: usage_api.path host tricks are refused", () => {
    let home: string;

    beforeEach(() => {
      home = makeHome();
      writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
    });

    afterEach(() => {
      removeHome(home);
    });

    const REFUSED_PATHS = [
      ["different host entirely", "https://evil.test/v2/users/me/usage/monthly"],
      ["official host as a subdomain prefix trick", "https://api.apify.com.evil.test/v2/users/me/usage/monthly"],
      ["official host spoofed in a query string", "https://evil.test/?x=api.apify.com"],
      ["official host spoofed as URL userinfo", "https://api.apify.com@evil.test/"],
      ["official host spoofed as a URL fragment", "https://evil.test/path#api.apify.com"],
      ["not an absolute URL at all", "not-a-valid-url-string"],
    ] as const;

    it.each(REFUSED_PATHS)("%s -> refused, zero calls, no canary sent", async (_label, tamperedPath) => {
      const apisFile = writeApisFixture(home, [
        apiEntry({ name: "apify", usage_api: usageApi({ path: tamperedPath }) }),
      ]);
      await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY });

      const result = await runMonitor({
        home,
        apisFile,
        notify: false,
        transport: refusingTransport,
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      });

      expect(result.accounts[0]?.status).toBe("error");
      expect(result.accounts[0]?.isAlert).toBe(true);
    });

    it("uppercase host (https://API.APIFY.COM/...) is allowed, and only reaches the lowercase official host", async () => {
      const apisFile = writeApisFixture(home, [
        apiEntry({
          name: "apify",
          usage_api: usageApi({ path: "https://API.APIFY.COM/v2/users/me/usage/monthly" }),
        }),
      ]);
      await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY });

      const recorder = new RecordingTransport();
      const result = await runMonitor({
        home,
        apisFile,
        notify: false,
        transport: recorder.asTransport(),
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      });

      expect(result.accounts[0]?.status).not.toBe("error");
      expect(recorder.calls).toHaveLength(1);
      expect(new URL(recorder.calls[0]?.url ?? "").host).toBe("api.apify.com");
    });
  });

  describe("downgrade and port-injection attempts via the index", () => {
    let home: string;

    beforeEach(() => {
      home = makeHome();
      writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
    });

    afterEach(() => {
      removeHome(home);
    });

    // ND-6 FINDING: run.ts's host guard (`url.host.toLowerCase() !==
    // checker.host`) only ever checks the host; it never checks
    // `url.protocol`. A usage_api.path of `http://api.apify.com/...` (the
    // correct host, but cleartext) is NOT refused -- the account's key is
    // sent over plain HTTP.
    it("refuses to send the key over plain HTTP, even to the correct host", async () => {
      const apisFile = writeApisFixture(home, [
        apiEntry({
          name: "apify",
          usage_api: usageApi({ path: "http://api.apify.com/v2/users/me/usage/monthly" }),
        }),
      ]);
      await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY });

      const recorder = new RecordingTransport();
      const result = await runMonitor({
        home,
        apisFile,
        notify: false,
        transport: recorder.asTransport(),
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      });

      expect(recorder.calls).toHaveLength(0);
      expect(result.accounts[0]?.status).not.toBe("ok");
    });

    it("refuses a port-injected host (https://api.apify.com:8443/...)", async () => {
      const apisFile = writeApisFixture(home, [
        apiEntry({
          name: "apify",
          usage_api: usageApi({ path: "https://api.apify.com:8443/v2/users/me/usage/monthly" }),
        }),
      ]);
      await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY });

      const result = await runMonitor({
        home,
        apisFile,
        notify: false,
        transport: refusingTransport,
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      });

      expect(result.accounts[0]?.status).toBe("error");
      expect(result.accounts[0]?.isAlert).toBe(true);
    });
  });

  describe("config tampering does not redirect where keys go", () => {
    let home: string;

    beforeEach(() => {
      home = makeHome();
    });

    afterEach(() => {
      removeHome(home);
    });

    it("unexpected base_url / monitor.base_url keys in config.yaml are ignored", async () => {
      // A hand-edited config.yaml with keys the schema never defined.
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        configPath(home),
        YAML.stringify({
          email: "dev@example.test",
          backend: "file",
          created: "2026-11-01T00:00:00.000Z",
          base_url: "https://evil.test",
          monitor: { base_url: "https://evil.test", anomaly_multiplier: 5 },
        }),
      );

      const apisFile = writeApisFixture(home, [APIFY_ENTRY_FOR_CONFIG_TEST]);
      await setupAccount(home, { name: "apify-main", vendor: "apify", secret: CANARY });

      const recorder = new RecordingTransport();
      const result = await runMonitor({
        home,
        apisFile,
        notify: false,
        transport: recorder.asTransport(),
        now: () => new Date("2026-11-01T00:00:00.000Z"),
      });

      expect(result.accounts[0]?.status).not.toBe("error");
      expect(recorder.calls).toHaveLength(1);
      expect(new URL(recorder.calls[0]?.url ?? "").host).toBe("api.apify.com");
    });
  });
});

const APIFY_ENTRY_FOR_CONFIG_TEST = {
  name: "apify",
  url: "https://example.test/docs",
  access_mode: "own-account",
  min_topup: null,
  billing_unit: null,
  signup_automatable: null,
  tos_notes: null,
  source: null,
  checked_date: "2026-11-01",
  usage_api: {
    available: true,
    method: "GET",
    path: "https://api.apify.com/v2/users/me/usage/monthly",
    docs_url: "https://vendor.test/docs/usage",
    limits: null,
    notes: null,
    checked_date: "2026-11-24",
  },
};

/**
 * Cross-origin redirect (PM decision after 577a64f: a cross-host redirect is a
 * hard `error`, and whatever the other host answers is never parsed as usage).
 *
 * Two local 127.0.0.1-only servers, real `fetch` via `defaultTransport`:
 * - server A plays the vendor's official host. The run uses the real
 *   `runMonitor` with the official `usage_api.path`; a thin transport wrapper
 *   rewrites only the official origin to server A, then hands off to the real
 *   `defaultTransport`, so redirect handling is exactly production's.
 * - server A answers every request with a 302 to server B (a different
 *   origin: `localhost:<portB>`), the "attacker".
 * - server B answers with a body that IS a valid usage payload for the vendor,
 *   so if the run parsed it, usage would come back non-null.
 *
 * For each of the 6 checkers this asserts: status `error` (an alert), no usage
 * data, no `usage_anomaly`, exit code 78, and server B either got no request or
 * got one carrying the key nowhere (URL incl. URL-encoded form, any header such
 * as Authorization / x-api-key, or body). No real vendor is contacted.
 */
const REDIRECT_VENDORS: {
  vendor: string;
  path: string;
  method: string;
  /** A body server B returns that this vendor's parser WOULD accept as usage. */
  usageBody: unknown;
}[] = [
  {
    vendor: "apify",
    path: "https://api.apify.com/v2/users/me/usage/monthly",
    method: "GET",
    usageBody: { data: { monthlyUsageUsd: 999, usageCycle: { startAt: "2026-11-01", endAt: "2026-12-01" } } },
  },
  {
    vendor: "serpapi",
    path: "https://serpapi.com/account.json",
    method: "GET",
    usageBody: { this_month_usage: 999, searches_per_month: 1000, plan_searches_left: 1 },
  },
  {
    vendor: "firecrawl",
    path: "https://api.firecrawl.dev/v2/team/credit-usage",
    method: "GET",
    usageBody: { data: { remainingCredits: 1, planCredits: 1000 } },
  },
  {
    vendor: "apollo",
    path: "https://api.apollo.io/api/v1/usage_stats/credit_usage_stats",
    method: "POST",
    usageBody: { used_credits: 999, available_credits: 1 },
  },
  {
    vendor: "exa",
    path: "https://admin-api.exa.ai/team-management/credits",
    method: "GET",
    usageBody: { credits_used: 999, credits_limit: 1000, credits_remaining: 1 },
  },
  {
    vendor: "github",
    path: "https://api.github.com/rate_limit",
    method: "GET",
    usageBody: { rate: { limit: 5000, remaining: 1, used: 4999 } },
  },
];

describe("ND-6 egress: cross-host redirect is a hard error (real fetch, 127.0.0.1 only)", () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let portA: number;
  let portB: number;
  /** What server B answers with; set per test to the vendor's valid usage body. */
  let serverBBody = "{}";
  /** Server A's mode: cross-origin 302 to B, or same-origin 302 to its own /final. */
  let serverAMode: "cross" | "same" = "cross";
  let serverBRequests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let home: string;
  let savedFetch: typeof globalThis.fetch;
  let foreignFetch = false;

  beforeAll(async () => {
    serverB = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        serverBRequests.push({ url: req.url ?? "", headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(serverBBody);
      });
    });
    await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve));
    portB = (serverB.address() as AddressInfo).port;

    serverA = http.createServer((req, res) => {
      req.resume();
      if (serverAMode === "same" && (req.url ?? "").startsWith("/final")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(serverBBody);
        return;
      }
      const location =
        serverAMode === "cross" ? `http://localhost:${portB}/steal` : `http://127.0.0.1:${portA}/final`;
      res.writeHead(302, { Location: location });
      res.end();
    });
    await new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve));
    portA = (serverA.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => serverA.close(() => resolve()));
    await new Promise<void>((resolve) => serverB.close(() => resolve()));
  });

  beforeEach(() => {
    serverBRequests = [];
    serverAMode = "cross";
    serverBBody = "{}";
    foreignFetch = false;
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" }, home);
    // Real fetch, but only to our two local servers: anything else fails loudly.
    savedFetch = globalThis.fetch;
    const realFetch = savedFetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
        foreignFetch = true;
        throw new Error(`non-local fetch forbidden in tests: ${target.host}`);
      }
      return realFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    removeHome(home);
    expect(foreignFetch).toBe(false);
  });

  /** Every place a key could ride: URL (raw + URL-encoded), every header, the body. */
  function keyReachedServerB(secrets: string[]): string[] {
    const hits: string[] = [];
    for (const req of serverBRequests) {
      for (const secret of secrets) {
        const forms = [secret, encodeURIComponent(secret)];
        if (forms.some((form) => req.url.includes(form))) hits.push(`url:${req.url}`);
        for (const [name, value] of Object.entries(req.headers)) {
          const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
          if (forms.some((form) => text.includes(form))) hits.push(`header:${name}`);
        }
        if (forms.some((form) => req.body.includes(form))) hits.push("body");
      }
    }
    return hits;
  }

  /** Official origin -> server A; everything else (i.e. redirect targets) untouched. */
  function viaServerA(officialPath: string): HttpTransport {
    const officialOrigin = new URL(officialPath).origin;
    return async (url, init) => {
      const rewritten = url.startsWith(officialOrigin)
        ? `http://127.0.0.1:${portA}${url.slice(officialOrigin.length)}`
        : url;
      return defaultTransport(rewritten, init);
    };
  }

  async function runFor(spec: (typeof REDIRECT_VENDORS)[number]) {
    const key = `${CANARY}-${spec.vendor}`;
    const serviceKey = `${CANARY_SERVICE}-${spec.vendor}`;
    const apisFile = writeApisFixture(home, [
      apiEntry({ name: spec.vendor, usage_api: usageApi({ path: spec.path, method: spec.method }) }),
    ]);
    await setupAccount(home, {
      name: `${spec.vendor}-main`,
      vendor: spec.vendor,
      secret: key,
      ...(spec.vendor === "exa" ? { serviceSecret: serviceKey } : {}),
    });
    serverBBody = JSON.stringify(spec.usageBody);
    const result = await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: viaServerA(spec.path),
      now: () => new Date("2026-11-24T12:00:00.000Z"),
    });
    return { result, secrets: [key, serviceKey] };
  }

  for (const spec of REDIRECT_VENDORS) {
    it(`${spec.vendor}: cross-host 302 -> server B gets no request, or one without the key (URL/headers/body)`, async () => {
      const { secrets } = await runFor(spec);
      expect(keyReachedServerB(secrets)).toEqual([]);
    });

    // PM decision after 577a64f: cross-host redirect = hard error, never parsed as usage.
    it(`${spec.vendor}: cross-host 302 -> status error (alert), usage not parsed, no usage_anomaly`, async () => {
      const { result } = await runFor(spec);
      const account = result.accounts[0];
      expect(account?.status).toBe("error");
      expect(account?.isAlert).toBe(true);
      expect(result.exitCode).toBe(78);
      expect(account?.usage).toBeNull();
      expect(result.accounts.some((a) => a.status === "usage_anomaly")).toBe(false);
      expect(result.reportText).not.toMatch(/used=999|used=4999|remaining=1\b/);
      const state = JSON.parse(fs.readFileSync(monitorStatePath(home), "utf8")) as {
        accounts: Record<string, { last_usage: unknown }>;
      };
      expect(state.accounts[`${spec.vendor}-main`]?.last_usage ?? null).toBeNull();
    });
  }

  it("same-origin redirect on the official host is still followed and parsed (no over-blocking)", async () => {
    serverAMode = "same";
    const { result } = await runFor(REDIRECT_VENDORS[0]!);
    expect(result.accounts[0]?.status).toBe("ok");
    expect(result.accounts[0]?.usage?.used).toBe(999);
    expect(serverBRequests).toHaveLength(0);
  });
});
