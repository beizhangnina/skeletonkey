import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateApisFile, type ApiEntry } from "../src/apis.js";
import {
  DEFAULT_STALE_DAYS,
  entryFreshness,
  fingerprint,
  httpFetcher,
  readStaleCache,
  runStaleCheck,
  staleAfterDays,
  staleTargets,
  writeStaleCache,
  type StaleCache,
} from "../src/stale.js";
import { REPO_ROOT, makeHome, removeHome, runCli } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");

function row(overrides: Partial<ApiEntry> = {}): ApiEntry {
  return {
    name: "vendor",
    url: "https://example.com",
    access_mode: "own-account",
    min_topup: null,
    billing_unit: null,
    signup_automatable: null,
    tos_notes: null,
    source: null,
    checked_date: null,
    ...overrides,
  };
}

function priced(url: string, date: string | null): ApiEntry {
  return row({
    billing: { model: "payg", free_tier_note: null, verified_url: url, verified_date: date },
  });
}

const EMPTY: StaleCache = { version: 1, urls: {} };

describe("fingerprint", () => {
  it("ignores markup, so a rebuilt page with the same words matches", () => {
    const a = "<html><body><h1>Free</h1> <p>$0.02 per call</p><script>var x=1</script></body></html>";
    const b = "<main><div class='x'>Free</div><span>$0.02 per call</span><style>b{}</style></main>";
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("notices a price change", () => {
    expect(fingerprint("<p>$0.02 per call</p>")).not.toBe(fingerprint("<p>$0.04 per call</p>"));
  });

  it("ignores a machine-generated timestamp, but not a plain date", () => {
    const now = '{"timestamp":"2026-10-25T00:32:38.160","price":1}';
    const later = '{"timestamp":"2026-10-26T11:02:01.999","price":1}';
    expect(fingerprint(now)).toBe(fingerprint(later));
    expect(fingerprint("effective 2026-11-01")).not.toBe(fingerprint("effective 2026-12-01"));
  });
});

describe("staleTargets", () => {
  it("finds every URL a price claim rests on", () => {
    const targets = staleTargets([
      row({
        name: "v",
        billing: {
          model: "payg",
          free_tier_note: null,
          verified_url: "https://v.test/pricing",
          verified_date: "2026-10-24",
        },
        aggregators: [
          { name: "monid", carries: true, per_call_price: 0.01, price_verified_url: "https://m.test/p" },
          { name: "glasser", carries: false, per_call_price: null, price_verified_url: null },
        ],
      }),
    ]);
    // Exactly the two URLs a price claim rests on: the vendor's own page and
    // the carrying catalog's. There is no third payment-rail URL to re-check.
    expect(targets.map((target) => target.field)).toEqual([
      "billing.verified_url",
      "aggregators[monid].price_verified_url",
    ]);
    expect(targets[1]?.claim).toBe("$0.01/call");
  });

  it("finds nothing in a row that verified nothing", () => {
    expect(staleTargets([row()])).toEqual([]);
  });
});

describe("runStaleCheck", () => {
  it("records a first fingerprint as `new`, not as a problem", async () => {
    const result = await runStaleCheck({
      entries: [priced("https://v.test/pricing", "2026-10-24")],
      cache: EMPTY,
      fetchUrl: async () => ({ status: 200, body: "<p>$1</p>" }),
      today: "2026-10-25",
    });
    expect(result.findings[0]?.status).toBe("new");
    expect(result.needs_attention).toBe(false);
    expect(result.cache.urls["https://v.test/pricing"]?.fingerprint).toBeTruthy();
  });

  it("reports an unchanged page as ok", async () => {
    const entries = [priced("https://v.test/pricing", "2026-10-24")];
    const fetchUrl = async () => ({ status: 200, body: "<p>$1</p>" });
    const first = await runStaleCheck({ entries, cache: EMPTY, fetchUrl, today: "2026-10-25" });
    const second = await runStaleCheck({ entries, cache: first.cache, fetchUrl, today: "2026-10-25" });
    expect(second.findings[0]?.status).toBe("ok");
    expect(second.needs_attention).toBe(false);
  });

  it("flags a page whose text moved, and asks for a human", async () => {
    const entries = [priced("https://v.test/pricing", "2026-10-24")];
    const first = await runStaleCheck({
      entries,
      cache: EMPTY,
      fetchUrl: async () => ({ status: 200, body: "<p>$1 per call</p>" }),
      today: "2026-10-25",
    });
    const second = await runStaleCheck({
      entries,
      cache: first.cache,
      fetchUrl: async () => ({ status: 200, body: "<p>$2 per call</p>" }),
      today: "2026-10-25",
    });
    expect(second.findings[0]?.status).toBe("changed");
    expect(second.findings[0]?.detail).toMatch(/re-read the price/);
    expect(second.needs_attention).toBe(true);
  });

  it("flags an unreachable page, by status and by network error", async () => {
    const entries = [priced("https://v.test/pricing", "2026-10-24")];
    const gone = await runStaleCheck({
      entries,
      cache: EMPTY,
      fetchUrl: async () => ({ status: 404, body: "" }),
      today: "2026-10-25",
    });
    expect(gone.findings[0]?.status).toBe("unreachable");
    expect(gone.findings[0]?.detail).toMatch(/HTTP 404/);
    expect(gone.needs_attention).toBe(true);

    const broken = await runStaleCheck({
      entries,
      cache: EMPTY,
      fetchUrl: async () => ({ status: 0, body: "", error: "ENOTFOUND" }),
      today: "2026-10-25",
    });
    expect(broken.findings[0]?.status).toBe("unreachable");
    expect(broken.findings[0]?.detail).toMatch(/ENOTFOUND/);
  });

  it("flags an old verified_date even when the page is byte-identical", async () => {
    const entries = [priced("https://v.test/pricing", "2026-01-01")];
    const fetchUrl = async () => ({ status: 200, body: "<p>$1</p>" });
    const first = await runStaleCheck({ entries, cache: EMPTY, fetchUrl, today: "2026-10-25" });
    const second = await runStaleCheck({ entries, cache: first.cache, fetchUrl, today: "2026-10-25" });
    expect(second.findings[0]?.status).toBe("old");
    expect(second.findings[0]?.age_days).toBe(297);
    // "old" is a warning: the facts may still be right, so no failure exit.
    expect(second.needs_attention).toBe(false);
  });

  it("reports a missing verified_date as undated when not fetching", async () => {
    const result = await runStaleCheck({
      entries: [priced("https://v.test/pricing", null)],
      cache: EMPTY,
      fetchUrl: null,
      today: "2026-10-25",
    });
    expect(result.findings[0]?.status).toBe("undated");
    expect(result.fetched).toBe(false);
  });

  it("fetches each URL once however many rows cite it", async () => {
    const seen: string[] = [];
    const shared = "https://catalog.test/prices";
    const entries = [
      row({
        name: "a",
        aggregators: [{ name: "monid", carries: true, per_call_price: 0.01, price_verified_url: shared }],
      }),
      row({
        name: "b",
        aggregators: [{ name: "monid", carries: true, per_call_price: 0.02, price_verified_url: shared }],
      }),
    ];
    let calls = 0;
    const result = await runStaleCheck({
      entries,
      cache: EMPTY,
      fetchUrl: async (url) => {
        seen.push(url);
        // A page that differs per request would report "changed" against itself
        // if the same run fetched it twice.
        calls += 1;
        return { status: 200, body: `<p>visit ${calls}</p>` };
      },
      today: "2026-10-25",
    });
    expect(seen).toEqual([shared]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.status)).toEqual(["new", "new"]);
  });

  it("filters to one row with --only", async () => {
    const result = await runStaleCheck({
      entries: [priced("https://a.test/p", "2026-10-24"), row({ name: "zzz", billing: { model: "payg", free_tier_note: null, verified_url: "https://b.test/p", verified_date: "2026-10-24" } })],
      cache: EMPTY,
      fetchUrl: async () => ({ status: 200, body: "x" }),
      only: "zzz",
      today: "2026-10-25",
    });
    expect(result.findings.map((finding) => finding.entry)).toEqual(["zzz"]);
  });
});

describe("the real HTTP fetcher", () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/gone") {
        res.writeHead(404).end("no");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<p>ua:${req.headers["user-agent"] ?? "(none)"}</p>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  it("identifies itself, because some vendors 403 an anonymous client", async () => {
    const result = await httpFetcher()(`${base}/pricing`);
    expect(result.status).toBe(200);
    expect(result.body).toMatch(/SkeletonKey-stale-check/);
  });

  it("reports a 404 as a status, not an exception", async () => {
    const result = await httpFetcher()(`${base}/gone`);
    expect(result.status).toBe(404);
    expect(result.error).toBeUndefined();
  });

  it("drives the whole check against a live server", async () => {
    const entries = [priced(`${base}/pricing`, "2026-10-24")];
    const run = await runStaleCheck({ entries, cache: EMPTY, fetchUrl: httpFetcher(), today: "2026-10-25" });
    expect(run.findings[0]?.status).toBe("new");
    expect(run.findings[0]?.http_status).toBe(200);
  });
});

describe("the stale-check cache file", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => removeHome(home));

  it("round-trips, is 0600, and treats a corrupt file as a first run", () => {
    const file = path.join(home, "stale-check.json");
    writeStaleCache(file, {
      version: 1,
      urls: { "https://v.test/p": { fingerprint: "abc", http_status: 200, checked: "2026-10-25", bytes: 10 } },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readStaleCache(file).urls["https://v.test/p"]?.fingerprint).toBe("abc");
    fs.writeFileSync(file, "{not json");
    expect(readStaleCache(file)).toEqual({ version: 1, urls: {} });
    expect(readStaleCache(path.join(home, "nope.json"))).toEqual({ version: 1, urls: {} });
  });
});

describe("skeletonkey stale-check (CLI)", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => removeHome(home));

  it("reports every verified_url in the shipped index without touching the network", async () => {
    const result = await runCli(home, ["stale-check", "--no-fetch", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const findings = parsed["findings"] as { entry: string; url: string; status: string }[];
    // Every shipped row with a billing block has a page behind its claim.
    const shipped = validateApisFile(APIS_YAML).document?.entries ?? [];
    const withBilling = shipped.filter((entry) => entry.billing?.verified_url != null);
    expect(withBilling.length).toBeGreaterThanOrEqual(5);
    for (const entry of withBilling) {
      expect(findings.some((finding) => finding.entry === entry.name)).toBe(true);
    }
    expect(parsed["fetched"]).toBe(false);
    expect(parsed["needs_attention"]).toBe(false);
    // Dates only: nothing was compared, so nothing is "changed".
    expect(findings.every((finding) => finding.status === "ok" || finding.status === "old")).toBe(true);
  });

  it("exits 0 and says so when a filter matches no verified_url", async () => {
    const result = await runCli(home, ["stale-check", "--no-fetch", "--only", "no-such-vendor"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no verified_url anywhere in the index/);
  });
});

describe("entryFreshness", () => {
  const TODAY = "2026-10-25";
  const judge = (entry: ApiEntry, maxAgeDays?: number): ReturnType<typeof entryFreshness> =>
    entryFreshness(entry, { today: TODAY, ...(maxAgeDays === undefined ? {} : { maxAgeDays }) });

  it("is quiet about a row checked inside the window", () => {
    const result = judge(row({ checked_date: "2026-09-01", source: "https://vendor.test/pricing" }));
    expect(result.stale).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.checked_age_days).toBe(54);
    expect(result.max_age_days).toBe(DEFAULT_STALE_DAYS);
  });

  it("warns once a checked_date passes the window", () => {
    const result = judge(row({ checked_date: "2026-01-01", source: "https://vendor.test/pricing" }));
    expect(result.stale).toBe(true);
    expect(result.checked_age_days).toBe(297);
    expect(result.warnings.join(" ")).toMatch(/297 days ago/);
    expect(result.warnings.join(" ")).toMatch(/stale-check/);
  });

  it("warns about a billing date that has aged out, even when the row is fresh", () => {
    const entry = row({
      checked_date: "2026-10-20",
      source: "https://vendor.test/pricing",
      billing: {
        model: "payg",
        free_tier_note: null,
        verified_url: "https://vendor.test/pricing",
        verified_date: "2025-05-01",
      },
    });
    const result = judge(entry);
    expect(result.stale).toBe(true);
    expect(result.billing_age_days).toBe(542);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/billing\.verified_date is 2025-05-01/);
    expect(result.warnings[0]).toMatch(/https:\/\/vendor\.test\/pricing/);
  });

  it("treats a null checked_date on a real row as a warning", () => {
    const result = judge(row({ checked_date: null }));
    expect(result.stale).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/checked_date is null/);
  });

  it("does not nag about rows that already admit what they are", () => {
    // An example row is a documented placeholder...
    expect(judge(row({ checked_date: null, example: true })).stale).toBe(false);
    // ... and a discovered row carries `status: unverified` instead.
    expect(judge(row({ checked_date: null, status: "unverified" })).stale).toBe(false);
    // Once it is promoted, the missing date matters again.
    expect(judge(row({ checked_date: null, status: "verified" })).stale).toBe(true);
  });

  it("warns when a billing model was recorded with no date behind it", () => {
    const result = judge(
      row({
        checked_date: "2026-10-20",
        source: "https://vendor.test/pricing",
        billing: {
          model: "subscription",
          free_tier_note: null,
          verified_url: null,
          verified_date: null,
        },
      }),
    );
    expect(result.stale).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/billing\.verified_date is null/);
  });

  it("takes the window from the caller, then the environment, then the default", () => {
    expect(judge(row({ checked_date: "2026-10-01", source: "https://v.test/p" }), 10).stale).toBe(
      true,
    );
    expect(staleAfterDays(30)).toBe(30);
    expect(staleAfterDays()).toBe(DEFAULT_STALE_DAYS);

    const previous = process.env.SKELETONKEY_STALE_DAYS;
    try {
      process.env.SKELETONKEY_STALE_DAYS = "7";
      expect(staleAfterDays()).toBe(7);
      // An explicit argument still wins over the environment.
      expect(staleAfterDays(45)).toBe(45);
      expect(
        entryFreshness(row({ checked_date: "2026-10-01", source: "https://v.test/p" }), {
          today: TODAY,
        }).stale,
      ).toBe(true);
      process.env.SKELETONKEY_STALE_DAYS = "not-a-number";
      expect(staleAfterDays()).toBe(DEFAULT_STALE_DAYS);
    } finally {
      if (previous === undefined) delete process.env.SKELETONKEY_STALE_DAYS;
      else process.env.SKELETONKEY_STALE_DAYS = previous;
    }
  });

  it("never invents an age it cannot compute", () => {
    const result = judge(row({ checked_date: "not-a-date" as unknown as string }));
    expect(result.checked_age_days).toBeNull();
    expect(result.stale).toBe(false);
  });
});
