import { describe, expect, it } from "vitest";
import {
  USAGE_API_METHODS,
  readShardFile,
  shardFiles,
  validateApisFile,
  type IndexEntry,
  type UsageApiMethod,
} from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";
import path from "node:path";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");

/** Every row from every data/apis/*.yaml shard, read the same way find_api does. */
function allShardRows(): IndexEntry[] {
  const rows: IndexEntry[] = [];
  for (const file of shardFiles(SHARD_DIR)) {
    const { entries, errors } = readShardFile(file);
    expect(errors, file).toEqual([]);
    rows.push(...entries);
  }
  return rows;
}

describe("usage_api coverage across data/apis/*.yaml", () => {
  const rows = allShardRows();

  it("found rows to check (the shard directory is not empty)", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("every row outside llm-models carries a usage_api block, checked on 2026-11-24", () => {
    for (const row of rows) {
      if (row.category === "llm-models") continue;
      expect(row.usage_api, `${row.name} (${row.category}): missing usage_api`).not.toBeNull();
      const usageApi = row.usage_api!;
      expect([true, false, null], `${row.name}: usage_api.available`).toContain(usageApi.available);
      expect(usageApi.checked_date, `${row.name}: usage_api.checked_date`).toBe("2026-11-24");
      if (usageApi.available === true) {
        expect(usageApi.method, `${row.name}: usage_api.method`).not.toBeNull();
        expect(usageApi.path, `${row.name}: usage_api.path`).not.toBeNull();
        expect(usageApi.docs_url, `${row.name}: usage_api.docs_url`).not.toBeNull();
        expect(usageApi.docs_url, `${row.name}: usage_api.docs_url must be https`).toMatch(/^https:\/\//);
      }
    }
  });

  it("llm-models rows are allowed to omit usage_api entirely", () => {
    const llmRows = rows.filter((row) => row.category === "llm-models");
    expect(llmRows.length).toBeGreaterThan(0);
    for (const row of llmRows) {
      expect(row.usage_api, `${row.name}: expected llm-models rows to have no usage_api`).toBeNull();
    }
  });
});

describe("usage_api on apis.yaml's treg entry", () => {
  it("treg documents its own usage/billing API", () => {
    const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
    const treg = entries.find((row) => row.name === "treg");
    expect(treg, "apis.yaml should have a treg row").toBeDefined();
    expect(treg?.usage_api, "treg: missing usage_api").not.toBeNull();
    expect(treg?.usage_api?.checked_date).toBe("2026-11-24");
  });
});

describe("pinned usage_api facts (read off each vendor's own docs)", () => {
  const rows = allShardRows();
  const byId = new Map(rows.map((row) => [row.name, row]));

  function expectPinned(
    id: string,
    method: UsageApiMethod,
    pathValue: string,
    docsUrl: string,
  ): void {
    const row = byId.get(id);
    expect(row, `expected a shard row with id ${JSON.stringify(id)}`).toBeDefined();
    const usageApi = row!.usage_api;
    expect(usageApi, `${id}: missing usage_api`).not.toBeNull();
    expect(USAGE_API_METHODS, `${id}: method must be a real HTTP method`).toContain(usageApi!.method);
    expect(usageApi!.method, `${id}: method`).toBe(method);
    expect(usageApi!.path, `${id}: path`).toBe(pathValue);
    expect(usageApi!.docs_url, `${id}: docs_url`).toBe(docsUrl);
  }

  it("apify: GET /v2/users/me/usage/monthly", () => {
    expectPinned(
      "apify",
      "GET",
      "https://api.apify.com/v2/users/me/usage/monthly",
      "https://docs.apify.com/api/v2/users-me-usage-monthly-get",
    );
  });

  it("serpapi: GET /account.json", () => {
    expectPinned("serpapi", "GET", "https://serpapi.com/account.json", "https://serpapi.com/account-api");
  });

  it("firecrawl: GET /v2/team/credit-usage", () => {
    expectPinned(
      "firecrawl",
      "GET",
      "https://api.firecrawl.dev/v2/team/credit-usage",
      "https://docs.firecrawl.dev/api-reference/endpoint/credit-usage",
    );
  });

  it("apollo: POST /api/v1/usage_stats/credit_usage_stats", () => {
    expectPinned(
      "apollo",
      "POST",
      "https://api.apollo.io/api/v1/usage_stats/credit_usage_stats",
      "https://docs.apollo.io/reference/view-credit-usage-stats",
    );
  });

  it("exa: GET team-management/credits, limits mention support@exa.ai", () => {
    const exa = byId.get("exa");
    expect(exa?.usage_api?.method).toBe("GET");
    expect(exa?.usage_api?.path).toBe("https://admin-api.exa.ai/team-management/credits");
    expect(exa?.usage_api?.limits, "exa: limits should mention support@exa.ai").toMatch(/support@exa\.ai/);
  });

  it("github: GET /rate_limit, notes mention enhanced billing", () => {
    const github = byId.get("github");
    expect(github?.usage_api?.method).toBe("GET");
    expect(github?.usage_api?.path).toBe("https://api.github.com/rate_limit");
    expect(github?.usage_api?.notes, "github: notes should mention enhanced billing").toMatch(
      /enhanced billing/,
    );
  });
});
