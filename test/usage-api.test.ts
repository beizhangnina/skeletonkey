import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  USAGE_API_METHODS,
  readShardFile,
  validateApis,
  type UsageApiFacts,
} from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

const VALIDATE_PY = path.join(REPO_ROOT, "data", "apis", "scripts", "validate.py");

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

/** A complete, valid usage_api block: every rule below is a single deviation from it. */
function usageApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    method: "GET",
    path: "/v1/usage",
    docs_url: "https://vendor.test/docs/usage",
    limits: "requires a paid plan",
    notes: "Separate from the product API.",
    checked_date: "2026-11-24",
    ...overrides,
  };
}

/** Errors from validating one row with one usage_api block. */
function check(block: Record<string, unknown> | null | undefined): string[] {
  return validateApis({ version: 1, entries: [entry({ usage_api: block })] }).errors;
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

describe("the usage_api block", () => {
  it("is optional: a row without one is as valid as it ever was", () => {
    expect(validateApis({ version: 1, entries: [entry()] }).errors).toEqual([]);
    expect(check(null)).toEqual([]);
    expect(check(undefined)).toEqual([]);
    const result = validateApis({ version: 1, entries: [entry()] });
    expect(result.document?.entries[0]?.usage_api).toBeUndefined();
  });

  it("accepts a fully populated block (available: true) and keeps every field", () => {
    const result = validateApis({ version: 1, entries: [entry({ usage_api: usageApi() })] });
    expect(result.errors).toEqual([]);
    const stored = result.document?.entries[0]?.usage_api as UsageApiFacts;
    expect(stored.available).toBe(true);
    expect(stored.method).toBe("GET");
    expect(stored.path).toBe("/v1/usage");
    expect(stored.docs_url).toBe("https://vendor.test/docs/usage");
    expect(stored.limits).toBe("requires a paid plan");
    expect(stored.notes).toBe("Separate from the product API.");
    expect(stored.checked_date).toBe("2026-11-24");
  });

  it("accepts available: false, with docs_url required and method/path null", () => {
    expect(
      check(
        usageApi({
          available: false,
          method: null,
          path: null,
          docs_url: "https://vendor.test/docs/no-usage-api",
        }),
      ),
    ).toEqual([]);
  });

  it("accepts available: null (not verified), with method/path/docs_url null", () => {
    expect(
      check({ available: null, method: null, path: null, docs_url: null, limits: null, notes: null, checked_date: "2026-11-24" }),
    ).toEqual([]);
  });

  it("normalises every unknown to an explicit null, never undefined", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ usage_api: { available: null, checked_date: "2026-11-24" } })],
    });
    expect(result.errors).toEqual([]);
    const stored = result.document?.entries[0]?.usage_api as UsageApiFacts;
    for (const field of ["method", "path", "docs_url", "limits", "notes"] as const) {
      expect(stored[field], field).toBeNull();
    }
  });

  it("requires the `available` key (null if unknown)", () => {
    const block = usageApi();
    delete block["available"];
    expect(check(block).join(" ")).toMatch(/usage_api\.available: missing/);
  });

  it("requires `checked_date`, and that it be a real ISO date", () => {
    const missing = usageApi();
    delete missing["checked_date"];
    expect(check(missing).join(" ")).toMatch(/usage_api\.checked_date: missing/);
    expect(check(usageApi({ checked_date: null })).join(" ")).toMatch(
      /usage_api\.checked_date: expected an ISO date/,
    );
    expect(check(usageApi({ checked_date: "24-11-2026" })).join(" ")).toMatch(
      /usage_api\.checked_date: expected an ISO date/,
    );
  });

  it("requires method and path, non-null, when available is true", () => {
    expect(check(usageApi({ method: null })).join(" ")).toMatch(
      /usage_api\.method: required when available is true/,
    );
    expect(check(usageApi({ path: null })).join(" ")).toMatch(
      /usage_api\.path: required when available is true/,
    );
  });

  it("requires docs_url, non-null, when available is true or false", () => {
    expect(check(usageApi({ docs_url: null })).join(" ")).toMatch(
      /usage_api\.docs_url: required when available is true or false/,
    );
    expect(
      check(
        usageApi({ available: false, method: null, path: null, docs_url: null }),
      ).join(" "),
    ).toMatch(/usage_api\.docs_url: required when available is true or false/);
    // available: null -- docs_url may stay null, nobody checked.
    expect(
      check({ available: null, method: null, path: null, docs_url: null, checked_date: "2026-11-24" }),
    ).toEqual([]);
  });

  it("rejects a method outside the enum, case-sensitively", () => {
    expect(check(usageApi({ method: "get" })).join(" ")).toMatch(
      new RegExp(`usage_api\\.method: expected one of ${USAGE_API_METHODS.join(" \\| ")}`),
    );
    expect(check(usageApi({ method: "FETCH" })).join(" ")).toMatch(/usage_api\.method: expected one of/);
    for (const method of USAGE_API_METHODS) {
      expect(check(usageApi({ method })), method).toEqual([]);
    }
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(check(usageApi({ rate_limit: "typo" })).join(" ")).toMatch(
      /usage_api\.rate_limit: unknown field/,
    );
  });

  it("requires docs_url to be an http(s) URL when set", () => {
    expect(check(usageApi({ docs_url: "vendor.test/docs" })).join(" ")).toMatch(
      /usage_api\.docs_url: expected an http\(s\) URL or null/,
    );
  });

  it("rejects a non-mapping value", () => {
    expect(check("yes" as never).join(" ")).toMatch(/usage_api: expected a mapping or null/);
  });
});

describe("usage_api on a generated shard row", () => {
  let dir: string;

  const shard = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-usage-shard-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(file, body);
    return file;
  };

  const base = `apis:
  - id: "usage-vendor"
    name: "Usage Vendor"
    capability: "A shard row that carries a usage_api block."
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
    source_url: "https://monid.ai/tools/usage-vendor"
    checked_date: 2026-10-28
`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the usage_api block onto the index entry", () => {
    const file = shard(`${base}    usage_api:
      available: true
      method: GET
      path: "/v1/usage"
      docs_url: "https://vendor.test/docs/usage"
      limits: "paid plan only"
      notes: null
      checked_date: 2026-11-24
`);
    const { entries, errors } = readShardFile(file);
    expect(errors).toEqual([]);
    expect(entries[0]?.usage_api?.available).toBe(true);
    expect(entries[0]?.usage_api?.method).toBe("GET");
    expect(entries[0]?.usage_api?.path).toBe("/v1/usage");
    expect(entries[0]?.usage_api?.docs_url).toBe("https://vendor.test/docs/usage");
  });

  it("reports a malformed usage_api block instead of throwing, and drops just that block", () => {
    const file = shard(`${base}    usage_api:
      available: true
      method: "get"
      checked_date: 2026-11-24
`);
    const { entries, errors } = readShardFile(file);
    expect(errors.join(" ")).toMatch(/usage_api\.method: expected one of/);
    expect(entries[0]?.name).toBe("usage-vendor");
    expect(entries[0]?.usage_api).toBeNull();
  });

  it("is optional: a shard row without one still validates", () => {
    const { entries, errors } = readShardFile(shard(base));
    expect(errors).toEqual([]);
    expect(entries[0]?.usage_api).toBeNull();
  });
});

describe.skipIf(!python)("data/apis/scripts/validate.py: usage_api", () => {
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
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-noyaml-usage-"));
    fs.writeFileSync(path.join(stub, "yaml.py"), 'raise ImportError("hidden by the test suite")\n');
    return { PYTHONPATH: stub };
  };

  const write = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pyshard-usage-"));
    fs.writeFileSync(path.join(dir, "llm-models.yaml"), body);
    return dir;
  };

  const row = (usageApiBlock: string): string => `apis:
  - id: "py-usage-vendor"
    name: "Py Usage Vendor"
    capability: "A row for the python validator's usage_api checks."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: null
    access_mode: "own-account"
    signup: "unknown"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "api_key"
    seen_in: ["monid"]
    tos_notes: "Nothing reviewed."
    source_url: "https://monid.ai/tools/py-usage-vendor"
    checked_date: 2026-10-28
${usageApiBlock}`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid usage_api block, with and without PyYAML", () => {
    const target = write(
      row(`    usage_api:
      available: true
      method: GET
      path: "/v1/usage"
      docs_url: "https://vendor.test/docs/usage"
      limits: "paid plan only"
      notes: null
      checked_date: 2026-11-24
`),
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.out, JSON.stringify(env)).toMatch(/OK: all entries valid/);
      expect(result.code).toBe(0);
    }
  });

  it("accepts available: false and available: null rows", () => {
    const falseTarget = write(
      row(`    usage_api:
      available: false
      method: null
      path: null
      docs_url: "https://vendor.test/docs/no-usage"
      limits: null
      notes: null
      checked_date: 2026-11-24
`),
    );
    expect(run(falseTarget).out).toMatch(/OK: all entries valid/);
    fs.rmSync(dir, { recursive: true, force: true });

    const nullTarget = write(
      row(`    usage_api:
      available: null
      method: null
      path: null
      docs_url: null
      limits: null
      notes: null
      checked_date: 2026-11-24
`),
    );
    expect(run(nullTarget).out).toMatch(/OK: all entries valid/);
  });

  it("is optional: a row without one still validates", () => {
    const target = write(row(""));
    const result = run(target);
    expect(result.out).toMatch(/OK: all entries valid/);
    expect(result.code).toBe(0);
  });

  it("rejects the same mistakes the TypeScript validator rejects, with and without PyYAML", () => {
    const target = write(
      row(`    usage_api:
      available: true
      method: "get"
      extra: "typo"
`),
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.out).toMatch(/usage_api\.extra: unknown field/);
      expect(result.out).toMatch(/usage_api\.method: expected one of GET \| POST/);
      expect(result.out).toMatch(/usage_api\.path: required when available is true/);
      expect(result.out).toMatch(/usage_api\.checked_date: missing/);
    }
  });
});
