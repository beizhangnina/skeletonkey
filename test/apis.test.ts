import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCESS_MODES, matchesCapability, validateApis, validateApisFile } from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");

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

describe("apis.yaml shipped with the repo", () => {
  it("validates against the documented schema", () => {
    const result = validateApisFile(APIS_YAML);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("ships only example rows, never a real offer", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const row of entries) expect(row.example, row.name).toBe(true);
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

  it("invents no prices: every example entry has a null min_topup", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    for (const row of entries) {
      expect(row.min_topup, row.name).toBeNull();
      // Unverified rows must not claim a check date.
      expect(row.checked_date, row.name).toBeNull();
    }
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
