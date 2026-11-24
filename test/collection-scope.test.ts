/**
 * ND-7: catalog scope (Bei, 2026-11-24). Tool/data APIs and aggregators are
 * collected; LLM APIs are set aside -- hidden from listing/browsing surfaces
 * by default, never deleted. Covers:
 *   - the new `collection_scope` / `visibility` / `visibility_note` schema in
 *     both validators (TS src/apis.ts, python data/apis/scripts/validate.py)
 *   - the derivation table (effectiveCollectionScope / effectiveVisibility)
 *   - the real data this task touched: nvidia-nim, mistral-responses-api, the
 *     13 llm-models shard rows, treg
 *   - that listing surfaces (CLI `apis show`, MCP `find_api`) exclude hidden
 *     rows by default and expose an opt-in, while matching/routing (which use
 *     a key the agent already has) are unaffected
 *   - the site build's overlay-driven scope/visibility on apis.json/sitemap.xml
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  COLLECTION_SCOPES,
  VISIBILITIES,
  VISIBILITY_NOTE_MAX,
  effectiveCollectionScope,
  effectiveVisibility,
  loadApiIndex,
  readShardFile,
  validateApis,
  validateApisFile,
} from "../src/apis.js";
import { matchesCapability, rankByCapability } from "../src/match.js";
import { routeAccess } from "../src/routing.js";
import { callSkeletonKeyTool, type McpContext } from "../src/mcp.js";
import { REPO_ROOT, initWithKey, makeHome, removeHome, runCli } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const DISCOVERED_X = path.join(REPO_ROOT, "data", "discovered-x.yaml");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");
const VALIDATE_PY = path.join(REPO_ROOT, "data", "apis", "scripts", "validate.py");
const SITE_PUB = path.join(REPO_ROOT, "site", "public");

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

function errorsOf(overrides: Record<string, unknown>): string {
  return validateApis({ version: 1, entries: [entry(overrides)] }).errors.join(" | ");
}

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const python = hasPython();

// ---- TS validator: enum + shape errors -------------------------------------

describe("collection_scope / visibility / visibility_note validation (TS)", () => {
  it("is optional: a row without any of the three fields is as valid as before", () => {
    expect(validateApis({ version: 1, entries: [entry()] }).errors).toEqual([]);
  });

  it("accepts every value in the closed lists, and null", () => {
    for (const scope of COLLECTION_SCOPES) {
      expect(errorsOf({ collection_scope: scope })).toBe("");
    }
    for (const visibility of VISIBILITIES) {
      expect(errorsOf({ visibility })).toBe("");
    }
    expect(errorsOf({ collection_scope: null, visibility: null, visibility_note: null })).toBe("");
  });

  it("rejects a collection_scope outside tool|data|aggregator|llm", () => {
    expect(errorsOf({ collection_scope: "bogus" })).toBe(
      "entries[0].collection_scope: must be one of tool, data, aggregator, llm",
    );
  });

  it("rejects a visibility outside listed|hidden", () => {
    expect(errorsOf({ visibility: "bogus" })).toBe("entries[0].visibility: must be one of listed, hidden");
  });

  it("does NOT require a visibility_note when visibility is hidden", () => {
    // Deliberately not enforced -- see src/apis.ts validateCollectionFields.
    expect(errorsOf({ visibility: "hidden" })).toBe("");
  });

  it("keeps visibility_note to one line and under the cap", () => {
    expect(errorsOf({ visibility_note: "two\nlines" })).toMatch(
      /visibility_note: expected a single line/,
    );
    expect(errorsOf({ visibility_note: "x".repeat(VISIBILITY_NOTE_MAX + 1) })).toBe(
      `entries[0].visibility_note: expected at most ${VISIBILITY_NOTE_MAX} characters, got ${
        VISIBILITY_NOTE_MAX + 1
      }`,
    );
    expect(errorsOf({ visibility_note: "x".repeat(VISIBILITY_NOTE_MAX) })).toBe("");
    expect(errorsOf({ visibility_note: "   " })).toMatch(/visibility_note: expected a non-empty/);
  });

  it("rejects an unknown field (same as every other block)", () => {
    expect(errorsOf({ collection_scop: "tool" })).toMatch(/collection_scop: unknown field/);
  });
});

// ---- derivation table -------------------------------------------------------

describe("effectiveCollectionScope / effectiveVisibility derivation", () => {
  it("derives llm (hidden) from the llm-models shard category", () => {
    expect(effectiveCollectionScope({ category: "llm-models" })).toBe("llm");
    expect(effectiveVisibility({ category: "llm-models" })).toBe("hidden");
  });

  it("derives tool (listed) from each of the tool-scope shard categories", () => {
    for (const category of [
      "generative-media",
      "web-search",
      "web-scraping",
      "seo-marketing",
      "developer-infra",
      "communications",
      "contact-verification",
    ]) {
      expect(effectiveCollectionScope({ category }), category).toBe("tool");
      expect(effectiveVisibility({ category }), category).toBe("listed");
    }
  });

  it("derives data (listed) from any other shard category", () => {
    expect(effectiveCollectionScope({ category: "finance-markets" })).toBe("data");
    expect(effectiveVisibility({ category: "finance-markets" })).toBe("listed");
  });

  it("derives aggregator from access_mode: intermediary on a root (category-less) row", () => {
    expect(effectiveCollectionScope({ access_mode: "intermediary" })).toBe("aggregator");
    expect(effectiveVisibility({ access_mode: "intermediary" })).toBe("listed");
  });

  it("derives data from any other access_mode on a root row", () => {
    expect(effectiveCollectionScope({ access_mode: "own-account" })).toBe("data");
    expect(effectiveCollectionScope({})).toBe("data");
  });

  it("an explicit collection_scope always wins over category/access_mode", () => {
    expect(effectiveCollectionScope({ category: "llm-models", collection_scope: "tool" })).toBe("tool");
    // and visibility then derives off the OVERRIDDEN scope, not the category
    expect(effectiveVisibility({ category: "llm-models", collection_scope: "tool" })).toBe("listed");
  });

  it("an explicit visibility always wins over the derived default", () => {
    expect(effectiveVisibility({ category: "llm-models", visibility: "listed" })).toBe("listed");
    expect(effectiveVisibility({ category: "finance-markets", visibility: "hidden" })).toBe("hidden");
  });
});

// ---- real data this task touched -------------------------------------------

describe("real data: apis.yaml", () => {
  const doc = validateApisFile(APIS_YAML);
  it("validates clean", () => expect(doc.errors).toEqual([]));
  const byName = new Map((doc.document?.entries ?? []).map((row) => [row.name, row]));

  it("hides nvidia-nim (LLM API set aside) with a visibility_note", () => {
    const row = byName.get("nvidia-nim");
    expect(row?.collection_scope).toBe("llm");
    expect(effectiveVisibility(row as object)).toBe("hidden");
    expect(row?.visibility_note).toBeTruthy();
    expect((row?.visibility_note ?? "").length).toBeLessThanOrEqual(VISIBILITY_NOTE_MAX);
  });

  it("lists treg as an aggregator, not hidden", () => {
    const row = byName.get("treg");
    expect(row?.collection_scope).toBe("aggregator");
    expect(effectiveVisibility(row as object)).toBe("listed");
  });

  it("never describes treg as reaching every tool with one key", () => {
    const row = byName.get("treg");
    const summary = row?.offering?.summary ?? "";
    expect(summary.toLowerCase()).not.toMatch(/one key.*every|every.*one key/);
    expect(summary.toLowerCase()).toContain("intermediary");
  });
});

describe("real data: data/discovered-x.yaml", () => {
  // NOT validateApisFile(): this fixture carries a handful of PRE-EXISTING,
  // unrelated schema gaps (an `access_modes` field and an `auth_headers[].secret`
  // flag that src/apis.ts does not yet validate -- see test/schema-gaps.test.ts,
  // which already fails on main before this task). Those make the whole-file
  // validator return `document: null`, so this reads the raw YAML directly to
  // check just the two rows ND-7 touched.
  const raw = YAML.parse(fs.readFileSync(DISCOVERED_X, "utf8")) as {
    entries: Record<string, unknown>[];
  };
  const byName = new Map(raw.entries.map((row) => [row["name"], row]));

  it("hides mistral-responses-api (LLM API set aside) with a visibility_note", () => {
    const row = byName.get("mistral-responses-api") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["collection_scope"]).toBe("llm");
    expect(effectiveVisibility(row)).toBe("hidden");
    expect(row["visibility_note"]).toBeTruthy();
  });

  it("lists sunra-api as a generative-media tool, with a visibility_note on its LLM surface", () => {
    const row = byName.get("sunra-api") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.["collection_scope"]).toBe("tool");
    expect(effectiveCollectionScope(row as Record<string, unknown>)).toBe("tool");
    expect(row?.["visibility"]).toBe("listed");
    expect(effectiveVisibility(row as Record<string, unknown>)).toBe("listed");
    expect((row?.["visibility_note"] as string) ?? "").toMatch(/LLM/);
  });
});

describe("real data: data/apis/llm-models.yaml shard", () => {
  const { entries, errors } = readShardFile(path.join(SHARD_DIR, "llm-models.yaml"));
  it("reads clean", () => expect(errors).toEqual([]));
  it("has all 13 rows, every one effectively hidden", () => {
    expect(entries.length).toBe(13);
    for (const row of entries) {
      expect(effectiveCollectionScope(row), row.name).toBe("llm");
      expect(effectiveVisibility(row), row.name).toBe("hidden");
      expect(row.collection_scope, row.name).toBe("llm");
      expect(row.visibility, row.name).toBe("hidden");
      expect(row.visibility_note, row.name).toBeTruthy();
    }
  });
});

describe("real data: no generative-media row is hidden", () => {
  const { entries, errors } = readShardFile(path.join(SHARD_DIR, "generative-media.yaml"));
  it("reads clean", () => expect(errors).toEqual([]));
  it("every row counts as tool/listed", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const row of entries) {
      expect(effectiveCollectionScope(row), row.name).toBe("tool");
      expect(effectiveVisibility(row), row.name).toBe("listed");
    }
  });
});

describe("real data: the full merged index has no stray hidden rows outside the LLM set-aside", () => {
  it("every hidden row is collection_scope llm", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, home: makeHome(), userIndexFile: null });
    for (const row of index.entries) {
      if (effectiveVisibility(row) === "hidden") {
        expect(effectiveCollectionScope(row), row.name).toBe("llm");
      }
    }
  });
});

// ---- listing surfaces exclude hidden by default ----------------------------

describe("CLI: skeletonkey apis show", () => {
  let home: string;
  afterEach(() => removeHome(home));

  it("excludes a hidden row from a bare browse by default, includes it with --all", async () => {
    home = makeHome();
    const bare = await runCli(home, ["apis", "show", "--json", "--limit", "500"]);
    expect(bare.code).toBe(0);
    const bareNames = (JSON.parse(bare.stdout).entries as { name: string }[]).map((e) => e.name);
    expect(bareNames).not.toContain("nvidia-nim");

    const all = await runCli(home, ["apis", "show", "--json", "--limit", "500", "--all"]);
    expect(all.code).toBe(0);
    const allNames = (JSON.parse(all.stdout).entries as { name: string }[]).map((e) => e.name);
    expect(allNames).toContain("nvidia-nim");
  });

  it("excludes a hidden row from a capability search by default, includes it with --all", async () => {
    home = makeHome();
    const bare = await runCli(home, ["apis", "show", "chat completions", "--json", "--limit", "500"]);
    expect(bare.code).toBe(0);
    const bareNames = (JSON.parse(bare.stdout).entries as { name: string }[]).map((e) => e.name);
    expect(bareNames).not.toContain("nvidia-nim");

    const all = await runCli(home, [
      "apis",
      "show",
      "chat completions",
      "--json",
      "--limit",
      "500",
      "--all",
    ]);
    const allNames = (JSON.parse(all.stdout).entries as { name: string }[]).map((e) => e.name);
    expect(allNames).toContain("nvidia-nim");
  });

  it("an EXACT name lookup finds a hidden row even without --all (that's a lookup, not browsing)", async () => {
    home = makeHome();
    const result = await runCli(home, ["apis", "show", "nvidia-nim", "--json"]);
    expect(result.code).toBe(0);
    const names = (JSON.parse(result.stdout).entries as { name: string; visibility: string }[]);
    const row = names.find((e) => e.name === "nvidia-nim");
    expect(row).toBeDefined();
    expect(row?.visibility).toBe("hidden");
  });

  it("a listed aggregator (treg) shows up in a bare browse", async () => {
    home = makeHome();
    const result = await runCli(home, ["apis", "show", "--json", "--limit", "500"]);
    const names = (JSON.parse(result.stdout).entries as { name: string }[]).map((e) => e.name);
    expect(names).toContain("treg");
  });
});

describe("MCP: find_api", () => {
  let home: string;
  let ctx: McpContext;
  afterEach(() => removeHome(home));

  async function setup(): Promise<void> {
    home = makeHome();
    await initWithKey(home, { alias: "demo" });
    ctx = { home, apisFile: APIS_YAML, apiShardDirs: [SHARD_DIR], allowTtyPrompt: false };
  }

  it("leaves out a hidden row by default", async () => {
    await setup();
    const result = await callSkeletonKeyTool("find_api", { capability: "chat completions" }, ctx);
    const body = JSON.parse(result.content.map((p) => p.text).join(""));
    const names = (body.matches as { name: string }[]).map((m) => m.name);
    expect(names).not.toContain("nvidia-nim");
    expect(body.include_hidden).toBe(false);
  });

  it("includes it when include_hidden: true", async () => {
    await setup();
    const result = await callSkeletonKeyTool(
      "find_api",
      { capability: "chat completions", include_hidden: true },
      ctx,
    );
    const body = JSON.parse(result.content.map((p) => p.text).join(""));
    const names = (body.matches as { name: string }[]).map((m) => m.name);
    expect(names).toContain("nvidia-nim");
    const row = (body.matches as { name: string; visibility: string }[]).find(
      (m) => m.name === "nvidia-nim",
    );
    expect(row?.visibility).toBe("hidden");
  });
});

// ---- matching/routing are NOT affected by visibility -----------------------

describe("matching and routing ignore visibility", () => {
  it("a hidden row still matches a capability query (visibility is a listing filter, not a match filter)", () => {
    const hidden = entry({
      name: "hidden-llm-vendor",
      category: "llm-models",
      capabilities: ["chat completions"],
    }) as Record<string, unknown>;
    expect(matchesCapability(hidden as never, "chat completions")).toBe(true);
    expect(rankByCapability([hidden as never], "chat completions").length).toBe(1);
  });

  it("routeAccess does not look at collection_scope/visibility at all", () => {
    const hidden = {
      ...entry({ name: "hidden-llm-vendor", access_mode: "own-account" }),
      collection_scope: "llm",
      visibility: "hidden",
    } as never;
    const listed = {
      ...entry({ name: "listed-vendor", access_mode: "own-account" }),
      collection_scope: "data",
      visibility: "listed",
    } as never;
    // Same access_mode, same everything else that matters to routing -> same route.
    expect(routeAccess(hidden, { hasKey: true }).route).toBe(routeAccess(listed, { hasKey: true }).route);
  });

  it("request_access finds a hidden vendor by exact name (uses a key the agent already has)", async () => {
    const home = makeHome();
    try {
      await initWithKey(home, {
        alias: "nim-personal",
        domain: "integrate.api.nvidia.com",
      });
      const ctx: McpContext = { home, apisFile: APIS_YAML, apiShardDirs: [SHARD_DIR], allowTtyPrompt: false };
      const result = await callSkeletonKeyTool("request_access", { platform: "nvidia-nim" }, ctx);
      const body = JSON.parse(result.content.map((p) => p.text).join(""));
      expect(body.has_key).toBe(true);
      expect(body.alias).toBe("nim-personal");
    } finally {
      removeHome(home);
    }
  });
});

// ---- the two validators agree (drift) --------------------------------------

describe("the two validators agree on collection scope", () => {
  const source = fs.readFileSync(VALIDATE_PY, "utf8");

  const pyList = (name: string): string[] => {
    const match = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source);
    expect(match, `${name} missing from validate.py`).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((hit) => hit[1] as string);
  };

  const pySet = (name: string): Set<string> => {
    const match = new RegExp(`${name} = \\{([^}]*)\\}`).exec(source);
    expect(match, `${name} missing from validate.py`).not.toBeNull();
    return new Set([...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((hit) => hit[1] as string));
  };

  it("ships the same collection scopes and visibilities", () => {
    expect(pyList("COLLECTION_SCOPES")).toEqual([...COLLECTION_SCOPES]);
    expect(pyList("VISIBILITIES")).toEqual([...VISIBILITIES]);
  });

  it("ships the same visibility_note cap", () => {
    const number = Number(/VISIBILITY_NOTE_MAX = (\d+)/.exec(source)?.[1] ?? NaN);
    expect(number).toBe(VISIBILITY_NOTE_MAX);
  });

  it("ships the same tool-scope category set", () => {
    const tsSet = new Set<string>();
    for (const category of [
      "generative-media",
      "web-search",
      "web-scraping",
      "seo-marketing",
      "developer-infra",
      "communications",
      "contact-verification",
    ]) {
      tsSet.add(category);
    }
    expect(pySet("TOOL_SCOPE_CATEGORIES")).toEqual(tsSet);
  });
});

// ---- python validate.py on temp fixtures -----------------------------------

describe.skipIf(!python)("data/apis/scripts/validate.py: collection_scope/visibility", () => {
  let dir: string | undefined;

  const run = (target: string): { code: number; out: string } => {
    try {
      const out = execFileSync("python3", [VALIDATE_PY, target], { encoding: "utf8" });
      return { code: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  const write = (extra: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pyscope-"));
    fs.writeFileSync(
      path.join(dir, "llm-models.yaml"),
      `apis:
  - id: "py-vendor"
    name: "Py Vendor"
    capability: "A row for the python validator."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: null
    access_mode: "own-account"
    signup: "unknown"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "none"
    seen_in: ["monid"]
    tos_notes: "Nothing reviewed."
    source_url: "https://monid.ai/tools/py-vendor"
    checked_date: 2026-10-28
${extra}`,
    );
    return dir;
  };

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts valid collection_scope/visibility/visibility_note", () => {
    const target = write(
      `    collection_scope: "llm"
    visibility: "hidden"
    visibility_note: "Set aside 2026-11-24."
`,
    );
    const result = run(target);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("rejects an invalid collection_scope", () => {
    const target = write(`    collection_scope: "bogus"\n`);
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/collection_scope: must be one of tool, data, aggregator, llm/);
  });

  it("rejects an invalid visibility", () => {
    const target = write(`    visibility: "bogus"\n`);
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/visibility: must be one of listed, hidden/);
  });

  it("rejects a multi-line visibility_note", () => {
    // A double-quoted YAML scalar folds a literal newline in the source into a
    // space, so an embedded \n needs the escape sequence instead.
    const target = write(`    visibility_note: "line one\\nline two"\n`);
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/visibility_note: expected a single line/);
  });

  it("does not require visibility_note when visibility is hidden", () => {
    const target = write(`    visibility: "hidden"\n`);
    const result = run(target);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("still passes on every shard shipped in the repo (now including llm-models.yaml's new fields)", () => {
    const result = run(SHARD_DIR);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });
});

// ---- site build: apis.json / sitemap.xml -----------------------------------

const APIS_JSON = path.join(SITE_PUB, "apis.json");
const SITEMAP = path.join(SITE_PUB, "sitemap.xml");

describe.skipIf(!python || !fs.existsSync(APIS_JSON))(
  "site build: apis.json lists no llm row, sitemap.xml has no hidden slug",
  () => {
    it("apis.json: no row with collection_scope llm is visibility listed; sitemap has no hidden slug", () => {
      const script = `
import json
d = json.load(open(${JSON.stringify(APIS_JSON)}))
bad = [x['slug'] for x in d['apis'] if x.get('collection_scope') == 'llm' and x.get('visibility') == 'listed']
assert not bad, bad
hidden = {x['slug'] for x in d['apis'] if x.get('visibility') == 'hidden'}
hidden |= {a['slug'] for a in d['aggregators'] if a.get('visibility') == 'hidden'}
sitemap = open(${JSON.stringify(SITEMAP)}).read()
leaked = [s for s in hidden if f'/apis/{s}/' in sitemap or f'/apis/aggregators/{s}/' in sitemap]
assert not leaked, leaked
print("OK", len(hidden), "hidden slugs, none in sitemap")
`;
      const out = execFileSync("python3", ["-c", script], { encoding: "utf8" });
      expect(out).toMatch(/^OK/);
    });
  },
);
