import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readShardFile, shardFiles, type IndexEntry } from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

/**
 * ND-10: fills official_docs_url/endpoints/auth/pricing/endpoints_note into
 * data/apis/<category>.yaml from vendors' own official docs. These tests
 * assert the invariants the pipeline promises, against the real shards --
 * not a fixture copy of them -- plus a small fixture of which ids were in
 * scope as 'npa' (no public API) or excluded as 'llm-models', read from our
 * own research index at build time (see /workspace/eng/nd10-research).
 */

const VALIDATE_PY = path.join(REPO_ROOT, "data", "apis", "scripts", "validate.py");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");

const scopeFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "nd10-scope.json"), "utf8"),
) as {
  npa_rows: { id: string; category: string }[];
  llm_models_ids: string[];
};

function allEntries(): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const file of shardFiles(SHARD_DIR)) {
    const { entries: fileEntries, errors } = readShardFile(file);
    expect(errors, `${file} should parse with no errors`).toEqual([]);
    entries.push(...fileEntries);
  }
  return entries;
}

describe("ND-10 structured fields in the real shards", () => {
  it("python3 data/apis/scripts/validate.py passes", () => {
    const result = execFileSync("python3", [VALIDATE_PY], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result).toContain("OK: all entries valid");
  });

  it("every 'npa' (no public API) row has endpoints: [] plus a non-empty endpoints_note", () => {
    const byId = new Map(allEntries().map((e) => [e.name, e]));
    for (const { id, category } of scopeFixture.npa_rows) {
      const entry = byId.get(id);
      expect(entry, `${id} (${category}) should still be in a shard`).toBeDefined();
      expect(entry?.endpoints, `${id}.endpoints`).toEqual([]);
      expect(
        typeof entry?.endpoints_note === "string" && entry.endpoints_note.trim().length > 0,
        `${id}.endpoints_note should be a non-empty reason`,
      ).toBe(true);
    }
  });

  it("no llm-models row has endpoints filled (category is out of ND-10 scope)", () => {
    const byId = new Map(allEntries().map((e) => [e.name, e]));
    for (const id of scopeFixture.llm_models_ids) {
      const entry = byId.get(id);
      if (entry === undefined) continue; // not every excluded id is necessarily shipped
      expect(entry.endpoints ?? null, `${id}.endpoints`).toBeNull();
      expect(entry.official_docs_url ?? null, `${id}.official_docs_url`).toBeNull();
      expect(entry.auth ?? null, `${id}.auth`).toBeNull();
      expect(entry.pricing ?? null, `${id}.pricing`).toBeNull();
    }
  });

  it("every endpoint path across every shard starts with '/'", () => {
    for (const entry of allEntries()) {
      for (const ep of entry.endpoints ?? []) {
        expect(ep.path.startsWith("/"), `${entry.name}: endpoint path ${ep.path}`).toBe(true);
      }
    }
  });

  it("official_docs_url, when set, is an http(s) URL (never an aggregator page)", () => {
    const AGGREGATOR_HOSTS = ["glasser.ai", "monid.ai", "flatkey.ai", "treg.to", "rapidapi.com"];
    for (const entry of allEntries()) {
      const url = entry.official_docs_url;
      if (!url) continue;
      expect(url, `${entry.name}.official_docs_url`).toMatch(/^https?:\/\//);
      const host = new URL(url).hostname;
      for (const bad of AGGREGATOR_HOSTS) {
        expect(host.endsWith(bad), `${entry.name}.official_docs_url host ${host}`).toBe(false);
      }
    }
  });
});
