/**
 * The schema gaps Bei appended to the vendor-offerings requirement on
 * 2026-10-28, and the vendor-direct provenance the PM helper asked for.
 *
 *   * `access_modes`  -- a vendor that documents more than one way in
 *   * `auth_headers[].secret: false` -- a required header that is NOT a
 *     credential (askRoger's `source`, three headers in total)
 *   * `vendor-direct` in `seen_in`, in BOTH python scripts, and the optional
 *     fields list that lets a shard row carry anything beyond the 17
 *
 * `docs-verified`, `auth_required` and the keyless / wallet-x402 access modes
 * are covered in test/offering.test.ts, where they were added.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCESS_MODES,
  AGGREGATOR_NAMES,
  SHARD_SEEN_IN_SOURCES,
  VENDOR_DIRECT_SOURCE,
  isSecretAuthHeader,
  readShardFile,
  validateApis,
  validateApisFile,
} from "../src/apis.js";
import { REPO_ROOT, makeHome, removeHome, runCli } from "./helpers/env.js";

const SCRIPTS = path.join(REPO_ROOT, "data", "apis", "scripts");
const VALIDATE_PY = path.join(SCRIPTS, "validate.py");
const BUILD_PY = path.join(SCRIPTS, "build.py");
const CURATED_PY = path.join(SCRIPTS, "curated.py");
const SHARD_DIR = path.join(REPO_ROOT, "data", "apis");
const DISCOVERED_X = path.join(REPO_ROOT, "data", "discovered-x.yaml");

/** python3 and the cached raw catalogs are both optional in a checkout. */
const python = ((): boolean => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const rawCatalogs = fs.existsSync(path.join(SHARD_DIR, "raw", "glasser_public_catalog.json"));

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

/** The errors for one row, joined, so a test can match one message. */
const errorsOf = (overrides: Record<string, unknown>): string =>
  validateApis({ version: 1, entries: [entry(overrides)] }).errors.join("\n");

describe("access_modes: a vendor that documents more than one way in", () => {
  it("is optional, and a row without it is unchanged", () => {
    expect(errorsOf({})).toBe("");
    expect(errorsOf({ access_modes: null })).toBe("");
    const plain = validateApis({ version: 1, entries: [entry()] }).document?.entries[0];
    expect(plain?.access_modes).toBeUndefined();
  });

  it("keeps the list on the entry, primary mode first", () => {
    const row = validateApis({
      version: 1,
      entries: [entry({ access_mode: "own-account", access_modes: ["own-account", "wallet-x402"] })],
    });
    expect(row.errors).toEqual([]);
    expect(row.document?.entries[0]?.access_modes).toEqual(["own-account", "wallet-x402"]);
    expect(row.document?.entries[0]?.access_mode).toBe("own-account");
  });

  it("accepts every access mode in the list", () => {
    for (const mode of ACCESS_MODES) {
      expect(errorsOf({ access_mode: mode, access_modes: [mode] }), mode).toBe("");
    }
  });

  it("requires element 0 to be the mode SkeletonKey actually uses", () => {
    expect(errorsOf({ access_mode: "own-account", access_modes: ["wallet-x402", "own-account"] })).toMatch(
      /access_modes\[0\]: must match access_mode "own-account" -- the primary mode is the one SkeletonKey actually uses/,
    );
  });

  it("rejects an unknown mode, a duplicate, an empty list and a non-list", () => {
    expect(errorsOf({ access_modes: ["own-account", "crypto"] })).toMatch(
      /access_modes\[1\]: expected one of intermediary \| own-account \| byok \| keyless \| wallet-x402/,
    );
    expect(errorsOf({ access_modes: ["own-account", "own-account"] })).toMatch(
      /access_modes\[1\]: duplicate mode "own-account"/,
    );
    expect(errorsOf({ access_modes: [] })).toMatch(
      /access_modes: expected a non-empty list or null \(null means access_mode is the whole story\)/,
    );
    expect(errorsOf({ access_modes: "own-account" })).toMatch(/access_modes: expected a list or null/);
    expect(
      errorsOf({ access_modes: [...ACCESS_MODES, "own-account"] }),
    ).toMatch(/access_modes: expected at most 5 modes, got 6/);
  });
});

describe("auth_headers: a required header that is not a credential", () => {
  /** askRoger's three: two credentials, then the caller id its docs demand. */
  const askRoger = [
    { header: "api-key", format: "{key}", note: "The one SkeletonKey injects." },
    { header: "Authorization", format: "Bearer {key}", note: "A JWT the caller holds." },
    { header: "source", format: null, secret: false, note: "Not a credential." },
  ];

  it("accepts three headers, two of them credentials", () => {
    expect(
      errorsOf({
        auth_required: true,
        auth_header: "api-key",
        auth_format: "{key}",
        auth_headers: askRoger,
      }),
    ).toBe("");
    const row = validateApis({
      version: 1,
      entries: [
        entry({ auth_required: true, auth_header: "api-key", auth_format: "{key}", auth_headers: askRoger }),
      ],
    }).document?.entries[0];
    expect(row?.auth_headers?.length).toBe(3);
    expect(row?.auth_headers?.map((item) => item.secret)).toEqual([true, true, false]);
    expect(row?.auth_headers?.[2]?.format).toBeNull();
    // `secret` defaults to true, which is what every row written before the
    // field existed means.
    expect(row?.auth_headers?.map(isSecretAuthHeader)).toEqual([true, true, false]);
  });

  it("lets a non-secret header carry a literal value, but never {key}", () => {
    const base = { auth_header: "api-key", auth_format: "{key}", auth_required: true };
    expect(
      errorsOf({
        ...base,
        auth_headers: [
          { header: "api-key", format: "{key}" },
          { header: "x-api-version", format: "2026-10-28", secret: false },
        ],
      }),
    ).toBe("");
    expect(
      errorsOf({
        ...base,
        auth_headers: [
          { header: "api-key", format: "{key}" },
          { header: "source", format: "Bearer {key}", secret: false },
        ],
      }),
    ).toMatch(
      /auth_headers\[1\]\.format: secret: false means the value is not a credential, so it must not contain the \{key\} placeholder/,
    );
  });

  it("still demands a {key} template from a credential header", () => {
    expect(
      errorsOf({
        auth_header: "api-key",
        auth_format: "{key}",
        auth_headers: [{ header: "api-key", format: "{key}" }, { header: "X-Other", format: "literal" }],
      }),
    ).toMatch(/auth_headers\[1\]\.format: must contain the \{key\} placeholder/);
    expect(
      errorsOf({
        auth_header: "api-key",
        auth_format: "{key}",
        auth_headers: [{ header: "api-key", format: "{key}" }, { header: "X-Other", format: null }],
      }),
    ).toMatch(/auth_headers\[1\]\.format: expected a non-empty template/);
  });

  it("refuses to make a non-secret header the one the proxy injects", () => {
    expect(
      errorsOf({
        auth_header: "source",
        auth_format: "{key}",
        auth_headers: [{ header: "source", format: null, secret: false }],
      }),
    ).toMatch(
      /auth_headers\[0\]\.secret: element 0 is the credential the proxy injects into auth_header "source", so it cannot be secret: false/,
    );
  });

  it("lets a keyless vendor require a non-secret header", () => {
    // auth_required: false says the vendor documents no CREDENTIAL. A required
    // API version or caller id is not one, so it must not contradict it.
    expect(
      errorsOf({
        auth_required: false,
        auth_headers: [{ header: "x-api-version", format: "2026-10-28", secret: false }],
      }),
    ).toBe("");
    expect(
      errorsOf({
        auth_required: false,
        auth_headers: [{ header: "X-Key", format: "{key}" }],
      }),
    ).toMatch(/auth_required: false contradicts auth_headers having a credential header/);
  });

  it("rejects a non-boolean secret", () => {
    expect(
      errorsOf({ auth_headers: [{ header: "X-Key", format: "{key}", secret: "yes" }] }),
    ).toMatch(/auth_headers\[0\]\.secret: expected a boolean or null/);
  });
});

describe("vendor-direct provenance on a shard row", () => {
  let dir: string | undefined;

  const shard = (seenIn: string, extra = ""): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-vd-"));
    const file = path.join(dir, "llm-models.yaml");
    fs.writeFileSync(
      file,
      `apis:
  - id: "direct-vendor"
    name: "Direct Vendor"
    capability: "A row read off the vendor's own pages."
    category: "llm-models"
    provider_url: "https://vendor.test"
    docs_url: "https://vendor.test/docs"
    access_mode: "own-account"
    signup: "self-serve"
    signup_automatable: "unknown"
    min_topup: null
    billing_unit: null
    free_tier: null
    auth_type: "api_key"
    seen_in: ${seenIn}
    tos_notes: "Read off the vendor's own pages."
    source_url: "https://vendor.test/docs"
    checked_date: 2026-10-28
${extra}`,
    );
    return file;
  };

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("names vendor-direct alongside the three aggregators", () => {
    expect(SHARD_SEEN_IN_SOURCES).toEqual([...AGGREGATOR_NAMES, "vendor-direct"]);
    expect(VENDOR_DIRECT_SOURCE).toBe("vendor-direct");
  });

  it("leaves aggregator carriage NULL rather than claiming three unchecked negatives", () => {
    const row = readShardFile(shard('["vendor-direct"]')).entries[0];
    expect(row?.aggregators).toBeNull();
  });

  it("still records carriage when an aggregator did list the provider", () => {
    const row = readShardFile(shard('["monid"]')).entries[0];
    expect(row?.aggregators?.find((item) => item.name === "monid")?.carries).toBe(true);
    expect(row?.aggregators?.find((item) => item.name === "glasser")?.carries).toBe(false);
  });

  it("keeps the carriage rows for a row seen BOTH ways", () => {
    const row = readShardFile(shard('["monid", "vendor-direct"]')).entries[0];
    expect(row?.aggregators?.find((item) => item.name === "monid")?.carries).toBe(true);
  });

  it("reads an optional access_modes list off a shard row", () => {
    const row = readShardFile(
      shard('["vendor-direct"]', '    access_modes: ["own-account", "wallet-x402"]\n'),
    ).entries[0];
    expect(row?.access_modes).toEqual(["own-account", "wallet-x402"]);
    expect(readShardFile(shard('["monid"]')).entries[0]?.access_modes).toBeNull();
  });
});

describe.skipIf(!python)("data/apis/scripts/validate.py: vendor-direct and optional fields", () => {
  let dir: string | undefined;

  const run = (target: string): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync("python3", [VALIDATE_PY, target], { encoding: "utf8" }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  const write = (fields: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-pyvd-"));
    fs.writeFileSync(
      path.join(dir, "llm-models.yaml"),
      `apis:
  - id: "py-direct"
    name: "Py Direct"
    capability: "A vendor-direct row for the python validator."
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
    tos_notes: "Read off the vendor's own pages."
    source_url: "https://vendor.test/docs"
    checked_date: 2026-10-28
${fields}`,
    );
    return dir;
  };

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("accepts seen_in: [vendor-direct]", () => {
    const result = run(write('    seen_in: ["vendor-direct"]\n'));
    expect(result.out).toContain("OK: all entries valid");
    expect(result.code).toBe(0);
  });

  it("accepts it mixed with an aggregator, and still rejects an unknown source", () => {
    expect(run(write('    seen_in: ["monid", "vendor-direct"]\n')).code).toBe(0);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    const bad = run(write('    seen_in: ["vendor-site"]\n'));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/seen_in has unknown sources \['vendor-site'\]/);
  });

  it("accepts the optional access_modes list and pins element 0", () => {
    expect(
      run(write('    seen_in: ["vendor-direct"]\n    access_modes: ["own-account", "wallet-x402"]\n')).code,
    ).toBe(0);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    const bad = run(write('    seen_in: ["monid"]\n    access_modes: ["wallet-x402"]\n'));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/access_modes\[0\]: must match access_mode 'own-account'/);
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    const unknown = run(write('    seen_in: ["monid"]\n    access_modes: ["own-account", "crypto"]\n'));
    expect(unknown.code).toBe(1);
    expect(unknown.out).toMatch(/access_modes\[1\]: expected one of/);
  });

  it("names every optional key in one list, so a row carrying none is still valid", () => {
    const source = fs.readFileSync(VALIDATE_PY, "utf8");
    const optional = [...(/OPTIONAL = \[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (hit) => hit[1] as string,
    );
    expect(optional).toContain("offering");
    expect(optional).toContain("access_modes");
    // Still fails closed on anything NOT in that list.
    const bad = run(write('    seen_in: ["monid"]\n    probe_path: "/v1/ping"\n'));
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/unexpected key `probe_path`/);
  });

  it("knows the same seen_in sources as src/apis.ts", () => {
    const source = fs.readFileSync(VALIDATE_PY, "utf8");
    const sources = [...(/^SOURCES = \{([^}]*)\}/m.exec(source)?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (hit) => hit[1] as string,
    );
    expect(new Set(sources)).toEqual(new Set(SHARD_SEEN_IN_SOURCES));
  });

  it("still passes on every shard shipped in the repo", () => {
    const result = run(SHARD_DIR);
    expect(result.out).toContain("OK: all entries valid");
    expect(result.code).toBe(0);
  });

  it("reads the new fields on a bare interpreter too (no PyYAML)", () => {
    // The fallback reader is a hand-written YAML subset, so a new nested or
    // list-valued field has to be exercised against it, not just PyYAML.
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-noyaml-"));
    fs.writeFileSync(path.join(stub, "yaml.py"), 'raise ImportError("hidden by the test suite")\n');
    const noYaml = (target: string): { code: number; out: string } => {
      try {
        return {
          code: 0,
          out: execFileSync("python3", [VALIDATE_PY, target], {
            encoding: "utf8",
            env: { ...process.env, PYTHONPATH: stub },
          }),
        };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
      }
    };
    try {
      // Inline list, block list, and the committed shards.
      expect(
        noYaml(write('    seen_in: ["vendor-direct"]\n    access_modes: ["own-account", "wallet-x402"]\n'))
          .code,
      ).toBe(0);
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      expect(
        noYaml(
          write(
            '    seen_in:\n      - vendor-direct\n    access_modes:\n      - own-account\n      - wallet-x402\n',
          ),
        ).code,
      ).toBe(0);
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      const bad = noYaml(write('    seen_in: ["monid"]\n    access_modes: ["wallet-x402"]\n'));
      expect(bad.code).toBe(1);
      expect(bad.out).toMatch(/access_modes\[0\]: must match access_mode/);
      expect(noYaml(SHARD_DIR).out).toContain("OK: all entries valid");
    } finally {
      fs.rmSync(stub, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!python || !rawCatalogs)("data/apis/scripts/build.py: vendor-direct rows", () => {
  let out: string | undefined;

  /**
   * Builds the shards into a temp directory, optionally with one extra
   * vendor-direct provider injected into the curated tables. build.py reads the
   * cached raw catalogs from the repo and writes only where we point it.
   */
  const build = (inject: boolean): { code: number; out: string; dir: string } => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), "skeletonkey-build-"));
    const harness = inject
      ? `import curated
curated.VENDOR_DIRECT = {'vd-probe': 'https://vendor.test/docs/api'}
curated.P['vd-probe'] = ('llm-models', 'A row read off the vendor own pages.',
                        'https://vendor.test', 'https://vendor.test/docs/api',
                        curated.KEYLESS, 'unknown', 'none')
`
      : "";
    try {
      const stdout = execFileSync(
        "python3",
        ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})\n${harness}import runpy; runpy.run_path(${JSON.stringify(BUILD_PY)}, run_name='__main__')`],
        { encoding: "utf8", cwd: SCRIPTS, env: { ...process.env, SKELETONKEY_BUILD_OUT: out } },
      );
      return { code: 0, out: stdout, dir: out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, dir: out };
    }
  };

  afterEach(() => {
    if (out !== undefined) fs.rmSync(out, { recursive: true, force: true });
    out = undefined;
  });

  it("rebuilds the committed shards byte for byte, with no vendor-direct rows", () => {
    const result = build(false);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.slice(result.out.indexOf("{")))["vendor_direct_providers"]).toBe(0);
    for (const file of fs.readdirSync(SHARD_DIR).filter((name) => name.endsWith(".yaml"))) {
      expect(fs.readFileSync(path.join(result.dir, file), "utf8"), file).toBe(
        fs.readFileSync(path.join(SHARD_DIR, file), "utf8"),
      );
    }
  });

  it("emits an injected vendor-direct provider with the vendor's own source_url", () => {
    const result = build(true);
    expect(result.code).toBe(0);
    const shard = fs.readFileSync(path.join(result.dir, "llm-models.yaml"), "utf8");
    const row = shard.slice(shard.indexOf('- id: "vd-probe"'));
    expect(row).toContain('seen_in: ["vendor-direct"]');
    expect(row).toContain('source_url: "https://vendor.test/docs/api"');
    // No aggregator was searched for it, so no aggregator slug appears either.
    expect(row.slice(0, row.indexOf("- id:", 4))).not.toMatch(/monid|glasser|flatkey/);
    expect(JSON.parse(result.out.slice(result.out.indexOf("{")))["vendor_direct_providers"]).toBe(1);
  });

  it("writes a vendor-direct row the python validator then accepts", () => {
    const result = build(true);
    expect(result.code).toBe(0);
    const validated = execFileSync("python3", [VALIDATE_PY, result.dir], { encoding: "utf8" });
    expect(validated).toContain("OK: all entries valid");
    expect(validated).toContain("entries: 163");
  });

  it("documents in curated.py where vendor-direct rows live, and ships the table empty", () => {
    const curated = fs.readFileSync(CURATED_PY, "utf8");
    expect(curated).toMatch(/^VENDOR_DIRECT = \{\}$/m);
    expect(curated).toContain("apis.yaml");
  });
});

describe.skipIf(!fs.existsSync(DISCOVERED_X))("data/discovered-x.yaml after the 10-28 migration", () => {
  const document = validateApisFile(DISCOVERED_X);
  const entries = document.document?.entries ?? [];
  const byName = new Map(entries.map((row) => [row.name, row]));

  it("validates against the same schema as apis.yaml", () => {
    expect(document.errors).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("claims `verified` nowhere: docs-only rows are docs-verified (count grows as entries are added)", () => {
    const counts = new Map<string, number>();
    for (const row of entries) {
      const status = row.status ?? "none";
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    expect(counts.get("verified") ?? 0).toBe(0);
    expect(counts.get("docs-verified")).toBeGreaterThanOrEqual(10);
    expect(counts.get("unverified")).toBeGreaterThanOrEqual(2);
  });

  it("says auth_required: false only where the vendor documents no credential", () => {
    for (const row of entries) {
      if (row.auth_required === false) {
        expect(row.auth_header ?? null, row.name).toBeNull();
        expect(row.access_mode, row.name).toBe("keyless");
      }
      // A docs-verified row that names a header has had its auth CHECKED, so
      // auth_required must not still be the "nobody looked" null.
      if (row.status === "docs-verified" && (row.auth_header ?? null) !== null) {
        expect(row.auth_required, row.name).toBe(true);
      }
    }
  });

  it("records the x402 path on the rows whose vendors document one", () => {
    for (const name of ["glim-sh", "elfa-api"]) {
      const row = byName.get(name);
      expect(row?.access_mode, name).toBe("own-account");
      expect(row?.access_modes, name).toEqual(["own-account", "wallet-x402"]);
    }
    // AStock's own llms.txt says reads need no key at all.
    expect(byName.get("astock-api")?.access_modes).toEqual(["own-account", "keyless"]);
  });

  it("records all three headers askRoger's docs require", () => {
    const headers = byName.get("askroger-api")?.auth_headers ?? [];
    expect(headers.map((item) => item.header)).toEqual(["api-key", "Authorization", "source"]);
    expect(headers.map(isSecretAuthHeader)).toEqual([true, true, false]);
    // Element 0 is the one the proxy injects, so it must be the primary pair.
    expect(byName.get("askroger-api")?.auth_header).toBe("api-key");
    expect(headers[2]?.format).toBeNull();
  });
});

describe("skeletonkey apis show renders the new fields", () => {
  it("prints the extra access modes and every required header", async () => {
    const home = makeHome();
    const file = path.join(home, "index.yaml");
    fs.writeFileSync(
      file,
      `version: 1
entries:
  - name: two-ways-vendor
    url: https://vendor.test
    access_mode: own-account
    access_modes:
      - own-account
      - wallet-x402
    min_topup: null
    billing_unit: null
    signup_automatable: null
    tos_notes: null
    source: null
    checked_date: null
    auth_required: true
    auth_header: api-key
    auth_format: "{key}"
    auth_headers:
      - header: api-key
        format: "{key}"
      - header: source
        format: null
        secret: false
        note: "Required, not a credential."
`,
    );
    try {
      const result = await runCli(home, ["apis", "show", "two-ways-vendor"], undefined, {
        SKELETONKEY_APIS: file,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("own-account (also wallet-x402)");
      expect(result.stdout).toContain("2 required by the vendor's docs");
      expect(result.stdout).toContain("api-key: {key}  [credential]");
      expect(result.stdout).toContain("source: value not documented  [not a secret]");
    } finally {
      removeHome(home);
    }
  });
});
