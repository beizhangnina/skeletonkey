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
import { configPath } from "../src/paths.js";
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
 * Cross-origin redirect: two local 127.0.0.1 servers. Server A ("official")
 * answers every request with a 302 to server B ("attacker"), a different
 * origin (different port). Calls `CHECKERS[vendor].run` directly with the
 * real `defaultTransport` (real `fetch`, local-only) so the test observes
 * exactly what `fetch` itself does on a cross-origin redirect -- no stub.
 */
describe("ND-6 egress: cross-origin redirect (real fetch, 127.0.0.1 only)", () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let portA: number;
  let portB: number;
  let serverBRequests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    serverB = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        serverBRequests.push({ url: req.url ?? "", headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve));
    portB = (serverB.address() as AddressInfo).port;

    serverA = http.createServer((req, res) => {
      req.resume();
      res.writeHead(302, { Location: `http://127.0.0.1:${portB}/steal` });
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
  });

  function canaryLeaked(): boolean {
    return serverBRequests.some((req) => {
      const haystack = [req.url, JSON.stringify(req.headers), req.body].join(" ");
      return haystack.includes(CANARY) || haystack.includes(CANARY_SERVICE);
    });
  }

  it("apify: Authorization: Bearer header is not forwarded cross-origin", async () => {
    await CHECKERS["apify"]?.run({
      url: `http://127.0.0.1:${portA}/v2/users/me/usage/monthly`,
      method: "GET",
      key: CANARY,
      transport: defaultTransport,
    });
    expect(serverBRequests.length).toBeGreaterThan(0);
    expect(canaryLeaked()).toBe(false);
  });

  it("firecrawl: Authorization: Bearer header is not forwarded cross-origin", async () => {
    await CHECKERS["firecrawl"]?.run({
      url: `http://127.0.0.1:${portA}/v2/team/credit-usage`,
      method: "GET",
      key: CANARY,
      transport: defaultTransport,
    });
    expect(serverBRequests.length).toBeGreaterThan(0);
    expect(canaryLeaked()).toBe(false);
  });

  it("github: Authorization: Bearer header is not forwarded cross-origin", async () => {
    await CHECKERS["github"]?.run({
      url: `http://127.0.0.1:${portA}/rate_limit`,
      method: "GET",
      key: CANARY,
      transport: defaultTransport,
    });
    expect(serverBRequests.length).toBeGreaterThan(0);
    expect(canaryLeaked()).toBe(false);
  });

  it("serpapi: the key is a query param on the ORIGINAL url, so it cannot reach server B's different path", async () => {
    await CHECKERS["serpapi"]?.run({
      url: `http://127.0.0.1:${portA}/account.json`,
      method: "GET",
      key: CANARY,
      transport: defaultTransport,
    });
    expect(serverBRequests.length).toBeGreaterThan(0);
    expect(canaryLeaked()).toBe(false);
  });

  // ND-6 FINDING: apollo's x-api-key header is a custom header, not
  // `Authorization` -- the Fetch spec's cross-origin-redirect header
  // stripping only names `Authorization`/`Proxy-Authorization`/`Cookie`/
  // `WWW-Authenticate`. If this fails, `fetch` forwarded x-api-key straight
  // to the attacker's server on the 302.
  it("apollo: x-api-key header is not forwarded cross-origin", async () => {
    await CHECKERS["apollo"]?.run({
      url: `http://127.0.0.1:${portA}/api/v1/usage_stats/credit_usage_stats`,
      method: "POST",
      key: CANARY,
      transport: defaultTransport,
    });
    expect(serverBRequests.length).toBeGreaterThan(0);
    expect(canaryLeaked()).toBe(false);
  });

  // ND-6 FINDING: same as apollo -- exa's service key rides on a custom
  // x-api-key header, which the Fetch spec does not strip on a cross-origin
  // redirect.
  it("exa: x-api-key (service key) header is not forwarded cross-origin", async () => {
    await CHECKERS["exa"]?.run({
      url: `http://127.0.0.1:${portA}/team-management/credits`,
      method: "GET",
      key: "unused-main-key",
      serviceKey: CANARY_SERVICE,
      transport: defaultTransport,
    });
    expect(serverBRequests.length).toBeGreaterThan(0);
    expect(canaryLeaked()).toBe(false);
  });
});
