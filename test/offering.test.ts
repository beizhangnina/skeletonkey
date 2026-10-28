import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_MODES,
  CONNECT_AUTH_KINDS,
  ENTRY_STATUSES,
  HIGHLIGHTS_MAX,
  HIGHLIGHT_KINDS,
  OFFERING_CATEGORIES_MAX,
  OFFERING_SUMMARY_MAX,
  SERVICE_CATEGORIES,
  readShardFile,
  validateApis,
  validateApisFile,
  type VendorOffering,
} from "../src/apis.js";
import { promoteFromLedger, proposeEntry, readUserIndex } from "../src/discover.js";
import { openLedger } from "../src/ledger.js";
import { entryFreshness, staleTargets } from "../src/stale.js";
import { REPO_ROOT, makeHome, removeHome } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const VALIDATE_PY = path.join(REPO_ROOT, "data", "apis", "scripts", "validate.py");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");

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

/** A complete, valid offering: every rule below is a single deviation from it. */
function offering(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "One line about what the vendor sells.",
    categories: ["llm", "image"],
    endpoint_count: 12,
    model_count: 40,
    count_note: "Off the vendor's own catalog page; approximate.",
    free_tier: {
      available: true,
      what: "Vendor states 100 free calls a month on its pricing page.",
      limits: "100 calls/month",
      requires_key: true,
      requires_account: true,
    },
    connect: {
      base_url: "https://api.vendor.test/v1",
      auth: "bearer",
      auth_header: "Authorization",
      auth_format: "Bearer {key}",
    },
    catalog_url: "https://vendor.test/models",
    verified_url: "https://vendor.test/docs",
    verified_date: "2026-10-28",
    source_urls: ["https://vendor.test/docs", "https://vendor.test/pricing"],
    highlights: [
      { id: "vendor/model-a", kind: "model", free: true, note: "Vendor labels it free.", url: null },
      { id: "/v1/search", kind: "endpoint", free: null, note: null, url: "https://vendor.test/api" },
    ],
    ...overrides,
  };
}

/** Errors from validating one row with one offering block. */
function check(block: Record<string, unknown> | null | undefined): string[] {
  return validateApis({ version: 1, entries: [entry({ offering: block })] }).errors;
}

function errorsOf(overrides: Record<string, unknown>): string {
  return validateApis({ version: 1, entries: [entry(overrides)] }).errors.join(" | ");
}

/** python3 is not a dependency of this package, so its tests opt out politely. */
function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const python = hasPython();

describe("the offering block (Layer 1)", () => {
  it("is optional: a row without one is as valid as it ever was", () => {
    expect(validateApis({ version: 1, entries: [entry()] }).errors).toEqual([]);
    expect(check(null)).toEqual([]);
    expect(check(undefined)).toEqual([]);
  });

  it("accepts a fully populated block and keeps every field", () => {
    const result = validateApis({ version: 1, entries: [entry({ offering: offering() })] });
    expect(result.errors).toEqual([]);
    const stored = result.document?.entries[0]?.offering as VendorOffering;
    expect(stored.summary).toBe("One line about what the vendor sells.");
    expect(stored.categories).toEqual(["llm", "image"]);
    expect(stored.model_count).toBe(40);
    expect(stored.free_tier?.available).toBe(true);
    expect(stored.connect?.auth).toBe("bearer");
    expect(stored.catalog_url).toBe("https://vendor.test/models");
    expect(stored.highlights?.length).toBe(2);
  });

  it("normalises every unknown to an explicit null, never undefined", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ offering: { summary: "Only a summary." } })],
    });
    expect(result.errors).toEqual([]);
    const stored = result.document?.entries[0]?.offering as VendorOffering;
    for (const field of [
      "categories",
      "endpoint_count",
      "model_count",
      "count_note",
      "free_tier",
      "connect",
      "catalog_url",
      "verified_url",
      "verified_date",
      "source_urls",
      "highlights",
    ] as const) {
      expect(stored[field], field).toBeNull();
    }
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(check(offering({ free_tiers: "typo" })).join(" ")).toMatch(
      /offering\.free_tiers: unknown field/,
    );
  });

  it("keeps the summary to one line and a sane length", () => {
    expect(check(offering({ summary: "two\nlines" })).join(" ")).toMatch(
      /summary: expected a single line/,
    );
    expect(check(offering({ summary: "x".repeat(OFFERING_SUMMARY_MAX + 1) })).join(" ")).toMatch(
      new RegExp(`summary: expected at most ${OFFERING_SUMMARY_MAX} characters`),
    );
    expect(check(offering({ summary: "x".repeat(OFFERING_SUMMARY_MAX) }))).toEqual([]);
    expect(check(offering({ summary: "   " })).join(" ")).toMatch(/summary: expected a non-empty/);
  });

  it("takes service categories only from the closed list, deduped and capped", () => {
    expect(check(offering({ categories: ["llm", "not-a-thing"] })).join(" ")).toMatch(
      /categories: \["not-a-thing"\] not in llm \| embeddings/,
    );
    expect(check(offering({ categories: ["llm", "llm"] })).join(" ")).toMatch(
      /categories: has duplicates/,
    );
    expect(check(offering({ categories: [] })).join(" ")).toMatch(
      /categories: expected a non-empty list or null/,
    );
    const tooMany = SERVICE_CATEGORIES.slice(0, OFFERING_CATEGORIES_MAX + 1);
    expect(check(offering({ categories: [...tooMany] })).join(" ")).toMatch(
      new RegExp(`categories: expected at most ${OFFERING_CATEGORIES_MAX} categories`),
    );
    expect(check(offering({ categories: [...SERVICE_CATEGORIES.slice(0, OFFERING_CATEGORIES_MAX)] }))).toEqual(
      [],
    );
  });

  it("takes counts as non-negative integers, or null for `the vendor does not say`", () => {
    expect(check(offering({ endpoint_count: null, model_count: null }))).toEqual([]);
    expect(check(offering({ endpoint_count: -1 })).join(" ")).toMatch(
      /endpoint_count: expected a non-negative integer or null/,
    );
    expect(check(offering({ model_count: 4.5 })).join(" ")).toMatch(
      /model_count: expected a non-negative integer or null/,
    );
    expect(check(offering({ model_count: "lots" })).join(" ")).toMatch(/model_count: expected a non-negative/);
  });

  it("makes a free tier that claims to exist say what is free", () => {
    expect(
      check(offering({ free_tier: { available: true, what: null } })).join(" "),
    ).toMatch(/free_tier\.what: required when available is true/);
    expect(check(offering({ free_tier: { available: null, what: null } }))).toEqual([]);
    expect(
      check(offering({ free_tier: { available: false, what: "but here is one" } })).join(" "),
    ).toMatch(/free_tier\.what: must be null when available is false/);
    expect(
      check(offering({ free_tier: { available: false, limits: "no free tier at all" } })),
    ).toEqual([]);
    expect(check(offering({ free_tier: { available: "yes" } })).join(" ")).toMatch(
      /free_tier\.available: expected a boolean or null/,
    );
  });

  it("validates connect: a real base URL, an enum auth, and a {key} template", () => {
    expect(check(offering({ connect: { base_url: "ftp://vendor.test" } })).join(" ")).toMatch(
      /connect\.base_url: expected an http\(s\) URL or null/,
    );
    expect(check(offering({ connect: { auth: "magic" } })).join(" ")).toMatch(
      /connect\.auth: expected one of api_key \| bearer/,
    );
    expect(
      check(offering({ connect: { auth_header: "Authorization:", auth_format: "Bearer {key}" } })).join(" "),
    ).toMatch(/connect\.auth_header: expected a header name only/);
    expect(
      check(offering({ connect: { auth: "bearer", auth_header: "Authorization", auth_format: "Bearer xyz" } })).join(
        " ",
      ),
    ).toMatch(/connect\.auth_format: must contain the \{key\} placeholder/);
    expect(check(offering({ connect: { auth_format: "Bearer {key}" } })).join(" ")).toMatch(
      /connect\.auth_header: required when auth_format is set/,
    );
  });

  it("will not let `auth: none` sit beside a credential header", () => {
    expect(
      check(offering({ connect: { auth: "none", auth_header: "X-Key" } })).join(" "),
    ).toMatch(/connect\.auth: "none" contradicts auth_header "X-Key"/);
    // The honest keyless row: no auth, and no header to put one in.
    expect(
      check(offering({ connect: { base_url: "https://api.vendor.test", auth: "none" } })),
    ).toEqual([]);
  });

  it("requires the catalog URL and the provenance URLs to be URLs", () => {
    expect(check(offering({ catalog_url: "vendor.test/models" })).join(" ")).toMatch(
      /catalog_url: expected an http\(s\) URL or null/,
    );
    expect(check(offering({ source_urls: ["read it somewhere"] })).join(" ")).toMatch(
      /source_urls: expected a list of http\(s\) URLs or null/,
    );
  });

  it("requires verified_url and verified_date together, in both directions", () => {
    expect(check(offering({ verified_date: null })).join(" ")).toMatch(
      /verified_date: required when verified_url is set/,
    );
    expect(check(offering({ verified_url: null })).join(" ")).toMatch(
      /verified_url: required when verified_date is set/,
    );
    expect(check(offering({ verified_url: null, verified_date: null }))).toEqual([]);
    expect(check(offering({ verified_date: "28-10-2026" })).join(" ")).toMatch(
      /verified_date: expected an ISO date/,
    );
  });
});

describe("offering highlights (Layer 2)", () => {
  const withHighlights = (highlights: unknown): string[] => check(offering({ highlights }));

  it(`caps the sample at ${HIGHLIGHTS_MAX} so nobody copies a catalog in`, () => {
    const row = (n: number): Record<string, unknown> => ({ id: `m-${n}`, kind: "model" });
    const max = Array.from({ length: HIGHLIGHTS_MAX }, (_item, n) => row(n));
    expect(withHighlights(max)).toEqual([]);
    const over = [...max, row(HIGHLIGHTS_MAX)];
    expect(withHighlights(over).join(" ")).toMatch(
      new RegExp(`highlights: expected at most ${HIGHLIGHTS_MAX} entries, got ${HIGHLIGHTS_MAX + 1}`),
    );
    expect(withHighlights(over).join(" ")).toMatch(/offering\.catalog_url/);
  });

  it("rejects an empty list: null is how you say `none recorded`", () => {
    expect(withHighlights([]).join(" ")).toMatch(/highlights: expected a non-empty list or null/);
    expect(withHighlights(null)).toEqual([]);
  });

  it("needs an id and a kind on every row, and no duplicate ids", () => {
    expect(withHighlights([{ kind: "model" }]).join(" ")).toMatch(
      /highlights\[0\]\.id: expected a non-empty string/,
    );
    expect(withHighlights([{ id: "m", kind: "models" }]).join(" ")).toMatch(
      new RegExp(`highlights\\[0\\]\\.kind: expected one of ${HIGHLIGHT_KINDS.join(" \\| ")}`),
    );
    expect(
      withHighlights([
        { id: "m", kind: "model" },
        { id: "m", kind: "endpoint" },
      ]).join(" "),
    ).toMatch(/highlights\[1\]\.id: duplicate highlight "m"/);
  });

  it("keeps `free` a tri-state and `url` a URL", () => {
    expect(withHighlights([{ id: "m", kind: "model", free: "yes" }]).join(" ")).toMatch(
      /highlights\[0\]\.free: expected a boolean or null/,
    );
    expect(withHighlights([{ id: "m", kind: "model", url: "nowhere" }]).join(" ")).toMatch(
      /highlights\[0\]\.url: expected an http\(s\) URL or null/,
    );
    expect(withHighlights([{ id: "m", kind: "model", free: null, url: null }])).toEqual([]);
  });

  it("rejects an unknown field on a highlight row", () => {
    expect(withHighlights([{ id: "m", kind: "model", price: 0.01 }]).join(" ")).toMatch(
      /highlights\[0\]\.price: unknown field/,
    );
  });
});

describe("auth_required and auth_headers", () => {
  it("accepts the tri-state and keeps it on the entry", () => {
    for (const value of [true, false, null]) {
      expect(errorsOf({ auth_required: value }), String(value)).toBe("");
    }
    expect(errorsOf({ auth_required: "no" })).toMatch(/auth_required: expected a boolean or null/);
    const result = validateApis({ version: 1, entries: [entry({ auth_required: false })] });
    expect(result.document?.entries[0]?.auth_required).toBe(false);
  });

  it("will not let a row say `no credential needed` and name the header anyway", () => {
    expect(errorsOf({ auth_required: false, auth_header: "X-Key" })).toMatch(
      /auth_required: false contradicts auth_header "X-Key"/,
    );
    expect(
      errorsOf({
        auth_required: false,
        auth_headers: [{ header: "X-Key", format: "{key}" }],
      }),
    ).toMatch(/auth_required: false contradicts auth_headers having entries/);
  });

  it("accepts several credential headers, with element 0 matching the primary pair", () => {
    expect(
      errorsOf({
        auth_header: "X-Api-Key",
        auth_format: "{key}",
        auth_headers: [
          { header: "X-Api-Key", format: "{key}", note: "the key itself" },
          { header: "X-Api-Secret", format: "{key}", note: "the paired secret" },
        ],
      }),
    ).toBe("");
    expect(
      errorsOf({
        auth_header: "X-Api-Key",
        auth_format: "{key}",
        auth_headers: [{ header: "X-Api-Secret", format: "{key}" }],
      }),
    ).toMatch(/auth_headers\[0\]\.header: must match auth_header "X-Api-Key"/);
  });

  it("holds each extra header to the same rules as the primary one", () => {
    expect(errorsOf({ auth_headers: [{ header: "X-Key: ", format: "{key}" }] })).toMatch(
      /auth_headers\[0\]\.header: expected a header name only/,
    );
    expect(errorsOf({ auth_headers: [{ header: "X-Key", format: "abc" }] })).toMatch(
      /auth_headers\[0\]\.format: must contain the \{key\} placeholder/,
    );
    expect(
      errorsOf({
        auth_headers: [
          { header: "X-Key", format: "{key}" },
          { header: "x-key", format: "{key}" },
        ],
      }),
    ).toMatch(/auth_headers\[1\]\.header: duplicate header "x-key"/);
    expect(errorsOf({ auth_headers: [] })).toMatch(
      /auth_headers: expected a non-empty list or null/,
    );
    expect(
      errorsOf({
        auth_headers: Array.from({ length: 6 }, (_item, n) => ({ header: `X-${n}`, format: "{key}" })),
      }),
    ).toMatch(/auth_headers: expected at most 5 headers, got 6/);
  });
});

describe("the new access modes and the docs-verified status", () => {
  it("accepts keyless and wallet-x402", () => {
    expect(ACCESS_MODES).toContain("keyless");
    expect(ACCESS_MODES).toContain("wallet-x402");
    for (const mode of ACCESS_MODES) {
      expect(errorsOf({ access_mode: mode }), mode).toBe("");
    }
    expect(errorsOf({ access_mode: "crypto" })).toMatch(/access_mode: expected one of/);
  });

  it("accepts docs-verified, and says so in the error for anything else", () => {
    expect(ENTRY_STATUSES).toEqual(["unverified", "docs-verified", "verified"]);
    expect(errorsOf({ status: "docs-verified" })).toBe("");
    expect(errorsOf({ status: "docs_verified" })).toMatch(
      /status: expected one of unverified \| docs-verified \| verified or null/,
    );
  });

  it("does not warn that a docs-verified row was never checked", () => {
    // `checked_date` means a human reviewed the row. A docs-verified row has
    // not been through that, and already says so in its status.
    const warnings = entryFreshness(
      { ...(entry({ status: "docs-verified" }) as never), checked_date: null },
      { today: "2026-10-28" },
    ).warnings.join(" ");
    expect(warnings).not.toMatch(/no human has ever verified/);
    const plain = entryFreshness({ ...(entry() as never), checked_date: null }, { today: "2026-10-28" })
      .warnings.join(" ");
    expect(plain).toMatch(/no human has ever verified/);
  });

  it("re-checks offering.verified_url in stale-check, like a price URL", () => {
    const row = validateApis({
      version: 1,
      entries: [entry({ offering: offering() })],
    }).document?.entries[0];
    const targets = staleTargets([row as never]);
    const offeringTarget = targets.find((target) => target.field === "offering.verified_url");
    expect(offeringTarget?.url).toBe("https://vendor.test/docs");
    expect(offeringTarget?.verified_date).toBe("2026-10-28");
  });
});

describe("docs-verified through propose_entry and promotion", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = makeHome();
    file = path.join(home, "discovered.yaml");
  });
  afterEach(() => removeHome(home));

  const proposal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "demo-vendor",
    url: "https://vendor.test/docs",
    domain: "api.vendor.test",
    access_mode: "keyless",
    auth_required: false,
    source_urls: ["https://vendor.test/docs"],
    ...overrides,
  });

  it("keeps docs-verified (the one claim source_urls already backs)", () => {
    const result = proposeEntry(proposal({ status: "docs-verified" }), { file, today: "2026-10-28" });
    expect(result.errors).toEqual([]);
    expect(result.entry?.status).toBe("docs-verified");
  });

  it("still refuses to let an agent write `verified` for itself", () => {
    const result = proposeEntry(proposal({ status: "verified" }), { file, today: "2026-10-28" });
    expect(result.entry?.status).toBe("unverified");
    expect(result.notes.join(" ")).toMatch(/forced to `unverified`/);
    expect(result.notes.join(" ")).toMatch(/docs-verified/);
  });

  it("promotes a docs-verified row on the first 2xx through the proxy", () => {
    proposeEntry(proposal({ status: "docs-verified" }), { file, today: "2026-10-28" });
    const ledger = openLedger(home);
    ledger.record({ alias: null, domain: "api.vendor.test", status: 200, bytes: 12 });
    ledger.close();

    const promotion = promoteFromLedger({ file, home, today: "2026-10-28" });
    expect(promotion.promoted.map((row) => row.name)).toEqual(["demo-vendor"]);
    const stored = readUserIndex(file).document.entries[0];
    expect(stored?.status).toBe("verified");
    expect(stored?.promoted_by).toMatch(/^ledger: 200 from api\.vendor\.test at /);
  });

  it("round-trips an offering block through the user index", () => {
    const result = proposeEntry(proposal({ offering: offering() }), { file, today: "2026-10-28" });
    expect(result.errors).toEqual([]);
    const stored = readUserIndex(file).document.entries[0];
    expect(stored?.offering?.summary).toBe("One line about what the vendor sells.");
    expect(stored?.offering?.highlights?.length).toBe(2);
    expect(validateApisFile(file).errors).toEqual([]);
  });
});

describe("offerings on a generated shard row", () => {
  let dir: string;

  const shard = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-shard-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(file, body);
    return file;
  };

  const base = `apis:
  - id: "offer-vendor"
    name: "Offer Vendor"
    capability: "A shard row that carries an offering."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: null
    access_mode: "keyless"
    signup: "self-serve"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "none"
    seen_in: ["monid"]
    tos_notes: "Nothing reviewed."
    source_url: "https://monid.ai/tools/offer-vendor"
    checked_date: 2026-10-28
`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the offering onto the index entry", () => {
    const file = shard(`${base}    offering:
      summary: "A shard vendor with an offering."
      categories: ["llm"]
      catalog_url: "https://vendor.test/models"
      highlights:
        - id: "vendor/model-a"
          kind: "model"
          free: true
`);
    const { entries, errors } = readShardFile(file);
    expect(errors).toEqual([]);
    expect(entries[0]?.offering?.summary).toBe("A shard vendor with an offering.");
    expect(entries[0]?.offering?.categories).toEqual(["llm"]);
    expect(entries[0]?.offering?.highlights?.[0]?.free).toBe(true);
    // Unstated Layer 1 fields are null, not missing.
    expect(entries[0]?.offering?.model_count).toBeNull();
  });

  it("reports a malformed offering instead of throwing, and drops just that block", () => {
    const file = shard(`${base}    offering:
      summary: "Fine."
      categories: ["not-a-category"]
`);
    const { entries, errors } = readShardFile(file);
    expect(errors.join(" ")).toMatch(/offering\.categories: \["not-a-category"\] not in/);
    expect(entries[0]?.name).toBe("offer-vendor");
    expect(entries[0]?.offering).toBeNull();
  });

  it("turns auth_type: none into auth_required: false, and api_key into true", () => {
    const keyless = readShardFile(shard(base)).entries[0];
    expect(keyless?.auth_required).toBe(false);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    const keyed = readShardFile(shard(base.replace('"none"', '"api_key"'))).entries[0];
    expect(keyed?.auth_required).toBe(true);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    const unknown = readShardFile(shard(base.replace('"none"', '"unknown"'))).entries[0];
    expect(unknown?.auth_required).toBeNull();
  });
});

describe("the two validators agree", () => {
  const source = fs.readFileSync(VALIDATE_PY, "utf8");

  /** Pulls a python list-of-strings literal out of validate.py. */
  const pyList = (name: string): string[] => {
    const match = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source);
    expect(match, `${name} missing from validate.py`).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((hit) => hit[1] as string);
  };

  it("ships the same service categories in TypeScript and in python", () => {
    expect(pyList("SERVICE_CATEGORIES")).toEqual([...SERVICE_CATEGORIES]);
  });

  it("ships the same connect-auth kinds and highlight kinds", () => {
    expect(pyList("CONNECT_AUTH_KINDS")).toEqual([...CONNECT_AUTH_KINDS]);
    expect(pyList("HIGHLIGHT_KINDS")).toEqual([...HIGHLIGHT_KINDS]);
  });

  it("ships the same caps", () => {
    const number = (name: string): number =>
      Number(new RegExp(`${name} = (\\d+)`).exec(source)?.[1] ?? NaN);
    expect(number("HIGHLIGHTS_MAX")).toBe(HIGHLIGHTS_MAX);
    expect(number("OFFERING_SUMMARY_MAX")).toBe(OFFERING_SUMMARY_MAX);
    expect(number("OFFERING_CATEGORIES_MAX")).toBe(OFFERING_CATEGORIES_MAX);
  });

  it("knows the same access modes (plus the shards' own `unknown`)", () => {
    const modes = [...(/'access_mode': \{([^}]*)\}/.exec(source)?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (hit) => hit[1] as string,
    );
    expect(new Set(modes)).toEqual(new Set([...ACCESS_MODES, "unknown"]));
  });
});

describe.skipIf(!python)("data/apis/scripts/validate.py", () => {
  let dir: string;

  const run = (target: string, env: Record<string, string> = {}): { code: number; out: string } => {
    try {
      const out = execFileSync("python3", [VALIDATE_PY, target], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return { code: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  /** A directory where `import yaml` fails, so the fallback reader is exercised. */
  const noYaml = (): Record<string, string> => {
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-noyaml-"));
    fs.writeFileSync(path.join(stub, "yaml.py"), 'raise ImportError("hidden by the test suite")\n');
    return { PYTHONPATH: stub };
  };

  const write = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pyshard-"));
    fs.writeFileSync(path.join(dir, "llm-models.yaml"), body);
    return dir;
  };

  const row = (offeringBlock: string): string => `apis:
  - id: "py-vendor"
    name: "Py Vendor"
    capability: "A row for the python validator."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: null
    access_mode: "wallet-x402"
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
${offeringBlock}`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still passes on every shard shipped in the repo", () => {
    const result = run(SHARD_DIR);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("passes on the shipped shards with PyYAML unavailable, too", () => {
    const result = run(SHARD_DIR, noYaml());
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("accepts a nested offering block, with and without PyYAML", () => {
    const target = write(
      row(`    offering:
      summary: "One line about the vendor."
      categories: ["llm", "image"]
      endpoint_count: 12
      model_count: null
      count_note: >-
        Folded block scalars are part of the subset the fallback reader
        understands, so this note survives either parser.
      free_tier:
        available: true
        what: "Vendor states 100 free calls a month."
        limits: "100 calls/month"
        requires_key: false
        requires_account: false
      connect:
        base_url: "https://api.vendor.test/v1"
        auth: "none"
        auth_header: null
        auth_format: null
      catalog_url: "https://vendor.test/models"
      verified_url: "https://vendor.test/docs"
      verified_date: 2026-10-28
      source_urls:
        - https://vendor.test/docs
        - https://vendor.test/pricing
      highlights:
        - id: "vendor/model-a"
          kind: "model"
          free: true
          note: "Vendor labels this one free."
          url: "https://vendor.test/models/a"
        - id: "/v1/search"
          kind: "endpoint"
          free: null
          note: null
          url: null
`),
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.out, JSON.stringify(env)).toMatch(/OK: all entries valid/);
      expect(result.code).toBe(0);
    }
  });

  it("rejects the same mistakes the TypeScript validator rejects", () => {
    const target = write(
      row(`    offering:
      summary: "Fine."
      categories: ["llm", "not-a-category"]
      endpoint_count: -3
      free_tier:
        available: true
        limits: "none stated"
      connect:
        auth: "none"
        auth_header: "X-Key"
      catalog_url: "not-a-url"
      verified_url: "https://vendor.test/docs"
`),
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.out).toMatch(/categories: \['not-a-category'\] not in/);
      expect(result.out).toMatch(/endpoint_count: expected a non-negative integer or null/);
      expect(result.out).toMatch(/free_tier\.what: required when available is true/);
      expect(result.out).toMatch(/connect\.auth: "none" contradicts auth_header/);
      expect(result.out).toMatch(/catalog_url: expected an http\(s\) URL or null/);
      expect(result.out).toMatch(/verified_date: required when verified_url is set/);
    }
  });

  it("rejects more than the capped number of highlights", () => {
    const highlights = Array.from(
      { length: HIGHLIGHTS_MAX + 1 },
      (_item, n) => `        - id: "m-${n}"\n          kind: "model"`,
    ).join("\n");
    const target = write(row(`    offering:\n      highlights:\n${highlights}\n`));
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      new RegExp(`highlights: expected at most ${HIGHLIGHTS_MAX} entries, got ${HIGHLIGHTS_MAX + 1}`),
    );
  });

  it("rejects an unknown top-level key, as it always did", () => {
    const target = write(row(`    offerings: null\n`));
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/unexpected key `offerings`/);
  });
});

describe("the vendor rows added with the offering fields (T2)", () => {
  const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
  const byName = new Map(entries.map((row) => [row.name, row]));

  it("has exactly one NVIDIA row and one treg row", () => {
    expect(entries.filter((row) => row.name.includes("nvidia")).length).toBe(1);
    expect(entries.filter((row) => row.name === "treg").length).toBe(1);
  });

  it("states clearly which NVIDIA LLMs are free, in NVIDIA's own words", () => {
    const row = byName.get("nvidia-nim");
    const free = row?.offering?.free_tier;
    expect(free?.available).toBe(true);
    expect(free?.what).toMatch(/All\s+models offer a free trial tier with no credit card required/);
    expect(free?.requires_key).toBe(true);
    expect(free?.requires_account).toBe(true);
    // NVIDIA publishes no number, so the row must say that rather than invent one.
    expect(free?.limits).toMatch(/NVIDIA states NO number/);
    expect(free?.limits).toMatch(/unknown, not unlimited/);
    // Every highlighted model is one NVIDIA's own FAQ covers with that free tier.
    const highlights = row?.offering?.highlights ?? [];
    expect(highlights.length).toBeGreaterThan(4);
    expect(highlights.length).toBeLessThanOrEqual(HIGHLIGHTS_MAX);
    for (const item of highlights) expect(item.free, item.id).toBe(true);
  });

  it("records how to connect to NVIDIA, off NVIDIA's own pages", () => {
    const row = byName.get("nvidia-nim");
    expect(row?.offering?.connect?.base_url).toBe("https://integrate.api.nvidia.com/v1");
    expect(row?.offering?.connect?.auth).toBe("bearer");
    expect(row?.offering?.connect?.auth_header).toBe("Authorization");
    expect(row?.offering?.connect?.auth_format).toBe("Bearer {key}");
    expect(row?.base_url).toBe(row?.offering?.connect?.base_url);
    expect(row?.auth_required).toBe(true);
    expect(row?.offering?.catalog_url).toBe("https://build.nvidia.com/models");
    expect(row?.offering?.model_count).toBe(108);
  });

  it("records treg as an intermediary with its $1 one-off credit", () => {
    const row = byName.get("treg");
    expect(row?.access_mode).toBe("intermediary");
    expect(row?.offering?.free_tier?.available).toBe(true);
    expect(row?.offering?.free_tier?.what).toMatch(/\$1\.00 of credit once/);
    expect(row?.offering?.endpoint_count).toBe(4064);
    expect(row?.offering?.connect?.auth_header).toBe("X-Treg-Token");
    expect(row?.offering?.connect?.auth).toBe("api_key");
    expect(row?.offering?.catalog_url).toBe("https://treg.to/catalog");
    expect(row?.billing?.model).toBe("free_tier+payg");
  });

  it("sources both rows on the vendor's own domain, never an aggregator's", () => {
    for (const [name, host] of [
      ["nvidia-nim", /(^|\.)nvidia\.com$/],
      ["treg", /(^|\.)treg\.to$/],
    ] as const) {
      const row = byName.get(name);
      const urls = [
        row?.offering?.verified_url,
        row?.offering?.catalog_url,
        ...(row?.offering?.source_urls ?? []),
      ].filter((url): url is string => typeof url === "string");
      expect(urls.length, name).toBeGreaterThan(2);
      for (const url of urls) {
        expect(new URL(url).hostname, `${name}: ${url}`).toMatch(host);
      }
      expect(row?.offering?.verified_date, name).toBe("2026-10-28");
      expect(row?.checked_date, name).toBe("2026-10-28");
    }
  });

  it("gives both rows a one-line summary and categories from the closed list", () => {
    for (const name of ["nvidia-nim", "treg"] as const) {
      const offeringBlock = byName.get(name)?.offering;
      expect(offeringBlock?.summary, name).toMatch(/\S/);
      expect(offeringBlock?.summary?.includes("\n"), name).toBe(false);
      expect((offeringBlock?.summary ?? "").length, name).toBeLessThanOrEqual(OFFERING_SUMMARY_MAX);
      const categories = offeringBlock?.categories ?? [];
      expect(categories.length, name).toBeGreaterThan(0);
      for (const category of categories) expect(SERVICE_CATEGORIES).toContain(category);
    }
  });
});
