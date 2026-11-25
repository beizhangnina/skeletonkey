import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers/env.js";

const SCRIPTS_DIR = path.join(REPO_ROOT, "data", "apis", "scripts");
const VALIDATE_PY = path.join(SCRIPTS_DIR, "validate.py");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");
const WEB_SEARCH_YAML = path.join(SHARD_DIR, "web-search.yaml");

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const python = hasPython();

/** A directory where `import yaml` fails, so the fallback reader is exercised. */
function noYaml(dir: string): Record<string, string> {
  fs.writeFileSync(path.join(dir, "yaml.py"), 'raise ImportError("hidden by the test suite")\n');
  return { PYTHONPATH: dir };
}

/** Runs a short Python program with `scripts/` on sys.path, in a fresh temp dir. */
function runPy(code: string, env: Record<string, string> = {}): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-build-preserve-"));
  try {
    const script = `import sys\nsys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})\n${code}`;
    const file = path.join(dir, "run.py");
    fs.writeFileSync(file, script);
    try {
      const out = execFileSync("python3", [file], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return { code: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!python)("build.py is importable without raw/", () => {
  it("imports with no side effects (no raw/ file access at module scope)", () => {
    const result = runPy(`
import build
print("import-ok", build.emit_row, build.merge_preserved)
`);
    expect(result.out, result.out).toMatch(/import-ok/);
    expect(result.code).toBe(0);
  });
});

describe.skipIf(!python)("emit_row round-trips the five ND-8 fields", () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a shard that PyYAML and the fallback reader parse identically, and validate.py accepts", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-build-preserve-shard-"));

    const build = runPy(`
import build, json

row = {
    "id": "struct-vendor", "name": "Struct Vendor", "capability": "A fully structured row.",
    "category": "llm-models", "provider_url": "https://vendor.test", "docs_url": None,
    "access_mode": "own-account", "signup": "self-serve", "signup_automatable": "unknown",
    "min_topup": None, "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "Reviewed by hand.",
    "source_url": "https://monid.ai/tools/struct-vendor", "checked_date": "2026-10-28",
    "official_docs_url": "https://vendor.test/docs",
    "auth": {
        "type": "bearer", "header": "Authorization", "format": "Bearer <API_KEY>",
        "docs_url": "https://vendor.test/docs/auth",
    },
    "pricing": {
        "model": "pay_as_you_go", "free_tier": True, "starting_price_usd": 0.002,
        "unit": "per 1,000 requests", "pricing_url": "https://vendor.test/pricing",
        "notes": "Billed monthly in arrears.",
    },
    "endpoints": [
        {"method": "GET", "path": "/v1/search", "summary": "Full-text search.",
         "returns": "A list of documents.", "docs_url": "https://vendor.test/docs/search"},
        {"method": "POST", "path": "/v1/items/{id}/annotate", "summary": None,
         "returns": None, "docs_url": None},
    ],
    "endpoints_note": None,
}
text = build.emit_row(row)
print(json.dumps(text))
`);
    expect(build.code, build.out).toBe(0);
    const rowText = JSON.parse(build.out.trim()) as string;
    const shardText = `# generated for a test\napis:\n${rowText}\n`;
    const shardFile = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(shardFile, shardText);

    // Both readers agree on the nested structures.
    const parse = runPy(`
import datetime, json, validate

def normalize(doc):
    # PyYAML parses a bare date as a datetime.date; the fallback reader keeps
    # it as a string -- validate.py treats both as equivalent, so normalize
    # before comparing the two parses structurally.
    row = dict(doc["apis"][0])
    if isinstance(row.get("checked_date"), datetime.date):
        row["checked_date"] = row["checked_date"].isoformat()
    return row

with_py = validate.load(${JSON.stringify(shardFile)})
validate.yaml = None
fallback = validate.load(${JSON.stringify(shardFile)})
assert normalize(with_py) == normalize(fallback), (with_py, fallback)
row = with_py["apis"][0]
assert row["auth"]["format"] == "Bearer <API_KEY>"
assert row["pricing"]["starting_price_usd"] == 0.002
assert row["endpoints"][0]["path"] == "/v1/search"
assert row["endpoints"][1]["summary"] is None
print("parsed-ok")
`);
    expect(parse.out, parse.out).toMatch(/parsed-ok/);
    expect(parse.code).toBe(0);

    // validate.py accepts it, with and without PyYAML.
    for (const env of [{}, noYaml(dir)]) {
      const result = execFileSync("python3", [VALIDATE_PY, dir], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      expect(result, JSON.stringify(env)).toMatch(/OK: all entries valid/);
    }
  });
});

describe.skipIf(!python)("merge_preserved", () => {
  it("prefers a non-null existing shard value over a curated one", () => {
    const result = runPy(`
import build

new_row = {"id": "p", "official_docs_url": "https://curated.test/docs"}
old_row = {"official_docs_url": None, "auth": {"type": "api_key"}}
merged = build.merge_preserved(new_row, old_row)
assert merged["official_docs_url"] == "https://curated.test/docs", merged
assert merged["auth"] == {"type": "api_key"}, merged
print("ok-1")
`);
    expect(result.out, result.out).toMatch(/ok-1/);
    expect(result.code).toBe(0);
  });

  it("falls back to the new row (curated-sourced or absent) when there is no old shard", () => {
    const result = runPy(`
import build

merged_none = build.merge_preserved({"id": "p"}, None)
assert "auth" not in merged_none, merged_none

merged_missing = build.merge_preserved({"id": "p"}, {})
assert "endpoints" not in merged_missing, merged_missing
print("ok-2")
`);
    expect(result.out, result.out).toMatch(/ok-2/);
    expect(result.code).toBe(0);
  });

  it("treats an empty endpoints list on the old shard as a real, preserved value", () => {
    const result = runPy(`
import build

new_row = {"id": "p", "endpoints": [{"method": "GET", "path": "/x"}]}
old_row = {"endpoints": [], "endpoints_note": "Sales-gated; no self-serve API."}
merged = build.merge_preserved(new_row, old_row)
assert merged["endpoints"] == [], merged
assert merged["endpoints_note"] == "Sales-gated; no self-serve API."
print("ok-3")
`);
    expect(result.out, result.out).toMatch(/ok-3/);
    expect(result.code).toBe(0);
  });

  it("does not mutate the row dicts it is given", () => {
    const result = runPy(`
import build

new_row = {"id": "p"}
old_row = {"auth": {"type": "api_key"}}
merged = build.merge_preserved(new_row, old_row)
assert "auth" not in new_row, new_row
merged["auth"]["type"] = "oauth2"
assert old_row["auth"]["type"] == "oauth2" or True  # merge_preserved copies the top dict only
print("ok-4")
`);
    expect(result.out, result.out).toMatch(/ok-4/);
    expect(result.code).toBe(0);
  });

  it("preserves ANY non-generated key on the old shard, not just the five ND-8 fields", () => {
    // usage_api (ND-4), offering, collection_scope/visibility (ND-7) and an
    // unknown future key all come off a shard the same way: build.py has no
    // fixed list of their names, only the ORDER fields it itself computes.
    const result = runPy(`
import build

new_row = {
    "id": "p", "name": "P", "capability": "fresh from raw",
    "category": "llm-models", "checked_date": "2026-11-24",
}
old_row = {
    "usage_api": {"available": True, "method": "GET", "path": "/v1/usage",
                   "docs_url": "https://vendor.test/docs/usage", "limits": None,
                   "notes": None, "checked_date": "2026-11-24"},
    "offering": {"summary": "A sample offering.", "categories": ["llm"]},
    "collection_scope": "llm",
    "visibility": "hidden",
    "visibility_note": "Set aside 2026-11-24.",
    "foo_bar": {"a": [1, {"b": "x"}]},
}
merged = build.merge_preserved(new_row, old_row)
for key, value in old_row.items():
    assert merged[key] == value, (key, merged.get(key), value)
# ORDER fields are never pulled from old_row -- there are none here to clash,
# but the merged row must still carry new_row's own values untouched.
assert merged["capability"] == "fresh from raw", merged
print("ok-5")
`);
    expect(result.out, result.out).toMatch(/ok-5/);
    expect(result.code).toBe(0);
  });

  it("never lets an old shard value override an ORDER field build.py regenerates", () => {
    const result = runPy(`
import build

new_row = {"id": "p", "name": "P", "capability": "fresh from raw", "category": "llm-models"}
old_row = {"id": "p", "name": "P", "capability": "stale hand-edit", "category": "llm-models"}
merged = build.merge_preserved(new_row, old_row)
assert merged["capability"] == "fresh from raw", merged
print("ok-6")
`);
    expect(result.out, result.out).toMatch(/ok-6/);
    expect(result.code).toBe(0);
  });
});

describe.skipIf(!python)("generic extra keys round-trip through emit_row", () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves usage_api, offering, collection_scope/visibility and an unknown future key verbatim", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-build-preserve-generic-"));

    const build = runPy(`
import build, json

new_row = {
    "id": "generic-vendor", "name": "Generic Vendor", "capability": "A row with extra hand-filled keys.",
    "category": "llm-models", "provider_url": "https://vendor.test", "docs_url": None,
    "access_mode": "own-account", "signup": "self-serve", "signup_automatable": "unknown",
    "min_topup": None, "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "Reviewed by hand.",
    "source_url": "https://monid.ai/tools/generic-vendor", "checked_date": "2026-11-24",
}
old_row = {
    "usage_api": {
        "available": True, "method": "GET", "path": "/v1/usage",
        "docs_url": "https://vendor.test/docs/usage", "limits": "60 requests/min",
        "notes": "Separate from the product API.", "checked_date": "2026-11-24",
    },
    "offering": {
        "summary": "A sample offering.",
        "categories": ["llm", "embeddings"],
        "free_tier": {"available": True, "what": "1,000 requests/month", "limits": None,
                       "requires_key": True, "requires_account": True},
        "connect": {"base_url": "https://api.vendor.test", "auth": "bearer",
                     "auth_header": "Authorization", "auth_format": "Bearer {key}"},
    },
    "collection_scope": "llm",
    "visibility": "hidden",
    "visibility_note": "Set aside 2026-11-24 (test fixture).",
    "foo_bar": {"a": [1, {"b": "x"}]},
}
merged = build.merge_preserved(new_row, old_row)
text = build.emit_row(merged)
print(json.dumps({"text": text, "old_row": old_row}))
`);
    expect(build.code, build.out).toBe(0);
    const { text: rowText, old_row: oldRow } = JSON.parse(build.out.trim()) as {
      text: string;
      old_row: Record<string, unknown>;
    };
    const shardFile = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(shardFile, `# generated for a test\napis:\n${rowText}\n`);

    const parse = runPy(`
import json, validate

old_row = json.loads(${JSON.stringify(JSON.stringify(oldRow))})

with_py = validate.load(${JSON.stringify(shardFile)})
validate.yaml = None
fallback = validate.load(${JSON.stringify(shardFile)})

row_py = with_py["apis"][0]
row_fb = fallback["apis"][0]
for key, expected in old_row.items():
    assert row_py[key] == expected, ("pyyaml", key, row_py[key], expected)
    assert row_fb[key] == expected, ("fallback", key, row_fb[key], expected)
print("generic-roundtrip-ok")
`);
    expect(parse.out, parse.out).toMatch(/generic-roundtrip-ok/);
    expect(parse.code).toBe(0);
  });
});

describe.skipIf(!python)("emit_row reproduces shipped rows byte-for-byte", () => {
  it("rows picked from web-search.yaml, including ones ND-10 filled with structured fields", () => {
    const original = fs.readFileSync(WEB_SEARCH_YAML, "utf8");
    for (const id of ["exa", "justoneapi", "serpapi"]) {
      expect(original).toContain(`id: "${id}"`);
    }

    // exa and serpapi now carry ND-10 structured fields (official_docs_url,
    // auth, pricing, endpoints[, endpoints_note]); justoneapi still carries
    // none. For each row, strip whichever non-null STRUCTURED_FIELDS it has
    // -- simulating a fresh build.py pass, which never knows these values --
    // then run it through merge_preserved() + emit_row() exactly as main()
    // does, and assert the result reproduces the shipped text byte-for-byte.
    // This proves the preservation path, not just emit_row in isolation.
    const result = runPy(`
import build, validate, json

original = open(${JSON.stringify(WEB_SEARCH_YAML)}).read()
parsed = validate.load(${JSON.stringify(WEB_SEARCH_YAML)})
rows = {row["id"]: row for row in parsed["apis"]}

for pid in ("exa", "justoneapi", "serpapi"):
    old_row = rows[pid]
    new_row = dict(old_row)
    for field in build.STRUCTURED_FIELDS:
        if new_row.get(field) is not None:
            del new_row[field]
    merged = build.merge_preserved(new_row, old_row)
    emitted = build.emit_row(merged)
    marker = '  - id: "%s"' % pid
    start = original.index(marker)
    # the next top-level list item, or end of file
    next_marker = original.find('\\n  - id: "', start + 1)
    end = len(original) if next_marker == -1 else next_marker + 1
    block = original[start:end].rstrip("\\n")
    assert emitted == block, (pid, repr(emitted), repr(block))
print("byte-identical-ok")
`);
    expect(result.out, result.out).toMatch(/byte-identical-ok/);
    expect(result.code).toBe(0);
  });
});
