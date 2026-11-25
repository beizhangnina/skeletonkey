import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_TYPES,
  ENDPOINTS_MAX,
  ENDPOINTS_NOTE_MAX,
  ENDPOINT_RETURNS_MAX,
  ENDPOINT_SUMMARY_MAX,
  HTTP_METHODS,
  PRICING_MODELS,
  PRICING_NOTES_MAX,
  readShardFile,
  validateApis,
  validateApisFile,
  type ApiEndpoint,
} from "../src/apis.js";
import { REPO_ROOT } from "./helpers/env.js";

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

/** A complete, valid fixture row: every error case below is one deviation from it. */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return entry({
    official_docs_url: "https://vendor.test/docs",
    auth: {
      type: "bearer",
      header: "Authorization",
      format: "Bearer <API_KEY>",
      docs_url: "https://vendor.test/docs/auth",
    },
    pricing: {
      model: "pay_as_you_go",
      free_tier: true,
      starting_price_usd: 0.002,
      unit: "per 1,000 requests",
      pricing_url: "https://vendor.test/pricing",
      notes: "Billed monthly in arrears.",
    },
    endpoints: [
      {
        method: "GET",
        path: "/v1/search",
        summary: "Full-text search over the vendor's index.",
        returns: "A list of matching documents.",
        docs_url: "https://vendor.test/docs/search",
      },
      {
        method: "POST",
        path: "/v1/items/{id}/annotate",
        summary: null,
        returns: null,
        docs_url: null,
      },
    ],
    endpoints_note: null,
    ...overrides,
  });
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

describe("existing data stays valid", () => {
  it("apis.yaml still validates with the new fields added to the schema", () => {
    expect(validateApisFile(APIS_YAML).errors).toEqual([]);
  });

  it("every shipped shard still validates", () => {
    for (const file of fs.readdirSync(SHARD_DIR).filter((name) => name.endsWith(".yaml"))) {
      const { errors } = readShardFile(path.join(SHARD_DIR, file));
      expect(errors, file).toEqual([]);
    }
  });

  it("a plain row with none of the five fields is as valid as it ever was", () => {
    expect(validateApis({ version: 1, entries: [entry()] }).errors).toEqual([]);
  });
});

describe("a full valid fixture row", () => {
  it("round-trips every field with no errors", () => {
    const result = validateApis({ version: 1, entries: [fixture()] });
    expect(result.errors).toEqual([]);
    const stored = result.document?.entries[0];
    expect(stored?.official_docs_url).toBe("https://vendor.test/docs");
    expect(stored?.auth?.type).toBe("bearer");
    expect(stored?.auth?.format).toBe("Bearer <API_KEY>");
    expect(stored?.pricing?.model).toBe("pay_as_you_go");
    expect(stored?.pricing?.starting_price_usd).toBe(0.002);
    expect(stored?.endpoints?.length).toBe(2);
    expect((stored?.endpoints as ApiEndpoint[])[0]?.method).toBe("GET");
    expect(stored?.endpoints_note).toBeNull();
  });

  it("normalises every unset nested field to an explicit null", () => {
    const result = validateApis({
      version: 1,
      entries: [entry({ auth: { type: "api_key" }, pricing: { model: null } })],
    });
    expect(result.errors).toEqual([]);
    const auth = result.document?.entries[0]?.auth;
    expect(auth?.header).toBeNull();
    expect(auth?.format).toBeNull();
    expect(auth?.docs_url).toBeNull();
    const pricing = result.document?.entries[0]?.pricing;
    expect(pricing?.free_tier).toBeNull();
    expect(pricing?.starting_price_usd).toBeNull();
  });

  it("rejects an unknown top-level field", () => {
    expect(errorsOf({ offical_docs_url: "typo" }).join(" ")).toMatch(/offical_docs_url: unknown field/);
  });
});

describe("official_docs_url", () => {
  it("must be an http(s) URL or null", () => {
    expect(errorsOf({ official_docs_url: "vendor.test/docs" }).join(" ")).toMatch(
      /official_docs_url: expected an http\(s\) URL or null/,
    );
    expect(errorsOf({ official_docs_url: null })).toEqual([]);
  });
});

describe("auth", () => {
  it("requires type when the block exists", () => {
    expect(errorsOf({ auth: { header: "X-Key" } }).join(" ")).toMatch(
      /auth\.type: missing \(required when auth is set\)/,
    );
  });

  it("takes type only from the closed list", () => {
    expect(errorsOf({ auth: { type: "jwt" } }).join(" ")).toMatch(
      new RegExp(`auth\\.type: expected one of ${AUTH_TYPES.join(" \\| ")}`),
    );
    for (const type of AUTH_TYPES) {
      expect(errorsOf({ auth: { type } }), type).toEqual([]);
    }
  });

  it("rejects an unknown field", () => {
    expect(errorsOf({ auth: { type: "api_key", scheme: "x" } }).join(" ")).toMatch(/auth\.scheme: unknown field/);
  });

  it("rejects a header with a colon or space", () => {
    expect(errorsOf({ auth: { type: "api_key", header: "X-Key: " } }).join(" ")).toMatch(
      /auth\.header: expected a header name only/,
    );
  });

  it("will not let type `none` sit beside a header or a format", () => {
    expect(errorsOf({ auth: { type: "none", header: "X-Key" } }).join(" ")).toMatch(
      /auth\.header: must be null when type is none/,
    );
    expect(errorsOf({ auth: { type: "none", format: "<KEY>" } }).join(" ")).toMatch(
      /auth\.format: must be null when type is none/,
    );
    expect(errorsOf({ auth: { type: "none" } })).toEqual([]);
  });

  it("requires format to contain a <...> placeholder, never a real secret", () => {
    expect(errorsOf({ auth: { type: "bearer", format: "Bearer sk-live-abc123" } }).join(" ")).toMatch(
      /auth\.format: must contain a <\.\.\.> placeholder/,
    );
    expect(errorsOf({ auth: { type: "bearer", format: "Bearer <API_KEY>" } })).toEqual([]);
  });

  it("validates docs_url as an http(s) URL or null", () => {
    expect(errorsOf({ auth: { type: "api_key", docs_url: "not-a-url" } }).join(" ")).toMatch(
      /auth\.docs_url: expected an http\(s\) URL or null/,
    );
  });
});

describe("pricing", () => {
  it("takes model only from the closed list, or null", () => {
    expect(errorsOf({ pricing: { model: "enterprise" } }).join(" ")).toMatch(
      new RegExp(`pricing\\.model: expected one of ${PRICING_MODELS.join(" \\| ")} or null`),
    );
    for (const model of PRICING_MODELS) {
      expect(errorsOf({ pricing: { model } }), model).toEqual([]);
    }
    expect(errorsOf({ pricing: { model: null } })).toEqual([]);
  });

  it("rejects an unknown field", () => {
    expect(errorsOf({ pricing: { tier: "pro" } }).join(" ")).toMatch(/pricing\.tier: unknown field/);
  });

  it("never lets starting_price_usd be negative", () => {
    expect(errorsOf({ pricing: { starting_price_usd: -1 } }).join(" ")).toMatch(
      /pricing\.starting_price_usd: expected a non-negative number or null/,
    );
    expect(errorsOf({ pricing: { starting_price_usd: 0 } })).toEqual([]);
  });

  it("keeps free_tier a tri-state", () => {
    expect(errorsOf({ pricing: { free_tier: "yes" } }).join(" ")).toMatch(
      /pricing\.free_tier: expected a boolean or null/,
    );
  });

  it("validates pricing_url as an http(s) URL or null", () => {
    expect(errorsOf({ pricing: { pricing_url: "ftp://vendor.test" } }).join(" ")).toMatch(
      /pricing\.pricing_url: expected an http\(s\) URL or null/,
    );
  });

  it("keeps notes to one line and at most the cap", () => {
    expect(errorsOf({ pricing: { notes: "two\nlines" } }).join(" ")).toMatch(
      /pricing\.notes: expected a single line/,
    );
    expect(errorsOf({ pricing: { notes: "x".repeat(PRICING_NOTES_MAX + 1) } }).join(" ")).toMatch(
      new RegExp(`pricing\\.notes: expected at most ${PRICING_NOTES_MAX} characters`),
    );
    expect(errorsOf({ pricing: { notes: "x".repeat(PRICING_NOTES_MAX) } })).toEqual([]);
  });
});

describe("endpoints", () => {
  const withEndpoints = (endpoints: unknown, note?: unknown): string[] =>
    errorsOf(note === undefined ? { endpoints } : { endpoints, endpoints_note: note });

  it("is optional: null means not verified yet", () => {
    expect(withEndpoints(null)).toEqual([]);
  });

  it("rejects a bad method", () => {
    expect(withEndpoints([{ method: "FETCH", path: "/v1/x" }]).join(" ")).toMatch(
      new RegExp(`endpoints\\[0\\]\\.method: must be one of ${HTTP_METHODS.join(", ")}`),
    );
  });

  it("accepts every valid method", () => {
    for (const method of HTTP_METHODS) {
      expect(withEndpoints([{ method, path: "/v1/x" }]), method).toEqual([]);
    }
  });

  it("rejects a path with no leading slash", () => {
    expect(withEndpoints([{ method: "GET", path: "v1/x" }]).join(" ")).toMatch(
      /endpoints\[0\]\.path: expected a path starting with "\/"/,
    );
  });

  it("rejects a path containing whitespace", () => {
    expect(withEndpoints([{ method: "GET", path: "/v1/ x" }]).join(" ")).toMatch(
      /endpoints\[0\]\.path: expected no whitespace/,
    );
  });

  it("rejects a duplicate method+path pair within one row", () => {
    expect(
      withEndpoints([
        { method: "GET", path: "/v1/x" },
        { method: "GET", path: "/v1/x" },
      ]).join(" "),
    ).toMatch(/endpoints\[1\]: duplicate method\+path "GET \/v1\/x"/);
    // Same path, different method: not a duplicate.
    expect(
      withEndpoints([
        { method: "GET", path: "/v1/x" },
        { method: "POST", path: "/v1/x" },
      ]),
    ).toEqual([]);
  });

  it(`caps the list at ${ENDPOINTS_MAX}`, () => {
    const row = (n: number): Record<string, unknown> => ({ method: "GET", path: `/v1/x${n}` });
    const max = Array.from({ length: ENDPOINTS_MAX }, (_item, n) => row(n));
    expect(withEndpoints(max)).toEqual([]);
    const over = [...max, row(ENDPOINTS_MAX)];
    expect(withEndpoints(over).join(" ")).toMatch(
      new RegExp(`endpoints: expected at most ${ENDPOINTS_MAX} entries, got ${ENDPOINTS_MAX + 1}`),
    );
  });

  it("requires a non-empty endpoints_note when endpoints is []", () => {
    expect(withEndpoints([]).join(" ")).toMatch(
      /endpoints: expected a non-empty endpoints_note when endpoints is \[\]/,
    );
    expect(withEndpoints([], "No self-serve public API; sales only.")).toEqual([]);
    expect(withEndpoints([], "")).not.toEqual([]);
  });

  it("rejects an unknown field on an endpoint row", () => {
    expect(withEndpoints([{ method: "GET", path: "/v1/x", rate_limit: "10/s" }]).join(" ")).toMatch(
      /endpoints\[0\]\.rate_limit: unknown field/,
    );
  });

  it("keeps summary and returns to one line and at most their caps", () => {
    expect(
      withEndpoints([{ method: "GET", path: "/v1/x", summary: "two\nlines" }]).join(" "),
    ).toMatch(/endpoints\[0\]\.summary: expected a single line/);
    expect(
      withEndpoints([{ method: "GET", path: "/v1/x", summary: "x".repeat(ENDPOINT_SUMMARY_MAX + 1) }]).join(" "),
    ).toMatch(new RegExp(`endpoints\\[0\\]\\.summary: expected at most ${ENDPOINT_SUMMARY_MAX} characters`));
    expect(
      withEndpoints([{ method: "GET", path: "/v1/x", returns: "x".repeat(ENDPOINT_RETURNS_MAX + 1) }]).join(" "),
    ).toMatch(new RegExp(`endpoints\\[0\\]\\.returns: expected at most ${ENDPOINT_RETURNS_MAX} characters`));
  });

  it("validates docs_url on an endpoint row as an http(s) URL or null", () => {
    expect(withEndpoints([{ method: "GET", path: "/v1/x", docs_url: "nowhere" }]).join(" ")).toMatch(
      /endpoints\[0\]\.docs_url: expected an http\(s\) URL or null/,
    );
  });
});

describe("endpoints_note on its own", () => {
  it("keeps it to one line and at most the cap", () => {
    expect(errorsOf({ endpoints_note: "two\nlines" }).join(" ")).toMatch(
      /endpoints_note: expected a single line/,
    );
    expect(errorsOf({ endpoints_note: "x".repeat(ENDPOINTS_NOTE_MAX + 1) }).join(" ")).toMatch(
      new RegExp(`endpoints_note: expected at most ${ENDPOINTS_NOTE_MAX} characters`),
    );
    expect(errorsOf({ endpoints_note: null })).toEqual([]);
  });
});

describe("structured fields on a generated shard row", () => {
  let dir: string;

  const shard = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-struct-shard-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(file, body);
    return file;
  };

  const base = `apis:
  - id: "struct-vendor"
    name: "Struct Vendor"
    capability: "A shard row that carries the ND-8 fields."
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
    source_url: "https://monid.ai/tools/struct-vendor"
    checked_date: 2026-10-28
`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the fields onto the index entry", () => {
    const file = shard(`${base}    official_docs_url: "https://vendor.test/docs"
    auth:
      type: "api_key"
      header: "X-Api-Key"
      format: "<API_KEY>"
      docs_url: null
    pricing:
      model: "freemium"
      free_tier: true
      starting_price_usd: null
      unit: null
      pricing_url: null
      notes: null
    endpoints:
      - method: "GET"
        path: "/v1/ping"
        summary: null
        returns: null
        docs_url: null
    endpoints_note: null
`);
    const { entries, errors } = readShardFile(file);
    expect(errors).toEqual([]);
    expect(entries[0]?.official_docs_url).toBe("https://vendor.test/docs");
    expect(entries[0]?.auth?.type).toBe("api_key");
    expect(entries[0]?.pricing?.model).toBe("freemium");
    expect(entries[0]?.endpoints?.[0]?.path).toBe("/v1/ping");
  });

  it("reports a malformed block instead of throwing, and drops just that row's structured fields", () => {
    const file = shard(`${base}    auth:
      type: "jwt-ish"
`);
    const { entries, errors } = readShardFile(file);
    expect(errors.join(" ")).toMatch(/auth\.type: expected one of/);
    expect(entries[0]?.name).toBe("struct-vendor");
    expect(entries[0]?.auth).toBeUndefined();
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
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-struct-noyaml-"));
    fs.writeFileSync(path.join(stub, "yaml.py"), 'raise ImportError("hidden by the test suite")\n');
    return { PYTHONPATH: stub };
  };

  const write = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-struct-pyshard-"));
    fs.writeFileSync(path.join(dir, "llm-models.yaml"), body);
    return dir;
  };

  const row = (extra: string): string => `apis:
  - id: "py-struct-vendor"
    name: "Py Struct Vendor"
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
    source_url: "https://monid.ai/tools/py-struct-vendor"
    checked_date: 2026-10-28
${extra}`;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a fully populated set of structured fields, with and without PyYAML", () => {
    const target = write(
      row(`    official_docs_url: "https://vendor.test/docs"
    auth:
      type: "bearer"
      header: "Authorization"
      format: "Bearer <API_KEY>"
      docs_url: "https://vendor.test/docs/auth"
    pricing:
      model: "pay_as_you_go"
      free_tier: true
      starting_price_usd: 0.002
      unit: "per 1,000 requests"
      pricing_url: "https://vendor.test/pricing"
      notes: "Billed monthly in arrears."
    endpoints:
      - method: "GET"
        path: "/v1/search"
        summary: "Full-text search."
        returns: "A list of documents."
        docs_url: "https://vendor.test/docs/search"
      - method: "POST"
        path: "/v1/items/{id}/annotate"
        summary: null
        returns: null
        docs_url: null
    endpoints_note: null
`),
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.out, JSON.stringify(env)).toMatch(/OK: all entries valid/);
      expect(result.code).toBe(0);
    }
  });

  it("rejects the same mistakes the TypeScript validator rejects, with and without PyYAML", () => {
    const target = write(
      row(`    official_docs_url: "not-a-url"
    auth:
      type: "jwt"
      header: "X-Key"
    pricing:
      model: "enterprise"
      starting_price_usd: -5
    endpoints:
      - method: "FETCH"
        path: "v1/x"
      - method: "GET"
        path: "/v1/y"
      - method: "GET"
        path: "/v1/y"
    endpoints_note: ""
`),
    );
    for (const env of [{}, noYaml()]) {
      const result = run(target, env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.out).toMatch(/official_docs_url: expected an http\(s\) URL or null/);
      expect(result.out).toMatch(/auth\.type: expected one of/);
      expect(result.out).toMatch(/pricing\.model: expected one of/);
      expect(result.out).toMatch(/pricing\.starting_price_usd: expected a non-negative number or null/);
      expect(result.out).toMatch(/endpoints\[0\]\.method: must be one of/);
      expect(result.out).toMatch(/endpoints\[0\]\.path: expected a path starting with/);
      expect(result.out).toMatch(/endpoints\[2\]: duplicate method\+path/);
      expect(result.out).toMatch(/endpoints_note: expected a non-empty string or null/);
    }
  });

  it("rejects more than the capped number of endpoints", () => {
    const endpoints = Array.from(
      { length: ENDPOINTS_MAX + 1 },
      (_item, n) => `      - method: "GET"\n        path: "/v1/x${n}"`,
    ).join("\n");
    const target = write(row(`    endpoints:\n${endpoints}\n`));
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      new RegExp(`endpoints: expected at most ${ENDPOINTS_MAX} entries, got ${ENDPOINTS_MAX + 1}`),
    );
  });

  it("requires endpoints_note when endpoints is []", () => {
    const target = write(row(`    endpoints: []\n`));
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/endpoints: expected a non-empty endpoints_note when endpoints is \[\]/);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });

    const target2 = write(row(`    endpoints: []\n    endpoints_note: "Sales-gated; no self-serve API."\n`));
    const result2 = run(target2);
    expect(result2.code).toBe(0);
  });

  it("rejects an unknown field inside auth/pricing/an endpoint row", () => {
    const target = write(
      row(`    auth:
      type: "api_key"
      scheme: "x"
    pricing:
      tier: "pro"
    endpoints:
      - method: "GET"
        path: "/v1/x"
        rate_limit: "10/s"
`),
    );
    const result = run(target);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/auth\.scheme: unknown field/);
    expect(result.out).toMatch(/pricing\.tier: unknown field/);
    expect(result.out).toMatch(/endpoints\[0\]\.rate_limit: unknown field/);
  });
});

describe("the two validators agree (ND-8 drift check)", () => {
  const source = fs.readFileSync(VALIDATE_PY, "utf8");

  /** Pulls a python list-of-strings literal (possibly multi-line) out of validate.py. */
  const pyList = (name: string): string[] => {
    const match = new RegExp(`${name} = \\[([^\\]]*)\\]`, "s").exec(source);
    expect(match, `${name} missing from validate.py`).not.toBeNull();
    return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((hit) => hit[1] as string);
  };

  const pyNumber = (name: string): number =>
    Number(new RegExp(`${name} = (\\d+)`).exec(source)?.[1] ?? NaN);

  it("ships the same auth types", () => {
    expect(pyList("AUTH_TYPES")).toEqual([...AUTH_TYPES]);
  });

  it("ships the same pricing models", () => {
    expect(pyList("PRICING_MODELS")).toEqual([...PRICING_MODELS]);
  });

  it("ships the same HTTP methods", () => {
    expect(pyList("HTTP_METHODS")).toEqual([...HTTP_METHODS]);
  });

  it("ships the same caps", () => {
    expect(pyNumber("ENDPOINTS_MAX")).toBe(ENDPOINTS_MAX);
    expect(pyNumber("ENDPOINT_SUMMARY_MAX")).toBe(ENDPOINT_SUMMARY_MAX);
    expect(pyNumber("ENDPOINT_RETURNS_MAX")).toBe(ENDPOINT_RETURNS_MAX);
    expect(pyNumber("PRICING_NOTES_MAX")).toBe(PRICING_NOTES_MAX);
    expect(pyNumber("ENDPOINTS_NOTE_MAX")).toBe(ENDPOINTS_NOTE_MAX);
  });
});
