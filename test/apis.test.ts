import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_MODES,
  BILLING_MODELS,
  apiIndexCacheStats,
  clearApiIndexCache,
  loadApiIndex,
  matchesCapability,
  readShardFile,
  registrableDomain,
  validateApis,
  validateApisFile,
  type ApiEntry,
} from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");
/** A home with no apis.d/, so only the shard dirs a test names are read. */
const NO_HOME = path.join(os.tmpdir(), "skeletonkey-no-such-home");

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "thing",
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

/**
 * The invariant every shipped row obeys, in either direction (issue #6).
 *
 * A row with a `checked_date` is a row someone verified, and it may carry real
 * numbers -- but it has to name the source it was verified from. A row without
 * one has been checked by nobody, so it may not claim a price. Either way, a
 * price is meaningless without the unit it is charged in.
 */
function expectVerifiedFactsOrNothing(row: ApiEntry): void {
  if (row.checked_date === null) {
    expect(row.min_topup, `${row.name}: unverified rows may not claim a price`).toBeNull();
    return;
  }
  expect(row.checked_date, row.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(row.source, `${row.name}: a verified row must name its source`).toMatch(/^https?:\/\//);
  if (row.min_topup !== null) {
    expect(row.min_topup, row.name).toBeGreaterThanOrEqual(0);
    expect(row.billing_unit, `${row.name}: a price needs the unit it is charged in`).not.toBeNull();
  }
}

describe("apis.yaml shipped with the repo", () => {
  it("validates against the documented schema", () => {
    const result = validateApisFile(APIS_YAML);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("ships example rows plus vendor-direct rows that name their source", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    // Two kinds of row are allowed here, and nothing in between: a placeholder
    // that says so, or a row read off the vendor's own pages that names the
    // page and the day it was read. A row with neither is a rumour.
    for (const row of entries) {
      if (row.example === true) {
        expect(row.checked_date, `${row.name}: an example row is nobody's verified offer`).toBeNull();
        continue;
      }
      expect(row.checked_date, `${row.name}: a vendor-direct row must say when it was read`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      expect(row.source, `${row.name}: a vendor-direct row must name the page it was read from`).toMatch(
        /^https:\/\//,
      );
    }
  });

  it("includes the three north-star scenario rows with capabilities and domains", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    const byName = new Map(entries.map((row) => [row.name, row]));
    for (const name of [
      "example-x-twitter-api",
      "example-apify-scraping",
      "example-voyage-embeddings",
    ]) {
      const row = byName.get(name);
      expect(row, name).toBeDefined();
      expect(row?.domain, name).toBeTruthy();
      expect(row?.capabilities?.length, name).toBeGreaterThan(0);
    }
  });

  it("matches capabilities loosely enough for an agent's own words", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    const names = (capability: string): string[] =>
      entries.filter((row) => matchesCapability(row, capability)).map((row) => row.name);

    expect(names("embeddings")).toContain("example-voyage-embeddings");
    expect(names("web scraping")).toContain("example-apify-scraping");
    expect(names("scrape a website")).toContain("example-apify-scraping");
    expect(names("tweets")).toContain("example-x-twitter-api");
    expect(names("zzz-nothing-like-this")).toEqual([]);
  });

  it("invents no prices: an unverified row claims nothing", () => {
    // The rule is no longer "nothing is ever verified" -- a reviewed row with a
    // real price is exactly what this file is for, and issue #6 was that the
    // suite forbade shipping one. The rule is that the two go together: a price
    // needs the date and the source that back it.
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    for (const row of entries) expectVerifiedFactsOrNothing(row);
  });

  it("covers the documented access modes", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    for (const row of entries) expect(ACCESS_MODES).toContain(row.access_mode);
  });
});

describe("validator", () => {
  it("accepts a fully populated entry", () => {
    const result = validateApis({
      version: 1,
      entries: [
        entry({
          min_topup: 5,
          billing_unit: "per 1M input tokens",
          signup_automatable: true,
          tos_notes: "ok",
          source: "https://example.com/pricing",
          checked_date: "2026-10-24",
          example: false,
        }),
      ],
    });
    expect(result.errors).toEqual([]);
  });

  it("rejects a non-mapping root and a missing entries list", () => {
    expect(validateApis([]).errors[0]).toContain("root: expected a mapping");
    expect(validateApis({ version: 1 }).errors[0]).toContain("root.entries");
    expect(validateApis({ version: 2, entries: [] }).errors[0]).toContain("root.version");
  });

  it("rejects an unknown access_mode", () => {
    const result = validateApis({ version: 1, entries: [entry({ access_mode: "free-lunch" })] });
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain("entries[0].access_mode");
  });

  it("rejects a guessed price expressed as a string", () => {
    const result = validateApis({ version: 1, entries: [entry({ min_topup: "about $5" })] });
    expect(result.errors.join()).toContain("entries[0].min_topup");
  });

  it("rejects a malformed capabilities list or domain", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ capabilities: ["ok", ""], domain: 42 })],
    });
    const joined = result.errors.join("\n");
    expect(joined).toContain("entries[0].capabilities");
    expect(joined).toContain("entries[0].domain");
  });

  it("rejects negative top-ups, bad URLs, bad dates and unknown fields", () => {
    const result = validateApis({
      version: 1,
      entries: [
        entry({
          min_topup: -1,
          url: "ftp://example.com",
          checked_date: "24/10/2026",
          source: "not a url",
          signup_automatable: "maybe",
          surprise: true,
        }),
      ],
    });
    const joined = result.errors.join("\n");
    expect(joined).toContain("min_topup");
    expect(joined).toContain("url");
    expect(joined).toContain("checked_date");
    expect(joined).toContain("source");
    expect(joined).toContain("signup_automatable");
    expect(joined).toContain("surprise: unknown field");
  });

  it("reports missing required fields and duplicate names", () => {
    const result = validateApis({
      version: 1,
      entries: [entry(), entry(), { name: "bare" }],
    });
    const joined = result.errors.join("\n");
    expect(joined).toContain("entries[1].name: duplicate entry");
    expect(joined).toContain("entries[2].url: missing");
    expect(joined).toContain("use null if unknown");
  });

  it("reports a missing file instead of throwing", () => {
    const result = validateApisFile(path.join(REPO_ROOT, "does-not-exist.yaml"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("file not found");
  });
});

describe("auth fields", () => {
  it("accepts a fully specified auth block", () => {
    const result = validateApis({
      version: 1,
      entries: [
        entry({
          auth_header: "x-api-key",
          auth_format: "{key}",
          base_url: "https://api.example.com/v1",
          signup_url: "https://app.example.com/signup",
          key_page_url: null,
          email_only_signup: true,
          requires_card: false,
          requires_phone: false,
          requires_work_email: true,
          human_steps: ["accept the developer terms"],
        }),
      ],
    });
    expect(result.errors).toEqual([]);
    const row = result.document?.entries[0];
    expect(row?.auth_header).toBe("x-api-key");
    expect(row?.auth_format).toBe("{key}");
    expect(row?.key_page_url).toBeNull();
    expect(row?.requires_work_email).toBe(true);
    expect(row?.human_steps).toEqual(["accept the developer terms"]);
  });

  it("treats an absent auth block as absent, not as Bearer", () => {
    const row = validateApis({ version: 1, entries: [entry()] }).document?.entries[0];
    expect(row?.auth_header).toBeUndefined();
    expect(row?.auth_format).toBeUndefined();
  });

  it("rejects an auth_format without the {key} placeholder", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ auth_header: "Authorization", auth_format: "Bearer" })],
    });
    expect(result.errors.join()).toContain("auth_format: must contain the {key} placeholder");
  });

  it("rejects an auth_format with no header to put it in", () => {
    const result = validateApis({ version: 1, entries: [entry({ auth_format: "Bearer {key}" })] });
    expect(result.errors.join()).toContain("auth_header: required when auth_format is set");
  });

  it("rejects a header name that is really a whole header line", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ auth_header: "Authorization: Bearer" })],
    });
    expect(result.errors.join()).toContain("auth_header: expected a header name only");
  });

  it("rejects non-URL auth URLs and non-boolean gates", () => {
    const result = validateApis({
      version: 1,
      entries: [
        entry({
          base_url: "api.example.com",
          signup_url: 42,
          key_page_url: "ftp://example.com/keys",
          requires_card: "yes",
          email_only_signup: "maybe",
          human_steps: ["ok", ""],
        }),
      ],
    });
    const joined = result.errors.join("\n");
    expect(joined).toContain("entries[0].base_url");
    expect(joined).toContain("entries[0].signup_url");
    expect(joined).toContain("entries[0].key_page_url");
    expect(joined).toContain("entries[0].requires_card");
    expect(joined).toContain("entries[0].email_only_signup");
    expect(joined).toContain("entries[0].human_steps");
  });

  it("rejects email_only_signup: true alongside a card or phone requirement", () => {
    const card = validateApis({
      version: 1,
      entries: [entry({ email_only_signup: true, requires_card: true })],
    });
    expect(card.errors.join()).toContain("email_only_signup: contradicts requires_card: true");
    const phone = validateApis({
      version: 1,
      entries: [entry({ email_only_signup: true, requires_phone: true })],
    });
    expect(phone.errors.join()).toContain("email_only_signup: contradicts requires_phone: true");
  });
});

describe("auth facts shipped in apis.yaml", () => {
  const byName = new Map(
    (validateApisFile(APIS_YAML).document?.entries ?? []).map((row) => [row.name, row]),
  );

  it("records the header the vendor's own docs document, not a default", () => {
    // Apollo and DropLeads take the key in x-api-key; Bearer would 401.
    for (const name of ["example-apollo-contacts", "example-dropleads-contacts"]) {
      const row = byName.get(name);
      expect(row?.auth_header, name).toBe("x-api-key");
      expect(row?.auth_format, name).toBe("{key}");
    }
    for (const name of ["example-x-twitter-api", "example-voyage-embeddings"]) {
      const row = byName.get(name);
      expect(row?.auth_header, name).toBe("Authorization");
      expect(row?.auth_format, name).toBe("Bearer {key}");
    }
  });

  it("points signup_url at a signup page, not at the docs root in url", () => {
    for (const name of [
      "example-x-twitter-api",
      "example-voyage-embeddings",
      "example-apollo-contacts",
      "example-dropleads-contacts",
    ]) {
      const row = byName.get(name);
      expect(row?.signup_url, name).toBeTruthy();
      expect(row?.signup_url, name).not.toBe(row?.url);
      expect(row?.base_url, name).toMatch(/^https:\/\//);
      expect(row?.human_steps?.length, name).toBeGreaterThan(0);
    }
  });

  it("records the gates the vendor's docs state, and null for the rest", () => {
    // X: pay-per-use credits, card required even for the free credits.
    expect(byName.get("example-x-twitter-api")?.requires_card).toBe(true);
    expect(byName.get("example-x-twitter-api")?.email_only_signup).toBe(false);
    // Apollo: free-tier API access needs a work email, so no +alias.
    expect(byName.get("example-apollo-contacts")?.requires_work_email).toBe(true);
    // Nothing was invented: unverified gates stay null.
    expect(byName.get("example-voyage-embeddings")?.requires_card).toBeNull();
    expect(byName.get("example-dropleads-contacts")?.requires_card).toBeNull();
    expect(byName.get("example-dropleads-contacts")?.email_only_signup).toBeNull();
    // And a login-gated key page is null rather than a guessed URL.
    expect(byName.get("example-apollo-contacts")?.key_page_url).toBeNull();
    expect(byName.get("example-dropleads-contacts")?.key_page_url).toBeNull();
  });

  it("backs any price it claims with a date and a source", () => {
    for (const row of byName.values()) expectVerifiedFactsOrNothing(row);
  });
});

describe("registrableDomain", () => {
  it("reduces vendor hosts to one comparable name", () => {
    expect(registrableDomain("api.apollo.io")).toBe("apollo.io");
    expect(registrableDomain("https://www.apollo.io/pricing")).toBe("apollo.io");
    expect(registrableDomain("DOCS.X.COM")).toBe("x.com");
    expect(registrableDomain("api.example.co.uk")).toBe("example.co.uk");
  });

  it("returns empty for anything it cannot reduce honestly", () => {
    expect(registrableDomain("")).toBe("");
    expect(registrableDomain("localhost")).toBe("");
    expect(registrableDomain("127.0.0.1")).toBe("");
    expect(registrableDomain("::1")).toBe("");
  });
});

describe("the merged index (apis.yaml + data/apis shards)", () => {
  const tmpDirs: string[] = [];
  const tmpShardDir = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-shards-"));
    tmpDirs.push(dir);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };
  afterEach(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  });

  it("reads apis.yaml alone when no shard directory is given", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [] });
    expect(index.errors).toEqual([]);
    expect(index.counts.shards).toBe(0);
    expect(index.counts.total).toBe(index.counts.apis_yaml);
    expect(index.entries.every((row) => row.origin === "apis.yaml")).toBe(true);
  });

  it("merges the repo's generated shards and finds providers apis.yaml never mentions", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [SHARD_DIR] });
    expect(index.errors).toEqual([]);
    expect(index.counts.shards).toBeGreaterThan(100);
    expect(index.files.length).toBeGreaterThan(20);

    const shardOnly = index.entries.find((row) => row.name === "builtwith");
    expect(shardOnly).toBeDefined();
    expect(shardOnly?.origin).toBe("shard");
    expect(shardOnly?.category).toBe("people-company-data");
    // A shard row promises nothing about auth, and names no API domain to
    // register a key against: both would be guesses.
    expect(shardOnly?.auth_header).toBeNull();
    expect(shardOnly?.auth_format).toBeNull();
    expect(shardOnly?.domain).toBeUndefined();
    expect(shardOnly?.min_topup).toBeNull();
  });

  it("holds the verified-facts rule across every row in the merged index", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [SHARD_DIR] });
    expect(index.entries.length).toBeGreaterThan(100);
    // The shard rows DO carry a checked_date (the date the catalog was read),
    // so they have to name a source_url -- and they still claim no price.
    for (const row of index.entries) expectVerifiedFactsOrNothing(row);
    expect(index.entries.filter((row) => row.checked_date !== null).length).toBeGreaterThan(100);
  });

  it("lets apis.yaml win for a vendor that appears in both", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [SHARD_DIR] });
    // `apollo` and `x` are shard ids; both are covered by an apis.yaml row.
    expect(index.counts.merged_duplicates).toBeGreaterThanOrEqual(2);
    expect(index.entries.filter((row) => row.name === "apollo")).toEqual([]);
    expect(index.entries.filter((row) => row.name === "x")).toEqual([]);
    const apollo = index.entries.filter((row) => registrableDomain(row.domain ?? "") === "apollo.io");
    expect(apollo).toHaveLength(1);
    expect(apollo[0]?.origin).toBe("apis.yaml");
    expect(apollo[0]?.auth_header).toBe("x-api-key");
    // Every name in the merged index is still unique.
    const names = index.entries.map((row) => row.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("finds Apollo by capability now that the shards are wired in", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [SHARD_DIR] });
    const matching = (capability: string): string[] =>
      index.entries.filter((row) => matchesCapability(row, capability)).map((row) => row.name);
    expect(matching("Apollo")).toContain("example-apollo-contacts");
    expect(matching("B2B contact data enrichment")).toContain("example-apollo-contacts");
    // And a provider that only the shards know about.
    expect(matching("technographics")).toContain("builtwith");
    expect(matching("zzz-nothing-like-this")).toEqual([]);
  });

  it("keeps two shard providers that merely share a registrable domain", () => {
    const shards = tmpShardDir({
      "a.yaml": [
        "apis:",
        '  - id: "one"',
        '    name: "One"',
        '    capability: "First thing."',
        '    category: "demo"',
        '    provider_url: "https://one.vendor.test"',
        '    docs_url: null',
        '    access_mode: "own-account"',
        '    auth_type: "api_key"',
        '    signup_automatable: "yes"',
        "    min_topup: null",
        '    tos_notes: "none"',
        '    source_url: "https://catalog.test/one"',
        "    checked_date: 2026-10-24",
        '  - id: "two"',
        '    name: "Two"',
        '    capability: "Second thing."',
        '    category: "demo"',
        '    provider_url: "https://two.vendor.test"',
        '    docs_url: null',
        '    access_mode: "unknown"',
        '    auth_type: "oauth"',
        '    signup_automatable: "no"',
        "    min_topup: null",
        '    tos_notes: "none"',
        '    source_url: "https://catalog.test/two"',
        "    checked_date: 2026-10-24",
        "",
      ].join("\n"),
    });
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [shards] });
    const names = index.entries.map((row) => row.name);
    expect(names).toContain("one");
    expect(names).toContain("two");
    const one = index.entries.find((row) => row.name === "one");
    const two = index.entries.find((row) => row.name === "two");
    // Tri-state strings become real values, and "unknown" becomes null.
    expect(one?.signup_automatable).toBe(true);
    expect(one?.access_mode).toBe("own-account");
    expect(one?.checked_date).toBe("2026-10-24");
    expect(two?.signup_automatable).toBe(false);
    expect(two?.access_mode).toBeNull();
    // auth_type: oauth is the one thing that becomes a human step.
    expect(two?.human_steps?.join()).toMatch(/OAuth/);
    expect(one?.human_steps).toEqual([]);
  });

  it("reports a broken shard instead of throwing or dropping the rest", () => {
    const shards = tmpShardDir({
      "bad-root.yaml": "not: a list\n",
      "bad-row.yaml": 'apis:\n  - name: "no id here"\n',
      "broken.yaml": "apis: [\n",
      "good.yaml": [
        "apis:",
        '  - id: "fine"',
        '    name: "Fine"',
        '    capability: "Works."',
        '    category: "demo"',
        '    provider_url: "https://fine.vendor.test"',
        '    access_mode: "own-account"',
        '    auth_type: "api_key"',
        '    signup_automatable: "unknown"',
        "    min_topup: null",
        '    tos_notes: null',
        '    source_url: "https://catalog.test/fine"',
        "    checked_date: 2026-10-24",
        "",
      ].join("\n"),
    });
    const index = loadApiIndex({ apisFile: APIS_YAML, home: NO_HOME, shardDirs: [shards] });
    expect(index.errors.length).toBe(3);
    expect(index.errors.join("\n")).toMatch(/expected an apis: list/);
    expect(index.errors.join("\n")).toMatch(/has no id/);
    expect(index.entries.map((row) => row.name)).toContain("fine");
    expect(index.entries.find((row) => row.name === "fine")?.signup_automatable).toBeNull();
  });

  it("readShardFile reports a missing file as an error", () => {
    const result = readShardFile(path.join(SHARD_DIR, "does-not-exist.yaml"));
    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("surfaces an invalid apis.yaml but still merges the shards", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-apis-"));
    tmpDirs.push(dir);
    const broken = path.join(dir, "apis.yaml");
    fs.writeFileSync(broken, "version: 1\nentries:\n  - name: oops\n");
    const index = loadApiIndex({ apisFile: broken, home: NO_HOME, shardDirs: [SHARD_DIR] });
    expect(index.errors.join("\n")).toContain("missing (use null if unknown)");
    expect(index.counts.apis_yaml).toBe(0);
    expect(index.counts.shards).toBeGreaterThan(100);
  });
});

// --- billing + aggregator carriage (v0.2) ----------------------------------

describe("the billing block", () => {
  const billing = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    model: "payg",
    free_tier_note: null,
    verified_url: "https://vendor.test/pricing",
    verified_date: "2026-10-24",
    ...overrides,
  });
  const check = (value: unknown): string[] =>
    validateApis({ version: 1, entries: [entry({ billing: value })] }).errors;

  it("accepts every documented model, plus null for nobody-checked", () => {
    expect([...BILLING_MODELS].sort()).toEqual([
      "free",
      "free_tier+payg",
      "free_tier+subscription",
      "payg",
      "subscription",
    ]);
    for (const model of BILLING_MODELS) {
      const needsNote = model.startsWith("free_tier");
      expect(
        check(billing({ model, ...(needsNote ? { free_tier_note: "10 free calls a day" } : {}) })),
        model,
      ).toEqual([]);
    }
    expect(check(billing({ model: null }))).toEqual([]);
    expect(check(null)).toEqual([]);
  });

  it("rejects a model it does not know", () => {
    expect(check(billing({ model: "cheap" })).join(" ")).toMatch(/billing\.model: expected one of/);
  });

  it("requires the free tier to be described when the model names one", () => {
    expect(check(billing({ model: "free_tier+payg" })).join(" ")).toMatch(
      /free_tier_note: required when model is free_tier\+payg/,
    );
  });

  it("requires a URL and a date together, never one alone", () => {
    expect(check(billing({ verified_date: null })).join(" ")).toMatch(
      /verified_date: required when verified_url is set/,
    );
    expect(check(billing({ verified_url: null })).join(" ")).toMatch(
      /verified_url: required when verified_date is set/,
    );
    expect(check(billing({ verified_url: null, verified_date: null }))).toEqual([]);
  });

  it("rejects a non-http verified_url and a malformed date", () => {
    expect(check(billing({ verified_url: "vendor.test/pricing" })).join(" ")).toMatch(
      /verified_url: expected an http\(s\) URL/,
    );
    expect(check(billing({ verified_date: "24-10-2026" })).join(" ")).toMatch(
      /verified_date: expected an ISO date/,
    );
  });

  it("rejects an unknown field and a non-boolean free_tier_covers_api", () => {
    expect(check(billing({ markup: 2 })).join(" ")).toMatch(/billing\.markup: unknown field/);
    expect(check(billing({ free_tier_covers_api: "yes" })).join(" ")).toMatch(
      /free_tier_covers_api: expected a boolean or null/,
    );
  });

  it("requires the model key to be present at all", () => {
    expect(check({ free_tier_note: null, verified_url: null, verified_date: null }).join(" ")).toMatch(
      /billing\.model: missing/,
    );
  });
});

describe("the aggregators block", () => {
  const check = (value: unknown): string[] =>
    validateApis({ version: 1, entries: [entry({ aggregators: value })] }).errors;

  it("accepts the three catalogs, carrying or not", () => {
    expect(
      check([
        { name: "monid", carries: true, per_call_price: 0.01, price_verified_url: "https://m.test/p" },
        { name: "glasser", carries: true, per_call_price: null, price_verified_url: null, price_note: "per result" },
        { name: "flatkey", carries: false, per_call_price: null, price_verified_url: null },
      ]),
    ).toEqual([]);
    expect(check(null)).toEqual([]);
    expect(check([])).toEqual([]);
  });

  it("refuses a price with no source URL -- the whole point of the field", () => {
    expect(
      check([{ name: "monid", carries: true, per_call_price: 0.01, price_verified_url: null }]).join(" "),
    ).toMatch(/price_verified_url: required when per_call_price is set -- never ship a price with no source/);
  });

  it("refuses a price on a catalog that does not carry the vendor", () => {
    expect(
      check([
        { name: "monid", carries: false, per_call_price: 0.01, price_verified_url: "https://m.test/p" },
      ]).join(" "),
    ).toMatch(/per_call_price: must be null when carries is false/);
  });

  it("rejects an unknown catalog, a duplicate, a missing `carries`, and a negative price", () => {
    expect(check([{ name: "rapidapi", carries: true }]).join(" ")).toMatch(/name: expected one of/);
    expect(
      check([
        { name: "monid", carries: true },
        { name: "monid", carries: false },
      ]).join(" "),
    ).toMatch(/duplicate aggregator "monid"/);
    expect(check([{ name: "monid" }]).join(" ")).toMatch(/carries: expected a boolean/);
    expect(
      check([{ name: "monid", carries: true, per_call_price: -1, price_verified_url: "https://m.test/p" }]).join(" "),
    ).toMatch(/per_call_price: expected a non-negative number/);
  });

  it("rejects a mapping where a list belongs, and an unknown field", () => {
    expect(check({ monid: true }).join(" ")).toMatch(/aggregators: expected a list or null/);
    expect(check([{ name: "monid", carries: true, markup: 1.3 }]).join(" ")).toMatch(
      /aggregators\[0\]\.markup: unknown field/,
    );
  });
});

describe("the discovery provenance fields", () => {
  const check = (overrides: Record<string, unknown>): string[] =>
    validateApis({ version: 1, entries: [entry(overrides)] }).errors;

  it("accepts the three statuses and null", () => {
    for (const status of ["unverified", "docs-verified", "verified", null]) {
      expect(check({ status }), String(status)).toEqual([]);
    }
    expect(check({ status: "probably" }).join(" ")).toMatch(/status: expected one of/);
  });

  it("requires source_urls to be real URLs", () => {
    expect(check({ source_urls: ["https://a.test", "https://b.test/x"] })).toEqual([]);
    expect(check({ source_urls: ["I read it somewhere"] }).join(" ")).toMatch(
      /source_urls: expected a list of http\(s\) URLs/,
    );
  });

  it("will not let a row claim promotion without saying what promoted it", () => {
    expect(check({ promoted_date: "2026-10-24" }).join(" ")).toMatch(
      /promoted_by: required when promoted_date is set/,
    );
    expect(check({ promoted_date: "2026-10-24", promoted_by: "ledger: 200 from x at t" })).toEqual([]);
  });
});

describe("the verified billing facts shipped in apis.yaml", () => {
  const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
  const byName = new Map(entries.map((row) => [row.name, row]));

  it("records a verified billing model for all five scenario vendors", () => {
    const expected: Record<string, string> = {
      "example-x-twitter-api": "payg",
      "example-voyage-embeddings": "free_tier+payg",
      "example-apify-scraping": "free_tier+subscription",
      "example-apollo-contacts": "free_tier+subscription",
      "example-dropleads-contacts": "free_tier+subscription",
    };
    for (const [name, model] of Object.entries(expected)) {
      const row = byName.get(name);
      expect(row?.billing?.model, name).toBe(model);
      expect(row?.billing?.verified_url, name).toMatch(/^https:\/\//);
      expect(row?.billing?.verified_date, name).toBe("2026-10-24");
      // A free tier is always described, never just asserted.
      if (model.startsWith("free_tier")) {
        expect(row?.billing?.free_tier_note?.length ?? 0, name).toBeGreaterThan(40);
      }
    }
  });

  it("still claims no min_topup anywhere, and no checked_date on an example row", () => {
    for (const row of entries) {
      // A price is the one fact nothing in this file is allowed to assert: no
      // vendor page read so far publishes a minimum top-up for these APIs.
      expect(row.min_topup, row.name).toBeNull();
      if (row.example === true) expect(row.checked_date, row.name).toBeNull();
    }
  });

  it("records Apify's auth facts and its fiat billing, read off Apify's own pages", () => {
    const apify = byName.get("example-apify-scraping");
    expect(apify?.billing?.model).toBe("free_tier+subscription");
    expect(apify?.billing?.verified_url).toBe("https://apify.com/pricing");
    expect(apify?.auth_header).toBe("Authorization");
    expect(apify?.auth_format).toBe("Bearer {key}");
    expect(apify?.base_url).toBe("https://api.apify.com/v2");
  });

  it("names the two vendors the catalogs actually carry, with sourced prices", () => {
    for (const name of ["example-apify-scraping", "example-apollo-contacts"]) {
      const carriers = byName.get(name)?.aggregators ?? [];
      expect(carriers.map((item) => item.name), name).toEqual(["monid", "glasser", "flatkey"]);
      const carrying = carriers.filter((item) => item.carries);
      expect(carrying.map((item) => item.name), name).toEqual(["monid", "glasser"]);
      for (const item of carrying) {
        expect(item.per_call_price, `${name}/${item.name}`).toBeGreaterThan(0);
        expect(item.price_verified_url, `${name}/${item.name}`).toMatch(/^https:\/\/api\./);
        expect(item.price_note?.length ?? 0, `${name}/${item.name}`).toBeGreaterThan(40);
      }
    }
  });

  it("claims no carriage and no price for the three vendors no catalog lists", () => {
    for (const name of [
      "example-x-twitter-api",
      "example-voyage-embeddings",
      "example-dropleads-contacts",
    ]) {
      for (const item of byName.get(name)?.aggregators ?? []) {
        expect(item.carries, `${name}/${item.name}`).toBe(false);
        expect(item.per_call_price, `${name}/${item.name}`).toBeNull();
      }
    }
  });
});

describe("carriage derived from the generated shards", () => {
  it("turns seen_in into one carriage row per catalog, with no price", () => {
    const shard = path.join(SHARD_DIR, "people-company-data.yaml");
    const rows = readShardFile(shard).entries;
    const apollo = rows.find((row) => row.name === "apollo");
    expect(apollo?.aggregators?.map((item) => item.name)).toEqual(["monid", "glasser", "flatkey"]);
    expect(
      apollo?.aggregators?.filter((item) => item.carries).map((item) => item.name).sort(),
    ).toEqual(["glasser", "monid"]);
    for (const item of apollo?.aggregators ?? []) {
      // The shards record no prices at all, so none may be implied here.
      expect(item.per_call_price, item.name).toBeNull();
      expect(item.price_verified_url, item.name).toBeNull();
      // Exact key set: a carriage row carries carriage and price provenance and
      // nothing else, so a new payment-rail field cannot slip in unnoticed.
      expect(Object.keys(item).sort(), item.name).toEqual([
        "carries",
        "name",
        "per_call_price",
        "price_note",
        "price_verified_url",
      ]);
    }
    // And no billing model is invented from a shard row either.
    expect(apollo?.billing).toBeNull();
  });

  it("gives a shard-only vendor carriage that find_api can read", () => {
    const index = loadApiIndex({
      apisFile: APIS_YAML,
      shardDirs: [SHARD_DIR],
      userIndexFile: null,
      home: NO_HOME,
    });
    const builtwith = index.entries.find((row) => row.name === "builtwith");
    expect(builtwith?.origin).toBe("shard");
    expect(builtwith?.aggregators?.some((item) => item.carries)).toBe(true);
    expect(builtwith?.billing ?? null).toBeNull();
  });

  it("lets a hand-written row inherit the carriage of the shard row it displaced", () => {
    // `example-x-twitter-api` declares its own carriage, so pick a row that
    // does not: a shard vendor sharing a registrable domain with an apis.yaml
    // row whose aggregators are absent.
    const apisFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skk-carriage-")), "apis.yaml");
    fs.writeFileSync(
      apisFile,
      [
        "version: 1",
        "entries:",
        "  - name: my-apollo",
        "    url: https://www.apollo.io",
        "    domain: api.apollo.io",
        "    access_mode: own-account",
        "    min_topup: null",
        "    billing_unit: null",
        "    signup_automatable: null",
        "    tos_notes: null",
        "    source: null",
        "    checked_date: null",
        "",
      ].join("\n"),
    );
    const index = loadApiIndex({
      apisFile,
      shardDirs: [SHARD_DIR],
      userIndexFile: null,
      home: NO_HOME,
    });
    const mine = index.entries.find((row) => row.name === "my-apollo");
    expect(mine?.aggregators?.filter((item) => item.carries).map((item) => item.name).sort()).toEqual([
      "glasser",
      "monid",
    ]);
    expect(mine?.aggregators_source).toContain("people-company-data.yaml");
    fs.rmSync(path.dirname(apisFile), { recursive: true, force: true });
  });

  it("never overwrites a row that states its own carriage", () => {
    const index = loadApiIndex({
      apisFile: APIS_YAML,
      shardDirs: [SHARD_DIR],
      userIndexFile: null,
      home: NO_HOME,
    });
    const apollo = index.entries.find((row) => row.name === "example-apollo-contacts");
    expect(apollo?.aggregators_source).toBeUndefined();
    const monid = apollo?.aggregators?.find((item) => item.name === "monid");
    expect(monid?.per_call_price).toBe(0.026);
  });
});

describe("index parse cache", () => {
  const dirs: string[] = [];
  const tmpDir = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-cache-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  };
  const apisYaml = (name: string): string =>
    [
      "version: 1",
      "entries:",
      `  - name: ${name}`,
      `    url: https://${name}.test/docs`,
      "    access_mode: own-account",
      "    min_topup: null",
      "    billing_unit: null",
      "    signup_automatable: null",
      "    tos_notes: null",
      "    source: null",
      "    checked_date: null",
      "",
    ].join("\n");
  const shardYaml = (id: string): string =>
    [
      "apis:",
      `  - id: "${id}"`,
      `    name: "${id}"`,
      '    capability: "Something a shard knows about."',
      '    category: "test-category"',
      `    provider_url: "https://${id}.test"`,
      '    access_mode: "own-account"',
      "    checked_date: 2026-10-24",
      "",
    ].join("\n");

  beforeEach(() => {
    clearApiIndexCache();
  });

  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
    clearApiIndexCache();
  });

  it("parses once and hands back the same index on the next call", () => {
    const home = tmpDir({ "apis.yaml": apisYaml("first") });
    const shards = tmpDir({ "a.yaml": shardYaml("shard-one") });
    const load = (): ReturnType<typeof loadApiIndex> =>
      loadApiIndex({
        apisFile: path.join(home, "apis.yaml"),
        shardDirs: [shards],
        userIndexFile: null,
        home: NO_HOME,
      });

    const first = load();
    expect(apiIndexCacheStats).toEqual({ hits: 0, misses: 1 });
    const second = load();
    // Identity, not equality: a second parse would have produced new objects.
    expect(second).toBe(first);
    expect(apiIndexCacheStats).toEqual({ hits: 1, misses: 1 });
    load();
    load();
    expect(apiIndexCacheStats.misses).toBe(1);
    expect(first.counts.total).toBe(2);
  });

  it("re-reads as soon as any of its files changes", () => {
    const home = tmpDir({ "apis.yaml": apisYaml("first") });
    const shards = tmpDir({ "a.yaml": shardYaml("shard-one") });
    const userFile = path.join(home, "discovered.yaml");
    const load = (): ReturnType<typeof loadApiIndex> =>
      loadApiIndex({
        apisFile: path.join(home, "apis.yaml"),
        shardDirs: [shards],
        userIndexFile: userFile,
        home: NO_HOME,
      });

    expect(load().entries.map((row) => row.name).sort()).toEqual(["first", "shard-one"]);
    expect(apiIndexCacheStats.misses).toBe(1);

    // 1. apis.yaml itself
    fs.writeFileSync(path.join(home, "apis.yaml"), apisYaml("renamed-vendor"));
    expect(load().entries.some((row) => row.name === "renamed-vendor")).toBe(true);
    expect(apiIndexCacheStats.misses).toBe(2);

    // 2. a shard appearing in a directory that was already being watched
    fs.writeFileSync(path.join(shards, "b.yaml"), shardYaml("shard-two"));
    expect(load().entries.some((row) => row.name === "shard-two")).toBe(true);
    expect(apiIndexCacheStats.misses).toBe(3);

    // 3. the user index being written for the first time, as propose_entry does
    fs.writeFileSync(userFile, apisYaml("discovered-vendor"));
    const after = load();
    expect(after.entries.some((row) => row.name === "discovered-vendor")).toBe(true);
    expect(after.counts.user_index).toBe(1);
    expect(apiIndexCacheStats.misses).toBe(4);

    // ... and then it settles again.
    load();
    expect(apiIndexCacheStats.misses).toBe(4);
  });

  it("caches each set of files separately, and `noCache` bypasses it", () => {
    const a = tmpDir({ "apis.yaml": apisYaml("vendor-a") });
    const b = tmpDir({ "apis.yaml": apisYaml("vendor-b") });
    const load = (dir: string, noCache = false): ReturnType<typeof loadApiIndex> =>
      loadApiIndex({
        apisFile: path.join(dir, "apis.yaml"),
        shardDirs: [],
        userIndexFile: null,
        home: NO_HOME,
        noCache,
      });

    expect(load(a).entries[0]?.name).toBe("vendor-a");
    expect(load(b).entries[0]?.name).toBe("vendor-b");
    expect(load(a)).toBe(load(a));
    expect(load(a)).not.toBe(load(b));
    expect(apiIndexCacheStats.misses).toBe(2);

    const cached = load(a);
    const fresh = load(a, true);
    expect(fresh).not.toBe(cached);
    expect(fresh.entries[0]?.name).toBe("vendor-a");
    expect(apiIndexCacheStats.misses).toBe(3);
    // ... and the fresh parse becomes the new cached one.
    expect(load(a)).toBe(fresh);
  });
});
