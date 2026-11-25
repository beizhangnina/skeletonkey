import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALTERNATIVE_ACCESS_GATES,
  ALTERNATIVES_NOTE_MAX,
  ALTERNATIVES_WHY_MAX,
  API_ACCESS_GATES,
  COST_BADGES,
  collectKnownVendorIds,
  deriveCostBadge,
  readShardFile,
  validateApis,
  validateApisFile,
} from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const VALIDATE_PY = path.join(REPO_ROOT, "data", "apis", "scripts", "validate.py");
const DERIVE_BADGE_PY = path.join(REPO_ROOT, "data", "apis", "scripts", "derive_cost_badge.py");
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

/** A complete, valid fixture row: gated with every ND-12 field filled in. */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return entry({
    pricing: {
      model: "subscription",
      free_tier: null,
      starting_price_usd: null,
      unit: null,
      pricing_url: "https://vendor.test/pricing",
      notes: null,
      api_access_gate: "subscription_required",
      min_monthly_usd: 49,
      min_prepay_usd: null,
      gate_source_url: "https://vendor.test/pricing",
    },
    alternatives: [{ vendor_id: "other-thing", why: "A pay-as-you-go gateway covers the same capability.", access_gate: "none" }],
    alternatives_note: null,
    ...overrides,
  });
}

function errorsOf(
  overrides: Record<string, unknown>,
  options?: { knownVendorIds?: Iterable<string> },
): string[] {
  return validateApis({ version: 1, entries: [entry(overrides)] }, options).errors;
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

describe("existing data stays valid", () => {
  it("apis.yaml still validates with the pricing-gate fields added to the schema", () => {
    expect(validateApisFile(APIS_YAML).errors).toEqual([]);
  });

  it("every shipped shard still validates", () => {
    const knownVendorIds = collectKnownVendorIds({ apisFile: APIS_YAML, shardDirs: [SHARD_DIR] });
    for (const file of fs.readdirSync(SHARD_DIR).filter((name) => name.endsWith(".yaml"))) {
      const { errors } = readShardFile(path.join(SHARD_DIR, file), knownVendorIds);
      expect(errors, file).toEqual([]);
    }
  });

  it("a plain row with none of the new fields is as valid as it ever was", () => {
    expect(validateApis({ version: 1, entries: [entry()] }).errors).toEqual([]);
  });
});

describe("a full valid gated fixture row", () => {
  it("round-trips with no errors when its alternative is in the same document", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ name: "other-thing" }), fixture()],
    });
    expect(result.errors).toEqual([]);
    const stored = result.document?.entries[1];
    expect(stored?.pricing?.api_access_gate).toBe("subscription_required");
    expect(stored?.pricing?.min_monthly_usd).toBe(49);
    expect(stored?.alternatives?.[0]?.vendor_id).toBe("other-thing");
    expect(stored?.alternatives_note).toBeNull();
  });

  it("accepts an explicit knownVendorIds option instead of a same-document reference", () => {
    expect(errorsOf(fixture(), { knownVendorIds: ["other-thing"] })).toEqual([]);
  });
});

/** A self-consistent `pricing` + row-level fields for one gate, so testing
 * the enum alone does not also trip the gate_source_url / alternatives
 * requirements that gate implies. */
function rowForGate(gate: string): Record<string, unknown> {
  const pricing: Record<string, unknown> = { api_access_gate: gate };
  if (gate !== "unknown") pricing["gate_source_url"] = "https://vendor.test/pricing";
  if (gate === "subscription_required") pricing["min_monthly_usd"] = 10;
  if (gate === "prepaid_min") pricing["min_prepay_usd"] = 10;
  const row: Record<string, unknown> = { pricing };
  if (gate === "subscription_required" || gate === "contact_sales") {
    row["alternatives"] = [];
    row["alternatives_note"] = "No alternative recorded yet.";
  }
  return row;
}

describe("pricing.api_access_gate", () => {
  it("takes its value only from the closed list, or null", () => {
    expect(errorsOf({ pricing: { api_access_gate: "paywalled" } }).join(" ")).toMatch(
      new RegExp(`pricing\\.api_access_gate: expected one of ${API_ACCESS_GATES.join(" \\| ")} or null`),
    );
    for (const gate of API_ACCESS_GATES) {
      expect(errorsOf(rowForGate(gate)), gate).toEqual([]);
    }
    expect(errorsOf({ pricing: { api_access_gate: null } })).toEqual([]);
  });
});

describe("pricing.min_monthly_usd", () => {
  it("is only allowed when the gate is subscription_required", () => {
    expect(
      errorsOf({ pricing: { api_access_gate: "prepaid_min", min_monthly_usd: 10 } }).join(" "),
    ).toMatch(/pricing\.min_monthly_usd: only allowed when pricing\.api_access_gate is subscription_required/);
    expect(errorsOf(rowForGate("subscription_required"))).toEqual([]);
  });

  it("is never negative", () => {
    expect(
      errorsOf({
        pricing: { api_access_gate: "subscription_required", min_monthly_usd: -1, gate_source_url: "https://vendor.test/pricing" },
      }).join(" "),
    ).toMatch(/pricing\.min_monthly_usd: expected a non-negative number or null/);
  });
});

describe("pricing.min_prepay_usd", () => {
  it("is only allowed when the gate is prepaid_min", () => {
    expect(
      errorsOf({ pricing: { api_access_gate: "subscription_required", min_prepay_usd: 10, gate_source_url: "https://vendor.test/pricing" } }).join(" "),
    ).toMatch(/pricing\.min_prepay_usd: only allowed when pricing\.api_access_gate is prepaid_min/);
    expect(
      errorsOf({
        pricing: { api_access_gate: "prepaid_min", min_prepay_usd: 10, gate_source_url: "https://vendor.test/pricing" },
      }),
    ).toEqual([]);
  });

  it("is never negative", () => {
    expect(
      errorsOf({
        pricing: { api_access_gate: "prepaid_min", min_prepay_usd: -1, gate_source_url: "https://vendor.test/pricing" },
      }).join(" "),
    ).toMatch(/pricing\.min_prepay_usd: expected a non-negative number or null/);
  });
});

describe("pricing.gate_source_url", () => {
  it("must be an http(s) URL or null", () => {
    expect(errorsOf({ pricing: { gate_source_url: "vendor.test/pricing" } }).join(" ")).toMatch(
      /pricing\.gate_source_url: expected an http\(s\) URL or null/,
    );
  });

  it("is required whenever the gate is set and not unknown", () => {
    expect(errorsOf({ pricing: { api_access_gate: "none" } }).join(" ")).toMatch(
      /pricing\.gate_source_url: required when pricing\.api_access_gate is set and not unknown/,
    );
    expect(errorsOf({ pricing: { api_access_gate: "unknown" } })).toEqual([]);
    expect(errorsOf({ pricing: { api_access_gate: null } })).toEqual([]);
    expect(
      errorsOf({ pricing: { api_access_gate: "none", gate_source_url: "https://vendor.test/pricing" } }),
    ).toEqual([]);
  });
});

describe("alternatives gating", () => {
  it("is required (a list) when the gate is subscription_required or contact_sales", () => {
    for (const gate of ["subscription_required", "contact_sales"]) {
      expect(
        errorsOf({ pricing: { api_access_gate: gate, gate_source_url: "https://vendor.test/pricing" } }).join(" "),
        gate,
      ).toMatch(/alternatives: required \(a list\) when pricing\.api_access_gate is subscription_required or contact_sales/);
    }
  });

  it("is forbidden for every other gate, including unknown and null", () => {
    for (const gate of ["none", "prepaid_min", "unknown", null]) {
      expect(
        errorsOf({
          pricing: gate === null ? null : { api_access_gate: gate, gate_source_url: gate === "unknown" ? null : "https://vendor.test/pricing" },
          alternatives: [],
        }).join(" "),
        String(gate),
      ).toMatch(/alternatives: must be absent or null unless pricing\.api_access_gate is subscription_required or contact_sales/);
    }
    expect(errorsOf({ alternatives: null })).toEqual([]);
  });

  it("allows an empty list only alongside a non-empty alternatives_note", () => {
    const gated = { api_access_gate: "contact_sales", gate_source_url: "https://vendor.test/pricing" };
    expect(errorsOf({ pricing: gated, alternatives: [] }).join(" ")).toMatch(
      /alternatives: expected a non-empty alternatives_note when alternatives is \[\]/,
    );
    expect(
      errorsOf({ pricing: gated, alternatives: [], alternatives_note: "Sales-gated; no self-serve pricing page." }),
    ).toEqual([]);
  });
});

describe("alternatives[] rows", () => {
  const gated = { api_access_gate: "subscription_required", gate_source_url: "https://vendor.test/pricing", min_monthly_usd: 10 };
  const withAlt = (alt: Record<string, unknown>): string[] =>
    errorsOf({ pricing: gated, alternatives: [alt] }, { knownVendorIds: ["elsewhere"] });

  it("rejects an unknown field", () => {
    expect(withAlt({ vendor_id: "elsewhere", why: "x", access_gate: "none", price: 1 }).join(" ")).toMatch(
      /alternatives\[0\]\.price: unknown field/,
    );
  });

  it("requires a non-empty vendor_id", () => {
    expect(withAlt({ vendor_id: "", why: "x", access_gate: "none" }).join(" ")).toMatch(
      /alternatives\[0\]\.vendor_id: expected a non-empty string/,
    );
  });

  it("rejects a vendor_id that is not a known index entry", () => {
    expect(withAlt({ vendor_id: "nobody-heard-of-this", why: "x", access_gate: "none" }).join(" ")).toMatch(
      /alternatives\[0\]\.vendor_id: unknown vendor "nobody-heard-of-this" -- not a shard id or apis\.yaml name/,
    );
  });

  it("rejects a vendor_id equal to the row's own id", () => {
    const result = validateApis(
      { version: 1, entries: [entry({ name: "self-vendor", pricing: gated, alternatives: [{ vendor_id: "self-vendor", why: "x", access_gate: "none" }] })] },
    );
    expect(result.errors.join(" ")).toMatch(/alternatives\[0\]\.vendor_id: must not equal this row's own id/);
  });

  it("rejects a duplicate vendor_id within one list", () => {
    const result = validateApis(
      {
        version: 1,
        entries: [
          entry({
            pricing: gated,
            alternatives: [
              { vendor_id: "elsewhere", why: "first", access_gate: "none" },
              { vendor_id: "elsewhere", why: "second", access_gate: "prepaid_min" },
            ],
          }),
        ],
      },
      { knownVendorIds: ["elsewhere"] },
    );
    expect(result.errors.join(" ")).toMatch(/alternatives\[1\]\.vendor_id: duplicate vendor_id "elsewhere"/);
  });

  it("keeps why to one non-empty line and at most the cap", () => {
    expect(withAlt({ vendor_id: "elsewhere", why: "", access_gate: "none" }).join(" ")).toMatch(
      /alternatives\[0\]\.why: expected a non-empty string/,
    );
    expect(withAlt({ vendor_id: "elsewhere", why: "two\nlines", access_gate: "none" }).join(" ")).toMatch(
      /alternatives\[0\]\.why: expected a single line/,
    );
    expect(
      withAlt({ vendor_id: "elsewhere", why: "x".repeat(ALTERNATIVES_WHY_MAX + 1), access_gate: "none" }).join(" "),
    ).toMatch(new RegExp(`alternatives\\[0\\]\\.why: expected at most ${ALTERNATIVES_WHY_MAX} characters`));
    expect(withAlt({ vendor_id: "elsewhere", why: "x".repeat(ALTERNATIVES_WHY_MAX), access_gate: "none" })).toEqual(
      [],
    );
  });

  it("takes access_gate only from the closed list, excluding unknown", () => {
    expect(withAlt({ vendor_id: "elsewhere", why: "x", access_gate: "unknown" }).join(" ")).toMatch(
      new RegExp(`alternatives\\[0\\]\\.access_gate: expected one of ${ALTERNATIVE_ACCESS_GATES.join(" \\| ")}`),
    );
    for (const gate of ALTERNATIVE_ACCESS_GATES) {
      expect(withAlt({ vendor_id: "elsewhere", why: "x", access_gate: gate }), gate).toEqual([]);
    }
  });
});

describe("alternatives_note on its own", () => {
  it("keeps it to one line and at most the cap", () => {
    expect(errorsOf({ alternatives_note: "two\nlines" }).join(" ")).toMatch(/alternatives_note: expected a single line/);
    expect(errorsOf({ alternatives_note: "x".repeat(ALTERNATIVES_NOTE_MAX + 1) }).join(" ")).toMatch(
      new RegExp(`alternatives_note: expected at most ${ALTERNATIVES_NOTE_MAX} characters`),
    );
    expect(errorsOf({ alternatives_note: null })).toEqual([]);
  });

  it("is forbidden unless the gate is subscription_required or contact_sales", () => {
    expect(errorsOf({ alternatives_note: "Try treg instead." }).join(" ")).toMatch(
      /alternatives_note: must be absent or null unless pricing\.api_access_gate is subscription_required or contact_sales/,
    );
  });
});

describe("cost_badge", () => {
  it("derives green/red/gray from pricing.api_access_gate", () => {
    expect(deriveCostBadge(null)).toBe("gray");
    expect(deriveCostBadge({ api_access_gate: "none" })).toBe("green");
    expect(deriveCostBadge({ api_access_gate: "prepaid_min" })).toBe("green");
    expect(deriveCostBadge({ api_access_gate: "subscription_required" })).toBe("red");
    expect(deriveCostBadge({ api_access_gate: "contact_sales" })).toBe("red");
    expect(deriveCostBadge({ api_access_gate: "unknown" })).toBe("gray");
    expect(deriveCostBadge({ api_access_gate: null })).toBe("gray");
    expect(deriveCostBadge({})).toBe("gray");
  });

  it("is absent-safe: a row with no cost_badge at all is still valid", () => {
    expect(errorsOf({ pricing: { api_access_gate: "none", gate_source_url: "https://vendor.test/pricing" } })).toEqual(
      [],
    );
  });

  it("rejects a hand-filled value that disagrees with the derived one", () => {
    expect(
      errorsOf({
        pricing: { api_access_gate: "none", gate_source_url: "https://vendor.test/pricing" },
        cost_badge: "red",
      }).join(" "),
    ).toMatch(/cost_badge: derived field; expected green from pricing\.api_access_gate, got red \(do not hand-edit; run build\)/);
  });

  it("accepts a hand-filled value that agrees", () => {
    expect(
      errorsOf({
        pricing: { api_access_gate: "subscription_required", gate_source_url: "https://vendor.test/pricing", min_monthly_usd: 10 },
        alternatives: [],
        alternatives_note: "No alternative recorded yet.",
        cost_badge: "red",
      }),
    ).toEqual([]);
  });
});

describe("structured fields on a generated shard row", () => {
  let dir: string;

  const shard = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pricing-gate-shard-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(file, body);
    return file;
  };

  const base = `apis:
  - id: "gate-vendor"
    name: "Gate Vendor"
    capability: "A shard row that carries the ND-12 pricing-gate fields."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: null
    access_mode: "own-account"
    signup: "self-serve"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "api_key"
    seen_in: ["monid"]
    tos_notes: "Nothing reviewed."
    source_url: "https://monid.ai/tools/gate-vendor"
    checked_date: 2026-11-24
`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the fields onto the index entry, resolving vendor_id against a sibling row", () => {
    const file = shard(`${base}    pricing:
      model: "subscription"
      free_tier: null
      starting_price_usd: null
      unit: null
      pricing_url: "https://vendor.test/pricing"
      notes: null
      api_access_gate: "subscription_required"
      min_monthly_usd: 29
      min_prepay_usd: null
      gate_source_url: "https://vendor.test/pricing"
    alternatives:
      - vendor_id: "sibling-vendor"
        why: "Pay-as-you-go gateway covering the same capability."
        access_gate: "none"
    alternatives_note: null
    cost_badge: "red"
  - id: "sibling-vendor"
    name: "Sibling Vendor"
    capability: "Another row in the same shard."
    category: "llm-models"
    provider_url: null
    docs_url: null
    access_mode: "unknown"
    signup: "unknown"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "unknown"
    seen_in: ["monid"]
    tos_notes: "Nothing reviewed."
    source_url: "https://monid.ai/tools/sibling-vendor"
    checked_date: 2026-11-24
`);
    const { entries, errors } = readShardFile(file);
    expect(errors).toEqual([]);
    expect(entries[0]?.pricing?.api_access_gate).toBe("subscription_required");
    expect(entries[0]?.alternatives?.[0]?.vendor_id).toBe("sibling-vendor");
    expect(entries[0]?.cost_badge).toBe("red");
  });

  it("reports a malformed block instead of throwing, and drops just that row's structured fields", () => {
    const file = shard(`${base}    pricing:
      api_access_gate: "made-up-gate"
`);
    const { entries, errors } = readShardFile(file);
    expect(errors.join(" ")).toMatch(/pricing\.api_access_gate: expected one of/);
    expect(entries[0]?.name).toBe("gate-vendor");
    expect(entries[0]?.pricing).toBeUndefined();
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
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pricing-gate-noyaml-"));
    fs.writeFileSync(path.join(stub, "yaml.py"), 'raise ImportError("hidden by the test suite")\n');
    return { PYTHONPATH: stub };
  };

  const write = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pricing-gate-pyshard-"));
    fs.writeFileSync(path.join(dir, "llm-models.yaml"), body);
    return dir;
  };

  const row = (id: string, extra: string): string => `  - id: "${id}"
    name: "Py ${id}"
    capability: "A row for the python pricing-gate validator."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: null
    access_mode: "own-account"
    signup: "unknown"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "unknown"
    seen_in: ["monid"]
    tos_notes: "Nothing reviewed."
    source_url: "https://monid.ai/tools/${id}"
    checked_date: 2026-11-24
${extra}`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a fully populated, self-consistent gated row, with and without PyYAML", () => {
    const target = write(
      `apis:\n${row(
        "py-gate-vendor",
        `    pricing:
      model: "subscription"
      free_tier: null
      starting_price_usd: null
      unit: null
      pricing_url: "https://vendor.test/pricing"
      notes: null
      api_access_gate: "subscription_required"
      min_monthly_usd: 29
      min_prepay_usd: null
      gate_source_url: "https://vendor.test/pricing"
    alternatives:
      - vendor_id: "py-sibling-vendor"
        why: "Pay-as-you-go gateway covering the same capability."
        access_gate: "none"
    alternatives_note: null
    cost_badge: "red"
`,
      )}${row("py-sibling-vendor", "")}`,
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.out, JSON.stringify(env)).toMatch(/OK: all entries valid/);
      expect(result.code).toBe(0);
    }
  });

  it("resolves a vendor_id against the repo's own apis.yaml (PyYAML only -- the fallback reader cannot parse apis.yaml's full structure)", () => {
    const target = write(
      `apis:\n${row(
        "py-treg-vendor",
        `    pricing:
      api_access_gate: "contact_sales"
      gate_source_url: "https://vendor.test/pricing"
    alternatives:
      - vendor_id: "treg"
        why: "treg is a pay-as-you-go gateway for this capability."
        access_gate: "none"
    alternatives_note: null
`,
      )}`,
    );
    const result = run(target);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("rejects an unknown api_access_gate value and the consequent alternatives violation", () => {
    const target = write(
      `apis:\n${row(
        "py-bad-gate",
        `    pricing:
      api_access_gate: "paywalled"
    alternatives:
      - vendor_id: "treg"
        why: "x"
        access_gate: "none"
`,
      )}`,
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      /pricing\.api_access_gate: expected one of none \| prepaid_min \| subscription_required \| contact_sales \| unknown or null/,
    );
    expect(result.out).toMatch(
      /alternatives: must be absent or null unless pricing\.api_access_gate is subscription_required or contact_sales/,
    );
  });

  it("rejects the same mistakes the TypeScript validator rejects, with and without PyYAML", () => {
    const target = write(
      `apis:\n${row(
        "py-bad-vendor",
        `    pricing:
      api_access_gate: "contact_sales"
      min_monthly_usd: -5
      min_prepay_usd: 10
      gate_source_url: "not-a-url"
    alternatives:
      - vendor_id: ""
        why: "two\\nlines"
        access_gate: "unknown"
      - vendor_id: "py-bad-vendor"
        why: "self-reference"
        access_gate: "none"
    alternatives_note: ""
`,
      )}`,
    );
    // Not checked here: the fallback reader (no PyYAML) does not interpret
    // YAML's `\n` escape inside a double-quoted scalar the way PyYAML does
    // (see ../data/apis/README.md's note on the fallback reader's limited
    // subset), so a literal `"two\nlines"` only becomes a real embedded
    // newline under PyYAML -- the single-line check on `why` is exercised
    // separately below, PyYAML-only, for that reason.
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.out).toMatch(/pricing\.min_monthly_usd: expected a non-negative number or null/);
      expect(result.out).toMatch(/pricing\.min_monthly_usd: only allowed when pricing\.api_access_gate is subscription_required/);
      expect(result.out).toMatch(/pricing\.min_prepay_usd: only allowed when pricing\.api_access_gate is prepaid_min/);
      expect(result.out).toMatch(/pricing\.gate_source_url: expected an http\(s\) URL or null/);
      expect(result.out).toMatch(/alternatives\[0\]\.vendor_id: expected a non-empty string/);
      expect(result.out).toMatch(/alternatives\[0\]\.access_gate: expected one of/);
      expect(result.out).toMatch(/alternatives\[1\]\.vendor_id: must not equal this row's own id/);
      expect(result.out).toMatch(/alternatives_note: expected a non-empty string or null/);
    }
  });

  it("rejects a multi-line why (PyYAML only -- see the note above)", () => {
    const target = write(
      `apis:\n${row(
        "py-why-vendor",
        `    pricing:
      api_access_gate: "contact_sales"
      gate_source_url: "https://vendor.test/pricing"
    alternatives:
      - vendor_id: "treg"
        why: "two\\nlines"
        access_gate: "none"
`,
      )}`,
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/alternatives\[0\]\.why: expected a single line/);
  });

  it("requires alternatives_note when alternatives is [] under a gated row", () => {
    const target = write(
      `apis:\n${row(
        "py-empty-alts",
        `    pricing:
      api_access_gate: "contact_sales"
      gate_source_url: "https://vendor.test/pricing"
    alternatives: []
`,
      )}`,
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/alternatives: expected a non-empty alternatives_note when alternatives is \[\]/);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });

    const target2 = write(
      `apis:\n${row(
        "py-empty-alts",
        `    pricing:
      api_access_gate: "contact_sales"
      gate_source_url: "https://vendor.test/pricing"
    alternatives: []
    alternatives_note: "Sales-gated; no self-serve pricing page."
`,
      )}`,
    );
    const result2 = run(target2);
    expect(result2.code).toBe(0);
  });

  it("rejects a hand-filled cost_badge that disagrees with the derived value", () => {
    const target = write(
      `apis:\n${row(
        "py-badge-mismatch",
        `    pricing:
      api_access_gate: "none"
      gate_source_url: "https://vendor.test/pricing"
    cost_badge: "red"
`,
      )}`,
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      /cost_badge: derived field; expected green from pricing\.api_access_gate, got red \(do not hand-edit; run build\)/,
    );
  });

  it("passes on the shipped shards with PyYAML unavailable (apis.yaml vendor_id names still resolve)", () => {
    const result = run(SHARD_DIR, noYaml());
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });
});

describe("the two validators agree (ND-12 drift check)", () => {
  const source = fs.readFileSync(VALIDATE_PY, "utf8");

  const pyList = (name: string): string[] => {
    const match = new RegExp(`${name} = \\[([^\\]]*)\\]`, "s").exec(source);
    expect(match, `${name} missing from validate.py`).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((hit) => hit[1] as string);
  };

  const pyNumber = (name: string): number =>
    Number(new RegExp(`${name} = (\\d+)`).exec(source)?.[1] ?? NaN);

  it("ships the same access gates", () => {
    expect(pyList("API_ACCESS_GATES")).toEqual([...API_ACCESS_GATES]);
  });

  it("ships the same alternative access gates", () => {
    expect(pyList("ALTERNATIVE_ACCESS_GATES")).toEqual([...ALTERNATIVE_ACCESS_GATES]);
  });

  it("ships the same cost badges", () => {
    expect(pyList("COST_BADGES")).toEqual([...COST_BADGES]);
  });

  it("ships the same caps", () => {
    expect(pyNumber("ALTERNATIVES_WHY_MAX")).toBe(ALTERNATIVES_WHY_MAX);
    expect(pyNumber("ALTERNATIVES_NOTE_MAX")).toBe(ALTERNATIVES_NOTE_MAX);
  });

  it("derive_cost_badge (python) and deriveCostBadge (TS) agree on every gate", () => {
    for (const gate of [...API_ACCESS_GATES, null, undefined]) {
      const pricing = gate === undefined ? {} : { api_access_gate: gate };
      const expected = deriveCostBadge(pricing);
      const result = execFileSync(
        "python3",
        [
          "-c",
          "import sys, json; sys.path.insert(0, sys.argv[1]); import validate; " +
            "print(validate.derive_cost_badge(json.loads(sys.argv[2])))",
          path.dirname(VALIDATE_PY),
          JSON.stringify(pricing),
        ],
        { encoding: "utf8" },
      ).trim();
      expect(result, String(gate)).toBe(expected);
    }
  });
});

describe.skipIf(!python)("build.py: ND-12 preservation and emission order", () => {
  function runPy(code: string): { code: number; out: string } {
    const scriptsDir = path.dirname(VALIDATE_PY);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pricing-gate-build-"));
    try {
      const script = `import sys\nsys.path.insert(0, ${JSON.stringify(scriptsDir)})\n${code}`;
      const file = path.join(tmp, "run.py");
      fs.writeFileSync(file, script);
      try {
        const out = execFileSync("python3", [file], { encoding: "utf8" });
        return { code: 0, out };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("emits alternatives then alternatives_note then cost_badge, after the ND-8 fields", () => {
    const result = runPy(`
import build

row = {
    "id": "p", "name": "P", "capability": "c", "category": "llm-models",
    "provider_url": None, "docs_url": None, "access_mode": "own-account",
    "signup": "self-serve", "signup_automatable": "unknown", "min_topup": None,
    "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "x", "source_url": "https://monid.ai/tools/p",
    "checked_date": "2026-11-24",
    "endpoints_note": "No self-serve API; sales only.",
    "alternatives": [{"vendor_id": "treg", "why": "Pay-as-you-go gateway.", "access_gate": "none"}],
    "alternatives_note": None,
    "cost_badge": "red",
}
text = build.emit_row(row)
i_notes = text.index("endpoints_note:")
i_alts = text.index("alternatives:")
i_alt_note = text.index("alternatives_note:")
i_badge = text.index("cost_badge:")
assert i_notes < i_alts < i_alt_note < i_badge, text
print("order-ok")
`);
    expect(result.out, result.out).toMatch(/order-ok/);
    expect(result.code).toBe(0);
  });

  it("merge_preserved keeps alternatives/alternatives_note from the old shard, like any other hand-filled field", () => {
    const result = runPy(`
import build

new_row = {"id": "p"}
old_row = {
    "alternatives": [{"vendor_id": "treg", "why": "x", "access_gate": "none"}],
    "alternatives_note": "note",
}
merged = build.merge_preserved(new_row, old_row)
assert merged["alternatives"] == old_row["alternatives"], merged
assert merged["alternatives_note"] == "note", merged
print("preserved-ok")
`);
    expect(result.out, result.out).toMatch(/preserved-ok/);
    expect(result.code).toBe(0);
  });

  it("merge_preserved never pulls cost_badge from the old shard -- it is computed, not hand-filled", () => {
    const result = runPy(`
import build

new_row = {"id": "p", "pricing": {"api_access_gate": "none"}}
old_row = {"cost_badge": "red"}
merged = build.merge_preserved(new_row, old_row)
assert "cost_badge" not in merged, merged
print("not-preserved-ok")
`);
    expect(result.out, result.out).toMatch(/not-preserved-ok/);
    expect(result.code).toBe(0);
  });

  it("the main() pattern -- derive_cost_badge after merge_preserved -- always wins over a stale old value", () => {
    const result = runPy(`
import build, validate

new_row = {"id": "p", "pricing": {"api_access_gate": "none"}}
old_row = {"cost_badge": "red", "pricing": {"api_access_gate": "none"}}
merged = build.merge_preserved(new_row, old_row)
merged["cost_badge"] = validate.derive_cost_badge(merged.get("pricing"))
assert merged["cost_badge"] == "green", merged
print("recomputed-ok")
`);
    expect(result.out, result.out).toMatch(/recomputed-ok/);
    expect(result.code).toBe(0);
  });

  it("emits pricing.free_usage_source_url then pricing.cost_label, after the gate keys, only when present", () => {
    const result = runPy(`
import build

row = {
    "id": "p", "name": "P", "capability": "c", "category": "llm-models",
    "provider_url": None, "docs_url": None, "access_mode": "own-account",
    "signup": "self-serve", "signup_automatable": "unknown", "min_topup": None,
    "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "x", "source_url": "https://monid.ai/tools/p",
    "checked_date": "2026-11-24",
    "pricing": {
        "model": None, "free_tier": None, "starting_price_usd": None, "unit": None,
        "pricing_url": None, "notes": None,
        "api_access_gate": "none", "min_monthly_usd": None, "min_prepay_usd": None,
        "gate_source_url": "https://vendor.test/pricing",
        "free_usage_source_url": "https://vendor.test/free",
        "cost_label": "FREE",
    },
}
text = build.emit_row(row)
i_gate = text.index("api_access_gate:")
i_free_url = text.index("free_usage_source_url:")
i_label = text.index("cost_label:")
assert i_gate < i_free_url < i_label, text
print("order-ok")
`);
    expect(result.out, result.out).toMatch(/order-ok/);
    expect(result.code).toBe(0);
  });

  it("omits pricing.free_usage_source_url and pricing.cost_label entirely when absent -- never emits them as null", () => {
    const result = runPy(`
import build

row = {
    "id": "p", "name": "P", "capability": "c", "category": "llm-models",
    "provider_url": None, "docs_url": None, "access_mode": "own-account",
    "signup": "self-serve", "signup_automatable": "unknown", "min_topup": None,
    "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "x", "source_url": "https://monid.ai/tools/p",
    "checked_date": "2026-11-24",
    "pricing": {
        "model": None, "free_tier": None, "starting_price_usd": None, "unit": None,
        "pricing_url": None, "notes": None,
        "api_access_gate": "contact_sales", "min_monthly_usd": None, "min_prepay_usd": None,
        "gate_source_url": "https://vendor.test/pricing",
    },
}
text = build.emit_row(row)
assert "free_usage_source_url" not in text, text
assert "cost_label" not in text, text
print("omitted-ok")
`);
    expect(result.out, result.out).toMatch(/omitted-ok/);
    expect(result.code).toBe(0);
  });

  it("merge_preserved keeps pricing (including free_usage_source_url) wholesale from the old shard", () => {
    const result = runPy(`
import build

new_row = {"id": "p"}
old_row = {
    "pricing": {
        "api_access_gate": "none",
        "free_usage_source_url": "https://vendor.test/free",
        "cost_label": "FREE",
    },
}
merged = build.merge_preserved(new_row, old_row)
assert merged["pricing"] == old_row["pricing"], merged
print("preserved-ok")
`);
    expect(result.out, result.out).toMatch(/preserved-ok/);
    expect(result.code).toBe(0);
  });

  it("main()'s pattern -- derive_cost_label after merge_preserved, on a COPY of pricing -- always wins over a stale old value, without mutating the old row", () => {
    const result = runPy(`
import build, validate

new_row = {"id": "p"}
old_row = {
    "pricing": {
        "api_access_gate": "none",
        "free_usage_source_url": "https://vendor.test/free",
        "cost_label": "PAYG",
    },
}
merged = build.merge_preserved(new_row, old_row)
pricing = merged.get("pricing")
assert isinstance(pricing, dict)
pricing = dict(pricing)
merged["pricing"] = pricing
cost_label = validate.derive_cost_label(pricing)
if cost_label is not None:
    pricing["cost_label"] = cost_label
else:
    pricing.pop("cost_label", None)
assert merged["pricing"]["cost_label"] == "FREE", merged
assert old_row["pricing"]["cost_label"] == "PAYG", old_row  # the old dict is untouched
print("recomputed-ok")
`);
    expect(result.out, result.out).toMatch(/recomputed-ok/);
    expect(result.code).toBe(0);
  });

  it("a rebuild never invents an explicit null for free_usage_source_url or cost_label", () => {
    const result = runPy(`
import build, validate

new_row = {
    "id": "p", "name": "P", "capability": "c", "category": "llm-models",
    "provider_url": None, "docs_url": None, "access_mode": "own-account",
    "signup": "self-serve", "signup_automatable": "unknown", "min_topup": None,
    "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "x", "source_url": "https://monid.ai/tools/p",
    "checked_date": "2026-11-24",
}
old_row = {"pricing": {"api_access_gate": "contact_sales"}}
merged = build.merge_preserved(new_row, old_row)
pricing = merged.get("pricing")
pricing = dict(pricing)
merged["pricing"] = pricing
cost_label = validate.derive_cost_label(pricing)
if cost_label is not None:
    pricing["cost_label"] = cost_label
else:
    pricing.pop("cost_label", None)
assert "cost_label" not in pricing, pricing
assert "free_usage_source_url" not in pricing, pricing
text = build.emit_row(merged)
assert "cost_label" not in text, text
assert "free_usage_source_url" not in text, text
print("no-explicit-nulls-ok")
`);
    expect(result.out, result.out).toMatch(/no-explicit-nulls-ok/);
    expect(result.code).toBe(0);
  });
});

describe.skipIf(!python)("data/apis/scripts/derive_cost_badge.py", () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fixtureShard = `# generated for a test
apis:
  - id: "no-pricing"
    name: "No Pricing"
    capability: "c"
    category: "llm-models"
    provider_url: null
    docs_url: null
    access_mode: "own-account"
    signup: "self-serve"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "api_key"
    seen_in: ["monid"]
    tos_notes: "x"
    source_url: "https://monid.ai/tools/no-pricing"
    checked_date: 2026-11-24
    cost_badge: "gray"
  - id: "has-pricing"
    name: "Has Pricing"
    capability: "c"
    category: "llm-models"
    provider_url: null
    docs_url: null
    access_mode: "own-account"
    signup: "self-serve"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "api_key"
    seen_in: ["monid"]
    tos_notes: "x"
    source_url: "https://monid.ai/tools/has-pricing"
    checked_date: 2026-11-24
    pricing:
      model: "subscription"
      free_tier: null
      starting_price_usd: null
      unit: null
      pricing_url: "https://vendor.test/pricing"
      notes: null
      api_access_gate: "subscription_required"
      min_monthly_usd: 10
      min_prepay_usd: null
      gate_source_url: "https://vendor.test/pricing"
    alternatives:
      - vendor_id: "treg"
        why: "Pay-as-you-go gateway."
        access_gate: "none"
    alternatives_note: null
`;

  function runDeriveBadge(args: string[]): { code: number; out: string } {
    try {
      const out = execFileSync("python3", [DERIVE_BADGE_PY, ...args], { encoding: "utf8" });
      return { code: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  }

  it("--check reports a pending change and exits 1; running writes it and exits 0; a second run is a no-op", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-derive-badge-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(file, fixtureShard);

    const check1 = runDeriveBadge(["--check", dir]);
    expect(check1.code).toBe(1);
    expect(check1.out).toMatch(/would update llm-models\.yaml: has-pricing, no-pricing/);

    const applied = runDeriveBadge([dir]);
    expect(applied.code).toBe(0);
    const updated = fs.readFileSync(file, "utf8");
    // no-pricing carries no pricing.api_access_gate, so its stale cost_badge
    // is removed outright -- no cost_badge line survives on that row.
    const noPricingBlock = updated.slice(
      updated.indexOf('id: "no-pricing"'),
      updated.indexOf('id: "has-pricing"'),
    );
    expect(noPricingBlock).not.toMatch(/cost_badge/);
    // has-pricing is gated, so it gets cost_badge placed right after its
    // last structured block (alternatives_note), matching emit_row's order.
    expect(updated).toMatch(/alternatives_note: null\n\s*cost_badge: "red"/);

    // Idempotent: a second run makes no changes and --check now exits 0.
    const before = fs.readFileSync(file, "utf8");
    runDeriveBadge([dir]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const checkAfter = runDeriveBadge(["--check", dir]);
    expect(checkAfter.code).toBe(0);
    expect(checkAfter.out).toMatch(/OK: cost_badge in sync/);

    // The rewritten shard still validates.
    const validated = execFileSync("python3", [VALIDATE_PY, dir], { encoding: "utf8" });
    expect(validated).toMatch(/OK: all entries valid/);
  });

  it("inserts cost_badge right after the last structured block present (alternatives_note), not right after pricing", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-derive-badge-pos-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(file, fixtureShard);
    execFileSync("python3", [DERIVE_BADGE_PY, dir], { encoding: "utf8" });
    const text = fs.readFileSync(file, "utf8");
    const hasPricingRow = text.indexOf('  - id: "has-pricing"');
    const hasPricingBlock = text.slice(hasPricingRow);
    const altNoteIdx = hasPricingBlock.indexOf("alternatives_note:");
    const badgeIdx = hasPricingBlock.indexOf("cost_badge:");
    // cost_badge sits right after alternatives_note (the last structured
    // block on this row), not right after pricing.
    expect(altNoteIdx).toBeGreaterThan(0);
    expect(badgeIdx).toBeGreaterThan(altNoteIdx);
  });

  function runPyScript(code: string): string {
    const scriptsDir = path.dirname(VALIDATE_PY);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-derive-badge-emit-"));
    try {
      const script = `import sys\nsys.path.insert(0, ${JSON.stringify(scriptsDir)})\n${code}`;
      const file = path.join(tmp, "run.py");
      fs.writeFileSync(file, script);
      return execFileSync("python3", [file], { encoding: "utf8" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("stays in sync with build.py's own emit_row output for a gated row with alternatives and usage_api", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-derive-badge-emit-"));
    const file = path.join(dir, "llm-models.yaml");

    const rowText = runPyScript(`
import build

row = {
    "id": "emit-gate-vendor", "name": "Emit Gate Vendor", "capability": "c",
    "category": "llm-models", "provider_url": None, "docs_url": None,
    "access_mode": "own-account", "signup": "self-serve", "signup_automatable": "unknown",
    "min_topup": None, "billing_unit": None, "free_tier": None, "auth_type": "api_key",
    "seen_in": ["monid"], "tos_notes": "x",
    "source_url": "https://monid.ai/tools/emit-gate-vendor", "checked_date": "2026-11-24",
    "pricing": {
        "model": "subscription", "free_tier": None, "starting_price_usd": None, "unit": None,
        "pricing_url": "https://vendor.test/pricing", "notes": None,
        "api_access_gate": "subscription_required", "min_monthly_usd": 10,
        "min_prepay_usd": None, "gate_source_url": "https://vendor.test/pricing",
        "cost_label": "SUBS",
    },
    "alternatives": [{"vendor_id": "treg", "why": "Pay-as-you-go gateway.", "access_gate": "none"}],
    "alternatives_note": None,
    "cost_badge": "red",
    "usage_api": {"available": False, "method": None, "path": None, "docs_url": None,
                  "limits": None, "notes": None, "checked_date": None},
}
print(build.emit_row(row))
`);

    fs.writeFileSync(file, `# generated for a test\napis:\n${rowText}\n`);

    const check = runDeriveBadge(["--check", dir]);
    expect(check.code).toBe(0);
    expect(check.out).toMatch(/OK: cost_badge in sync/);
  });
});
