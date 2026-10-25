import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadApiIndex, type ApiEntry } from "../src/apis.js";
import {
  CAPABILITY_STOPWORDS,
  matchesCapability,
  queryTokens,
  rankByCapability,
  scoreCapability,
  stemWord,
  tokenize,
} from "../src/match.js";
import { REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");
const NO_HOME = path.join(os.tmpdir(), "skeletonkey-no-such-home");

/** The real merged index: apis.yaml + every generated shard, no user index. */
const index = loadApiIndex({
  apisFile: APIS_YAML,
  home: NO_HOME,
  shardDirs: [SHARD_DIR],
  userIndexFile: null,
});

const names = (capability: string): string[] =>
  rankByCapability(index.entries, capability).map((row) => row.entry.name);

function entry(overrides: Partial<ApiEntry> = {}): ApiEntry {
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

describe("capability tokens", () => {
  it("splits on whole words and stems the query and the row the same way", () => {
    expect(tokenize("Web Scraping")).toEqual(["web", "scrap"]);
    expect(tokenize("scrape")).toEqual(["scrap"]);
    expect(stemWord("tweets")).toBe(stemWord("tweet"));
    expect(stemWord("companies")).toBe(stemWord("company"));
    expect(stemWord("addresses")).toBe(stemWord("address"));
    expect(stemWord("crawling")).toBe(stemWord("crawl"));
  });

  it("drops the words every query shares, and says which", () => {
    const { tokens, ignored } = queryTokens("any data api for CVE lookup");
    expect(tokens).toEqual(["cve"]);
    expect(ignored).toEqual(["any", "data", "api", "for", "lookup"]);
    for (const word of ["any", "data", "api", "search", "lookup", "the", "for", "platform"]) {
      expect(CAPABILITY_STOPWORDS.has(word), word).toBe(true);
    }
  });

  it("keeps words that really are capabilities", () => {
    // `company` contains `any`, which is exactly what the substring matcher
    // tripped over; as a whole word it is a capability, not noise.
    expect(queryTokens("company enrichment").tokens).toEqual(["company", "enrichment"]);
    expect(queryTokens("b2b contacts").tokens).toEqual(["b2b", "contact"]);
  });
});

describe("matchesCapability", () => {
  it("never matches a word inside another word", () => {
    const row = entry({ name: "the-companies-api", capabilities: ["company data"] });
    // "any" is a substring of "comp-any-", and this used to return 41 rows.
    expect(matchesCapability(row, "any")).toBe(false);
    expect(matchesCapability(row, "company")).toBe(true);
  });

  it("returns nothing for a nonsense query", () => {
    expect(names("zzz-vendor-not-in-any-index")).toEqual([]);
    expect(names("zzz-nothing-like-this")).toEqual([]);
    expect(names("zzz-nonexistent-capability")).toEqual([]);
    expect(names("qqqqq wwwww")).toEqual([]);
  });

  it("returns nothing for a capability the index genuinely lacks", () => {
    // The miss that sent an agent to bid-cars, hlrlookup and prospeo, because
    // each of their descriptions contains the word "lookup".
    expect(names("CVE lookup")).toEqual([]);
    expect(names("vulnerability lookup")).toEqual([]);
  });

  it("returns nothing when the whole query is generic words", () => {
    expect(names("data")).toEqual([]);
    expect(names("any data api")).toEqual([]);
    expect(names("the best api platform")).toEqual([]);
  });

  it("still finds the real vendors an agent asks for", () => {
    expect(names("embeddings")).toContain("example-voyage-embeddings");
    expect(names("web scraping")).toContain("example-apify-scraping");
    expect(names("scrape a website")).toContain("example-apify-scraping");
    expect(names("tweets")).toContain("example-x-twitter-api");
    expect(names("twitter")).toContain("example-x-twitter-api");
    expect(names("Apollo")).toContain("example-apollo-contacts");
    expect(names("B2B contact data enrichment")).toContain("example-apollo-contacts");
    expect(names("email finder")).toContain("example-dropleads-contacts");
    expect(names("DropLeads")).toContain("example-dropleads-contacts");
    // And a provider only the generated shards know about.
    expect(names("technographics")).toContain("builtwith");
    expect(names("builtwith")).toContain("builtwith");
  });

  it("matches the vendor's own API domain", () => {
    const row = entry({ name: "row", domain: "api.voyageai.com" });
    expect(matchesCapability(row, "voyageai")).toBe(true);
    // ... but not the registry suffix every second vendor shares.
    expect(matchesCapability(row, "com")).toBe(false);
    expect(matchesCapability(entry({ name: "row", domain: "api.thing.io" }), "io")).toBe(false);
  });

  it("an empty capability means everything; a generic one means nothing", () => {
    const row = entry({ name: "row", capabilities: ["embeddings"] });
    expect(matchesCapability(row, "")).toBe(true);
    expect(matchesCapability(row, "   ")).toBe(true);
    expect(matchesCapability(row, "api")).toBe(false);
  });

  it("needs half the query, or the vendor's own name", () => {
    const row = entry({ name: "acme", capabilities: ["invoice parsing"] });
    // One of two words is enough...
    expect(matchesCapability(row, "invoice extraction")).toBe(true);
    // ... one of four is not, unless it is the vendor's name.
    expect(matchesCapability(row, "invoice shipping tracking numbers")).toBe(false);
    expect(matchesCapability(row, "acme shipping tracking numbers")).toBe(true);
  });
});

describe("scoring", () => {
  it("weights the name and domain above a tag, and a tag above prose", () => {
    const named = entry({ name: "finbox" });
    const tagged = entry({ name: "other", capabilities: ["finbox"] });
    const prosed = entry({
      name: "other",
      capabilities: ["A long description that happens to mention finbox somewhere in the middle"],
    });
    const score = (row: ApiEntry): number => scoreCapability(row, "finbox").score;
    expect(score(named)).toBeGreaterThan(score(tagged));
    expect(score(tagged)).toBeGreaterThan(score(prosed));
    expect(score(prosed)).toBeGreaterThan(0);
  });

  it("ranks the best evidence first and keeps index order for ties", () => {
    const ranked = rankByCapability(index.entries, "company enrichment");
    expect(ranked.length).toBeGreaterThan(3);
    expect(ranked[0]?.entry.name).toBe("example-apollo-contacts");
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]?.score.score).toBeGreaterThanOrEqual(ranked[i]?.score.score ?? 0);
    }
    // The hand-written row beats the generated shard row for the same vendor.
    expect(ranked[0]?.entry.origin).toBe("apis.yaml");
  });

  it("reports what matched and what did not", () => {
    const row = index.entries.find((item) => item.name === "example-apollo-contacts");
    expect(row).toBeDefined();
    const score = scoreCapability(row as ApiEntry, "apollo b2b contact enrichment via api");
    expect(score.matched).toContain("apollo");
    expect(score.ignored).toContain("api");
    expect(score.ignored).toContain("via");
    expect(score.best_weight).toBe(3);
    expect(score.matches).toBe(true);
  });

  it("does not drown a nonsense query in the whole index", () => {
    // The symptom of the old matcher: 41 of 168 rows for a query that names
    // nothing. Anything that matches a third of the index is not a match.
    const junk = ["zzz-vendor-not-in-any-index", "xyzzy", "flurble wibble"];
    for (const query of junk) {
      expect(rankByCapability(index.entries, query).length, query).toBe(0);
    }
  });
});
