import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COST_LABELS, deriveCostLabel, readShardFile, validateApis } from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

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

function errorsOf(overrides: Record<string, unknown>): string[] {
  return validateApis({ version: 1, entries: [entry(overrides)] }).errors;
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

describe("deriveCostLabel", () => {
  it("derives SUBS when the gate is subscription_required", () => {
    expect(deriveCostLabel({ api_access_gate: "subscription_required" })).toBe("SUBS");
    expect(deriveCostLabel({ api_access_gate: "subscription_required", model: "pay_as_you_go" })).toBe("SUBS");
  });

  it("derives SUBS when a none/prepaid_min gate is paired with model: subscription", () => {
    expect(deriveCostLabel({ api_access_gate: "none", model: "subscription" })).toBe("SUBS");
    expect(deriveCostLabel({ api_access_gate: "prepaid_min", model: "subscription" })).toBe("SUBS");
  });

  it("derives FREE only for a none gate with a sourced http(s) free_usage_source_url", () => {
    expect(deriveCostLabel({ api_access_gate: "none", free_usage_source_url: "https://vendor.test/pricing" })).toBe(
      "FREE",
    );
    expect(deriveCostLabel({ api_access_gate: "none", free_usage_source_url: "http://vendor.test/pricing" })).toBe(
      "FREE",
    );
  });

  it("derives PAYG for a none gate with no (or a malformed) free_usage_source_url", () => {
    expect(deriveCostLabel({ api_access_gate: "none" })).toBe("PAYG");
    expect(deriveCostLabel({ api_access_gate: "none", free_usage_source_url: null })).toBe("PAYG");
    expect(deriveCostLabel({ api_access_gate: "none", free_usage_source_url: "ftp://vendor.test" })).toBe("PAYG");
    expect(deriveCostLabel({ api_access_gate: "none", free_usage_source_url: "vendor.test/pricing" })).toBe("PAYG");
  });

  it("derives PAYG for prepaid_min, even with a free_usage_source_url present -- prepaid_min is never FREE", () => {
    expect(deriveCostLabel({ api_access_gate: "prepaid_min" })).toBe("PAYG");
    expect(
      deriveCostLabel({ api_access_gate: "prepaid_min", free_usage_source_url: "https://vendor.test/pricing" }),
    ).toBe("PAYG");
  });

  it("derives null for unknown, contact_sales, missing, or no pricing block at all", () => {
    expect(deriveCostLabel({ api_access_gate: "unknown" })).toBeNull();
    expect(deriveCostLabel({ api_access_gate: "unknown", model: "subscription" })).toBeNull();
    expect(deriveCostLabel({ api_access_gate: "contact_sales" })).toBeNull();
    expect(deriveCostLabel({})).toBeNull();
    expect(deriveCostLabel(null)).toBeNull();
    expect(deriveCostLabel(undefined)).toBeNull();
    expect(deriveCostLabel("not-a-pricing-block")).toBeNull();
    expect(deriveCostLabel([])).toBeNull();
  });
});

describe("pricing.cost_label validation", () => {
  it("accepts a hand-filled value that agrees with the derived one", () => {
    expect(
      errorsOf({
        pricing: {
          api_access_gate: "none",
          gate_source_url: "https://vendor.test/pricing",
          free_usage_source_url: "https://vendor.test/pricing",
          cost_label: "FREE",
        },
      }),
    ).toEqual([]);
  });

  it("is absent-safe: a row with no cost_label key is valid even when a label is derivable", () => {
    expect(
      errorsOf({
        pricing: {
          api_access_gate: "none",
          gate_source_url: "https://vendor.test/pricing",
          free_usage_source_url: "https://vendor.test/pricing",
        },
      }),
    ).toEqual([]);
    expect(
      errorsOf({
        pricing: { api_access_gate: "subscription_required", gate_source_url: "https://vendor.test/pricing" },
        alternatives: [],
        alternatives_note: "No alternative recorded yet.",
      }),
    ).toEqual([]);
  });

  it("rejects a hand-filled value that disagrees with the derived one", () => {
    expect(
      errorsOf({
        pricing: {
          api_access_gate: "none",
          gate_source_url: "https://vendor.test/pricing",
          free_usage_source_url: "https://vendor.test/pricing",
          cost_label: "PAYG",
        },
      }).join(" "),
    ).toMatch(/pricing\.cost_label: derived field; expected FREE from pricing, got PAYG \(do not hand-edit; run build\)/);
  });

  it("rejects an explicit cost_label (any value, including null) when the derived value is null", () => {
    expect(
      errorsOf({ pricing: { api_access_gate: "contact_sales", cost_label: "PAYG" } }).join(" "),
    ).toMatch(/pricing\.cost_label: derived field; expected null from pricing, got PAYG/);
    expect(
      errorsOf({ pricing: { api_access_gate: "contact_sales", cost_label: null } }).join(" "),
    ).toMatch(/pricing\.cost_label: derived field; expected null from pricing, got null/);
  });
});

describe("pricing.free_usage_source_url validation", () => {
  const freeGated = {
    api_access_gate: "none",
    gate_source_url: "https://vendor.test/pricing",
  };

  it("must be an http(s) URL when present", () => {
    expect(
      errorsOf({ pricing: { ...freeGated, free_usage_source_url: "vendor.test/free" } }).join(" "),
    ).toMatch(/pricing\.free_usage_source_url: expected an http\(s\) URL or null/);
  });

  it("is required (and must be http(s)) when the derived cost_label is FREE", () => {
    // Can't actually reach a derived FREE without one, so this mainly
    // documents the contract -- the one case that CAN trip it is a
    // malformed URL that still happens to start with "http".
    expect(
      errorsOf({ pricing: { ...freeGated, free_usage_source_url: "httpnotaurl" } }).join(" "),
    ).toMatch(/pricing\.free_usage_source_url: required when the derived cost_label is FREE/);
  });

  it("is only allowed when the derived cost_label is FREE -- rejected on a PAYG/SUBS/null row", () => {
    const validUrl = "https://vendor.test/free";
    expect(
      errorsOf({ pricing: { ...freeGated, api_access_gate: "prepaid_min", free_usage_source_url: validUrl } }).join(
        " ",
      ),
    ).toMatch(/pricing\.free_usage_source_url: only allowed when the derived cost_label is FREE/);
    expect(
      errorsOf({
        pricing: { api_access_gate: "subscription_required", gate_source_url: "https://vendor.test/pricing", free_usage_source_url: validUrl },
        alternatives: [],
        alternatives_note: "No alternative recorded yet.",
      }).join(" "),
    ).toMatch(/pricing\.free_usage_source_url: only allowed when the derived cost_label is FREE/);
    expect(
      errorsOf({ pricing: { api_access_gate: "contact_sales", free_usage_source_url: validUrl } }).join(" "),
    ).toMatch(/pricing\.free_usage_source_url: only allowed when the derived cost_label is FREE/);
  });

  it("rejects even an explicit null on a non-FREE row -- must be absent, not merely null", () => {
    expect(
      errorsOf({ pricing: { ...freeGated, free_usage_source_url: null } }).join(" "),
    ).toMatch(/pricing\.free_usage_source_url: only allowed when the derived cost_label is FREE/);
  });

  it("accepts absence on a non-FREE row", () => {
    expect(errorsOf({ pricing: freeGated })).toEqual([]);
  });
});

describe("the pricing allowlist covers the new keys", () => {
  it("rejects an unrelated unknown field, confirming cost_label/free_usage_source_url are not what trips it", () => {
    expect(errorsOf({ pricing: { made_up_field: 1 } }).join(" ")).toMatch(/pricing\.made_up_field: unknown field/);
  });

  it("does not reject cost_label or free_usage_source_url as unknown fields", () => {
    expect(
      errorsOf({
        pricing: {
          api_access_gate: "none",
          gate_source_url: "https://vendor.test/pricing",
          free_usage_source_url: "https://vendor.test/pricing",
          cost_label: "FREE",
        },
      }).join(" "),
    ).not.toMatch(/unknown field/);
  });
});

describe("shipped shards: ND-18b cost_label", () => {
  const shards = fs.readdirSync(SHARD_DIR).filter((name) => name.endsWith(".yaml"));

  function readAll(): Map<string, { label: string | null; freeUrl: string | null }> {
    const byId = new Map<string, { label: string | null; freeUrl: string | null }>();
    for (const file of shards) {
      const { entries, errors } = readShardFile(path.join(SHARD_DIR, file));
      expect(errors, file).toEqual([]);
      for (const e of entries) {
        // Shard rows read onto `IndexEntry.name` (the generated-index loader
        // uses the shard's own `id` as the display name) -- see shardEntry.
        byId.set(e.name, {
          label: e.pricing?.cost_label ?? null,
          freeUrl: e.pricing?.free_usage_source_url ?? null,
        });
      }
    }
    return byId;
  }

  const FREE_IDS = [
    "anyapi",
    "apify",
    "brightdata",
    "firecrawl",
    "fishaudio",
    "github",
    "google-maps",
    "hunter",
    "magichour",
    "marketstack",
    "pdl",
    "predictleads",
    "prospeo",
    "recall",
    "scrapecreators",
    "web3-career",
    "octen",
    "tikhub",
    "agentmail",
    "blockrun",
    "browserbase",
    "censusdata-xyz",
    "exa",
    "fundable",
    "keenable",
    "rentcast",
    "saperly",
    "sonilo",
    "strale",
    "sumble",
    "surf",
    "theirstack",
    "tinyfish",
    "us-census-bureau",
    "valyu",
    "serper",
  ];

  const SUBS_FROM_MODEL_IDS = ["cloro", "context-dev", "defillama", "elevenlabs"];
  const SUBS_FROM_GATE_IDS = ["agentline", "ahrefs", "foreplay", "leadmagic", "ploid"];
  const PAYG_NONE_NO_FREE_IDS = ["akta", "minimax", "smolmachine", "x"];
  const PAYG_PREPAID_MIN_IDS = ["dataforseo", "datalegion", "financialdatasets", "litescrape", "metixai"];

  it("labels all 36 FREE rows, each with its mapped free_usage_source_url", () => {
    const byId = readAll();
    for (const id of FREE_IDS) {
      const row = byId.get(id);
      expect(row, id).toBeDefined();
      expect(row?.label, id).toBe("FREE");
      expect(typeof row?.freeUrl, id).toBe("string");
      expect(row?.freeUrl, id).toMatch(/^https?:\/\//);
    }
  });

  it("labels the 4 model=subscription rows SUBS, with no free_usage_source_url", () => {
    const byId = readAll();
    for (const id of SUBS_FROM_MODEL_IDS) {
      const row = byId.get(id);
      expect(row?.label, id).toBe("SUBS");
      expect(row?.freeUrl, id).toBeNull();
    }
  });

  it("labels the 5 subscription_required rows SUBS, with no free_usage_source_url", () => {
    const byId = readAll();
    for (const id of SUBS_FROM_GATE_IDS) {
      const row = byId.get(id);
      expect(row?.label, id).toBe("SUBS");
      expect(row?.freeUrl, id).toBeNull();
    }
  });

  it("keeps the 4 gate=none rows with no sourced free allowance at PAYG", () => {
    const byId = readAll();
    for (const id of PAYG_NONE_NO_FREE_IDS) {
      const row = byId.get(id);
      expect(row?.label, id).toBe("PAYG");
      expect(row?.freeUrl, id).toBeNull();
    }
  });

  it("keeps every prepaid_min row at PAYG, never FREE, regardless of trial/signup credits", () => {
    const byId = readAll();
    for (const id of PAYG_PREPAID_MIN_IDS) {
      const row = byId.get(id);
      expect(row?.label, id).toBe("PAYG");
      expect(row?.freeUrl, id).toBeNull();
    }
  });

  it("gives the contact_sales row (clay) no cost_label", () => {
    const byId = readAll();
    const row = byId.get("clay");
    expect(row?.label).toBeNull();
    expect(row?.freeUrl).toBeNull();
  });

  it("totals 162 rows: 36 FREE, 9 PAYG, 9 SUBS, 108 with no cost_label", () => {
    const byId = readAll();
    expect(byId.size).toBe(162);
    const counts = { FREE: 0, PAYG: 0, SUBS: 0, absent: 0 };
    for (const { label } of byId.values()) {
      if (label === "FREE") counts.FREE++;
      else if (label === "PAYG") counts.PAYG++;
      else if (label === "SUBS") counts.SUBS++;
      else counts.absent++;
    }
    expect(counts).toEqual({ FREE: 36, PAYG: 9, SUBS: 9, absent: 108 });
  });

  it("every FREE row's cost_label and free_usage_source_url agree with deriveCostLabel", () => {
    for (const file of shards) {
      const { entries, errors } = readShardFile(path.join(SHARD_DIR, file));
      expect(errors, file).toEqual([]);
      for (const e of entries) {
        if (e.pricing === undefined || e.pricing === null) continue;
        const expected = deriveCostLabel(e.pricing);
        expect(e.pricing.cost_label ?? null, `${file}:${e.name}`).toBe(expected);
      }
    }
  });
});

describe.skipIf(!python)("the two validators agree (ND-18b drift check)", () => {
  const source = fs.readFileSync(VALIDATE_PY, "utf8");

  const pyList = (name: string): string[] => {
    const match = new RegExp(`${name} = \\[([^\\]]*)\\]`, "s").exec(source);
    expect(match, `${name} missing from validate.py`).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((hit) => hit[1] as string);
  };

  it("ships the same cost labels", () => {
    expect(pyList("COST_LABELS")).toEqual([...COST_LABELS]);
  });

  it("derive_cost_label (python) and deriveCostLabel (TS) agree across every gate/model/url combination", () => {
    const gates = ["none", "prepaid_min", "subscription_required", "contact_sales", "unknown", null, undefined];
    const models = ["subscription", "pay_as_you_go", "free", null, undefined];
    const urls = ["https://vendor.test/free", "http://vendor.test/free", "ftp://vendor.test", null, undefined];

    for (const gate of gates) {
      for (const model of models) {
        for (const url of urls) {
          const pricing: Record<string, unknown> = {};
          if (gate !== undefined) pricing["api_access_gate"] = gate;
          if (model !== undefined) pricing["model"] = model;
          if (url !== undefined) pricing["free_usage_source_url"] = url;

          const expected = deriveCostLabel(pricing);
          const result = execFileSync(
            "python3",
            [
              "-c",
              "import sys, json; sys.path.insert(0, sys.argv[1]); import validate; " +
                "print(json.dumps(validate.derive_cost_label(json.loads(sys.argv[2]))))",
              path.dirname(VALIDATE_PY),
              JSON.stringify(pricing),
            ],
            { encoding: "utf8" },
          ).trim();
          expect(result, JSON.stringify(pricing)).toBe(JSON.stringify(expected));
        }
      }
    }
  });
});

describe.skipIf(!python)("data/apis/scripts/validate.py: pricing.cost_label", () => {
  let dir: string;

  const run = (target: string): { code: number; out: string } => {
    try {
      const out = execFileSync("python3", [VALIDATE_PY, target], { encoding: "utf8" });
      return { code: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  const row = (id: string, extra: string): string => `  - id: "${id}"
    name: "Py ${id}"
    capability: "A row for the ND-18b cost_label validator."
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

  const write = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-cost-label-pyshard-"));
    fs.writeFileSync(path.join(dir, "llm-models.yaml"), body);
    return dir;
  };

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a self-consistent FREE row", () => {
    const target = write(
      `apis:\n${row(
        "py-free-vendor",
        `    pricing:
      api_access_gate: "none"
      gate_source_url: "https://vendor.test/pricing"
      free_usage_source_url: "https://vendor.test/free"
      cost_label: "FREE"
`,
      )}`,
    );
    const result = run(target);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("rejects a cost_label that disagrees with the derived value", () => {
    const target = write(
      `apis:\n${row(
        "py-mismatch-vendor",
        `    pricing:
      api_access_gate: "none"
      gate_source_url: "https://vendor.test/pricing"
      cost_label: "FREE"
`,
      )}`,
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      /pricing\.cost_label: derived field; expected PAYG from pricing, got FREE \(do not hand-edit; run build\)/,
    );
  });

  it("rejects free_usage_source_url on a PAYG row (prepaid_min is never FREE, even with a sourced URL)", () => {
    const target = write(
      `apis:\n${row(
        "py-payg-with-url",
        `    pricing:
      api_access_gate: "prepaid_min"
      gate_source_url: "https://vendor.test/pricing"
      free_usage_source_url: "https://vendor.test/free"
      cost_label: "PAYG"
`,
      )}`,
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      /pricing\.free_usage_source_url: only allowed when the derived cost_label is FREE/,
    );
  });
});
