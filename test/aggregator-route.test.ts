/**
 * Aggregator fallback execution (D14, the second approval).
 *
 * Everything here runs against a **fake aggregator HTTP server** on loopback
 * and a temp SKELETONKEY_HOME: no real catalog is contacted, no real vault is
 * read, and the "aggregator key" is a fake secret this file made up.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGGREGATOR_ENDPOINTS,
  aggregatorCallUrl,
  aggregatorDomain,
  aggregatorEndpoint,
  providerSlug,
  selectAggregator,
  signupInstructions,
} from "../src/aggregators.js";
import { openLedger } from "../src/ledger.js";
import { NoopNotifier } from "../src/notify.js";
import { RunnerClient } from "../src/runner/client.js";
import { startRunner, type RunnerHandle } from "../src/runner/server.js";
import type { KeyMeta } from "../src/types.js";
import { initWithKey, makeHome, removeHome, runCli } from "./helpers/env.js";

/** The vendor the agent wanted, and the two catalogs that resell it. */
const VENDOR = "fake-vendor";
const VENDOR_DOMAIN = "api.fakevendor.test";
/** Not a real key: 24 made-up characters that must never appear anywhere. */
const AGG_SECRET = "agg-test-FAKE-0xC0FFEE-01";
const OTHER_SECRET = "agg-test-FAKE-0xDECAF-02";

interface FakeCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface FakeAggregator {
  /** Base URL to hand the runner as a local override. */
  url: string;
  calls: FakeCall[];
  /** What the next call gets back. Defaults to a 200 with a small payload. */
  reply(next: FakeReply): void;
  close(): Promise<void>;
}

/** A stand-in for one aggregator's call surface. Answers anything POSTed. */
async function startFakeAggregator(hostLabel = "127.0.0.1"): Promise<FakeAggregator> {
  const calls: FakeCall[] = [];
  let next: FakeReply = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
      } catch {
        body = { unparsed: raw };
      }
      calls.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      const status = next.status ?? 200;
      const payload =
        next.body ?? { ok: true, provider: body["provider"] ?? null, data: { rows: 3 } };
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      res.writeHead(status, {
        "content-type": "application/json",
        ...(next.headers ?? {}),
      });
      res.end(text);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostLabel, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${hostLabel}:${port}`,
    calls,
    reply(reply: FakeReply) {
      next = reply;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * An index fixture where direct access needs a monthly subscription, so the
 * route is an aggregator: glasser at $0.004 and monid at $0.01, both verified.
 */
function writeFixture(home: string): string {
  const file = path.join(home, "fixture-apis.yaml");
  fs.writeFileSync(
    file,
    [
      "version: 1",
      "entries:",
      `  - name: ${VENDOR}`,
      "    url: https://fakevendor.test/docs",
      "    access_mode: own-account",
      "    min_topup: null",
      "    billing_unit: per request",
      "    signup_automatable: false",
      "    tos_notes: null",
      "    source: https://fakevendor.test/pricing",
      "    checked_date: 2026-10-20",
      `    domain: ${VENDOR_DOMAIN}`,
      "    billing:",
      "      model: subscription",
      "      verified_url: https://fakevendor.test/pricing",
      "      verified_date: 2026-10-20",
      "    aggregators:",
      "      - name: monid",
      "        carries: true",
      "        per_call_price: 0.01",
      "        price_verified_url: https://api.monid.ai/public/v1/providers",
      "      - name: glasser",
      "        carries: true",
      "        per_call_price: 0.004",
      "        price_verified_url: https://api.glasser.ai/public/catalog",
      "",
    ].join("\n"),
  );
  return file;
}

interface Started {
  home: string;
  runner: RunnerHandle;
  client: RunnerClient;
  logs: string[];
}

async function startRunnerFor(
  home: string,
  baseUrls: Record<string, string>,
): Promise<Started> {
  const logs: string[] = [];
  const runner = await startRunner({
    home,
    port: 0,
    notifier: new NoopNotifier(),
    apisFile: writeFixture(home),
    apiShardDirs: [],
    userIndexFile: null,
    popupTimeoutMs: 0,
    aggregatorBaseUrls: baseUrls,
    logger: (line) => logs.push(line),
  });
  return { home, runner, logs, client: new RunnerClient(runner.url, runner.token) };
}

async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: await response.text() };
}

/** Stores an aggregator key the way a human would: `skeletonkey add`. */
async function addKey(
  home: string,
  alias: string,
  domain: string,
  secret: string,
): Promise<void> {
  const result = await runCli(
    home,
    ["add", alias, "--platform", alias, "--domain", domain, "--header", "Authorization", "--format", "Bearer {key}"],
    secret,
  );
  if (result.code !== 0) throw new Error(`add ${alias} failed: ${result.stderr}`);
}

/**
 * The whole flow an agent and a human go through: access approval (signup ends
 * in a handoff), then the second approval for the aggregator route.
 */
async function approveThroughToRoute(
  started: Started,
  caps: { global: string; vendor: string },
  fallback = { aggregator: "glasser", price: 0.004 },
): Promise<{ accessId: string; routeId: string }> {
  const created = await started.client.createRequest({
    vendor: VENDOR,
    domain: VENDOR_DOMAIN,
    purpose: "enrich 3 companies",
    est_budget_usd: 1,
    fallback_aggregator: fallback.aggregator,
    fallback_price_usd: fallback.price,
  });
  const access = started.runner.requests.get(created.request_id);
  await postForm(created.approval_url ?? "", {
    page_token: access?.page_token ?? "",
    action: "approve",
    global_cap: caps.global,
    vendor_cap: caps.vendor,
  });
  const routeId = started.runner.requests.get(created.request_id)?.follow_up_id ?? "";
  expect(routeId).toMatch(/^req_/);
  const route = started.runner.requests.get(routeId);
  const decided = await postForm(`${started.runner.url}/approve/${routeId}`, {
    page_token: route?.page_token ?? "",
    action: "approve",
  });
  expect(decided.status).toBe(200);
  return { accessId: created.request_id, routeId };
}

describe("the aggregator catalog", () => {
  it("is fiat only, with a signup URL and a key domain for every entry", () => {
    for (const endpoint of Object.values(AGGREGATOR_ENDPOINTS)) {
      expect(endpoint.rail).toBe("fiat");
      expect(endpoint.signup_url).toMatch(/^https:\/\//);
      expect(aggregatorDomain(endpoint)).not.toBe("");
      expect(endpoint.auth_format).toContain("{key}");
    }
  });

  it("resolves a name case-insensitively, and refuses one it does not know", () => {
    expect(aggregatorEndpoint("Monid")?.name).toBe("monid");
    expect(aggregatorEndpoint("  GLASSER ")?.name).toBe("glasser");
    expect(aggregatorEndpoint("evil-aggregator.example")).toBeNull();
    expect(aggregatorEndpoint(null)).toBeNull();
  });

  it("takes a local base-URL override but keeps the catalog's signup URL", () => {
    const endpoint = aggregatorEndpoint("monid", { monid: "http://127.0.0.1:9/" });
    expect(endpoint?.base_url).toBe("http://127.0.0.1:9");
    expect(endpoint?.signup_url).toBe(AGGREGATOR_ENDPOINTS.monid.signup_url);
    expect(aggregatorCallUrl(endpoint!, "apollo")).toBe("http://127.0.0.1:9/v1/call/apollo");
  });

  it("slugs a provider from its domain, else from its name", () => {
    expect(providerSlug("example-apollo-contacts", "api.apollo.io")).toBe("apollo");
    expect(providerSlug("Voyage AI", "voyageai.com")).toBe("voyageai");
    expect(providerSlug("TikHub", null)).toBe("tikhub");
    expect(providerSlug("TikHub", "127.0.0.1")).toBe("tikhub");
  });
});

describe("choosing an aggregator", () => {
  const key = (alias: string, domain: string, disabled = false): KeyMeta => ({
    alias,
    platform: alias,
    domain,
    header: "Authorization",
    format: "Bearer {key}",
    created: "2026-10-01T00:00:00.000Z",
    last_used: null,
    disabled,
  });

  it("will not route through an aggregator with no comparable per-call price", async () => {
    const selection = await selectAggregator({
      entry: {
        name: VENDOR,
        url: null,
        access_mode: null,
        min_topup: null,
        billing_unit: null,
        signup_automatable: null,
        tos_notes: null,
        source: null,
        checked_date: null,
        aggregators: [{ name: "monid", carries: true, per_call_price: null, price_verified_url: null }],
      },
      keys: [key("monid", "api.monid.ai")],
      readSecret: async () => AGG_SECRET,
    });
    expect(selection.candidates).toHaveLength(0);
    expect(selection.chosen).toBeNull();
    expect(selection.notes.join(" ")).toMatch(/publishes no comparable per-call price/);
    expect(signupInstructions(selection.candidates).join(" ")).toMatch(
      /no aggregator route to configure/i,
    );
  });

  it("skips a disabled key and one the vault has no value for", async () => {
    const entry = {
      name: VENDOR,
      url: null,
      access_mode: null,
      min_topup: null,
      billing_unit: null,
      signup_automatable: null,
      tos_notes: null,
      source: null,
      checked_date: null,
      aggregators: [
        {
          name: "glasser" as const,
          carries: true,
          per_call_price: 0.004,
          price_verified_url: "https://api.glasser.ai/public/catalog",
        },
        {
          name: "monid" as const,
          carries: true,
          per_call_price: 0.01,
          price_verified_url: "https://api.monid.ai/public/v1/providers",
        },
      ],
    };
    const disabled = await selectAggregator({
      entry,
      keys: [key("glasser", "api.glasser.ai", true), key("monid", "api.monid.ai")],
      readSecret: async () => AGG_SECRET,
    });
    expect(disabled.chosen?.candidate.name).toBe("monid");
    expect(disabled.notes.join(" ")).toMatch(/disabled/);

    const empty = await selectAggregator({
      entry,
      keys: [key("glasser", "api.glasser.ai")],
      readSecret: async () => null,
    });
    expect(empty.chosen).toBeNull();
    expect(empty.notes.join(" ")).toMatch(/vault holds no value/);
    expect(signupInstructions(empty.candidates)[0]).toMatch(/glasser: sign up at https:\/\/glasser\.ai\//);
  });
});

describe("executing an approved aggregator route", () => {
  let home: string;
  let monid: FakeAggregator;
  let glasser: FakeAggregator;
  let started: Started;

  beforeEach(async () => {
    home = makeHome();
    // A home with a config, a vault and one unrelated key.
    await initWithKey(home, { alias: "unrelated", secret: "sk-test-FAKE-unrelated", domain: "api.unrelated.test" });
    monid = await startFakeAggregator("localhost");
    glasser = await startFakeAggregator("127.0.0.1");
    started = await startRunnerFor(home, { monid: monid.url, glasser: glasser.url });
  });

  afterEach(async () => {
    await started.runner.close();
    await monid.close();
    await glasser.close();
    removeHome(home);
  });

  it("routes through the cheapest CONFIGURED aggregator, with the key the agent never sees", async () => {
    // glasser is cheaper ($0.004) but no key is configured for its host, so the
    // route is monid, whose key is in the vault.
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });

    const settled = started.runner.requests.get(routeId);
    expect(settled?.status).toBe("ready");
    expect(settled?.routed_via).toBe("monid");
    expect(settled?.routed_http_status).toBe(200);
    // No price was reported, so the verified per-call price is what is recorded.
    expect(settled?.routed_cost_usd).toBe(0.01);
    expect(settled?.routed_result).toContain('"rows":3');
    expect(settled?.handle).toBe("aggregator:monid");
    expect(started.logs.join(" ")).toMatch(/No key for glasser is in the keys index/);

    // The call really went to the aggregator, with the key in its header.
    expect(glasser.calls).toHaveLength(0);
    expect(monid.calls).toHaveLength(1);
    const call = monid.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/v1/call/fakevendor");
    expect(call?.authorization).toBe(`Bearer ${AGG_SECRET}`);
    expect(call?.body["provider"]).toBe("fakevendor");
    expect(call?.body["purpose"]).toBe("enrich 3 companies");

    // Nothing the agent, the store or the log can see carries the key.
    const view = await started.client.getRequest(routeId);
    expect(view.routed_via).toBe("monid");
    expect(view.routed_http_status).toBe(200);
    expect(view.routed_cost_usd).toBe(0.01);
    expect(view.routed_result).toContain('"rows":3');
    expect(JSON.stringify(view)).not.toContain(AGG_SECRET);
    expect(JSON.stringify(view)).toContain("aggregator:monid");
    expect(fs.readFileSync(path.join(home, "requests.json"), "utf8")).not.toContain(AGG_SECRET);
    expect(started.logs.join("\n")).not.toContain(AGG_SECRET);

    // One ledger row for the call, at the price that was checked against the caps.
    const ledger = openLedger(home);
    try {
      const rows = ledger.all().filter((row) => row.cost !== null);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cost).toBe(0.01);
      expect(rows[0]?.status).toBe(200);
      expect(rows[0]?.alias).toBe("monid-personal");
      expect(rows[0]?.domain).toBe(VENDOR_DOMAIN);
    } finally {
      ledger.close();
    }
  });

  it("redacts echoed credentials before truncating the answer", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    monid.reply({ body: "x".repeat(1990) + AGG_SECRET });
    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    const view = await started.client.getRequest(routeId);
    expect(view.routed_result).toContain("[redacted]");
    expect(JSON.stringify(view)).not.toContain(AGG_SECRET.slice(0, 10));
    expect(fs.readFileSync(path.join(home, "requests.json"), "utf8")).not.toContain(AGG_SECRET.slice(0, 10));
  });

  it("does not follow an aggregator redirect", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    monid.reply({ status: 307, headers: { location: glasser.url + "/redirected" } });
    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    expect(started.runner.requests.get(routeId)?.status).toBe("failed");
    expect(monid.calls).toHaveLength(1);
    expect(glasser.calls).toHaveLength(0);
  });

  it("does not route using approval metadata when the vendor leaves the index", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    fs.writeFileSync(path.join(home, "fixture-apis.yaml"), "version: 1\nentries: []\n");
    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    expect(started.runner.requests.get(routeId)?.status).toBe("needs_human");
    expect(monid.calls).toHaveLength(0);
    expect(glasser.calls).toHaveLength(0);
  });

  it("prefers the cheaper aggregator once a key for it is configured too", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    await addKey(home, "glasser-personal", "127.0.0.1", OTHER_SECRET);
    glasser.reply({ headers: { "x-skeletonkey-cost-usd": "0.0035" } });

    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    const settled = started.runner.requests.get(routeId);
    expect(settled?.status).toBe("ready");
    expect(settled?.routed_via).toBe("glasser");
    // What the aggregator itself reported beats the catalog's published price.
    expect(settled?.routed_cost_usd).toBe(0.0035);
    expect(monid.calls).toHaveLength(0);
    expect(glasser.calls[0]?.authorization).toBe(`Bearer ${OTHER_SECRET}`);
    expect(started.logs.join("\n")).not.toContain(OTHER_SECRET);
  });

  it("returns needs_human with signup instructions when no aggregator key is available", async () => {
    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    const settled = started.runner.requests.get(routeId);
    expect(settled?.status).toBe("needs_human");
    expect(settled?.routed_via).toBeNull();
    // Nothing was called: no key, no route.
    expect(monid.calls).toHaveLength(0);
    expect(glasser.calls).toHaveLength(0);

    const view = await started.client.getRequest(routeId);
    expect(view.status).toBe("needs_human");
    expect(view.reason).toContain("https://glasser.ai/");
    expect(view.reason).toMatch(/fiat/);
    const notes = view.notes.join(" ");
    expect(notes).toMatch(/glasser: sign up at https:\/\/glasser\.ai\//);
    // The `add` command names the host the runner would actually call, which
    // this test's local override moved to loopback.
    expect(notes).toMatch(/skeletonkey add glasser --domain 127\.0\.0\.1/);
    expect(notes).toMatch(/monid: sign up at https:\/\/monid\.ai\//);
    // The signup instructions quote the published price and where it was read.
    expect(notes).toContain("https://api.glasser.ai/public/catalog");
  });

  it("stops at needs_human when the aggregator refuses the key", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    monid.reply({ status: 401, body: { error: "unauthorized" } });

    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    const settled = started.runner.requests.get(routeId);
    expect(settled?.status).toBe("needs_human");
    expect(settled?.routed_via).toBe("monid");
    expect(settled?.routed_http_status).toBe(401);
    // Nothing is recorded as charged: unknown is not zero.
    expect(settled?.routed_cost_usd).toBeNull();
    expect(settled?.reason).toMatch(/refusing the key or the balance/);
    expect(settled?.reason).toContain("https://monid.ai/");

    const ledger = openLedger(home);
    try {
      const row = ledger.all().find((item) => item.status === 401);
      expect(row?.cost).toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("fails without charging when the aggregator errors", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    monid.reply({ status: 503, body: { error: "upstream_down" } });

    const { routeId } = await approveThroughToRoute(started, { global: "20", vendor: "5" });
    const settled = started.runner.requests.get(routeId);
    expect(settled?.status).toBe("failed");
    expect(settled?.routed_http_status).toBe(503);
    expect(settled?.routed_cost_usd).toBeNull();
    expect(settled?.reason).toMatch(/Nothing was recorded as charged/);
  });

  it("pays for one call when the approval form is submitted twice", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    const created = await started.client.createRequest({
      vendor: VENDOR,
      domain: VENDOR_DOMAIN,
      est_budget_usd: 1,
      fallback_aggregator: "monid",
      fallback_price_usd: 0.01,
    });
    const access = started.runner.requests.get(created.request_id);
    await postForm(created.approval_url ?? "", {
      page_token: access?.page_token ?? "",
      action: "approve",
      global_cap: "20",
      vendor_cap: "5",
    });
    const routeId = started.runner.requests.get(created.request_id)?.follow_up_id ?? "";
    const route = started.runner.requests.get(routeId);
    const form = { page_token: route?.page_token ?? "", action: "approve" };
    const url = `${started.runner.url}/approve/${routeId}`;
    // A double-clicked Approve, both posts in flight at once.
    const [first, second] = await Promise.all([postForm(url, form), postForm(url, form)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(started.runner.requests.get(routeId)?.status).toBe("ready");
    expect(monid.calls).toHaveLength(1);
    const ledger = openLedger(home);
    try {
      expect(ledger.all().filter((row) => row.cost !== null)).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it("re-checks the caps immediately before the call and routes nothing over them", async () => {
    await addKey(home, "monid-personal", "localhost", AGG_SECRET);
    // A cap below the per-call price: approved route, unaffordable call.
    const { routeId } = await approveThroughToRoute(started, { global: "1", vendor: "0.005" });
    const settled = started.runner.requests.get(routeId);
    expect(settled?.status).toBe("needs_human");
    expect(settled?.reason).toMatch(/Blocked immediately before the call/);
    expect(settled?.reason).toMatch(/can never raise a cap/);
    expect(monid.calls).toHaveLength(0);
  });
});
