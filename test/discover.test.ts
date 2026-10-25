import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApiIndex, validateApisFile } from "../src/apis.js";
import { looksLikeSecret, promoteFromLedger, proposeEntry, readUserIndex } from "../src/discover.js";
import { openLedger } from "../src/ledger.js";
import { REPO_ROOT, makeHome, removeHome } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const SEED = path.join(REPO_ROOT, "data", "discovered.example.yaml");

/** A plausible discovery: a free, keyless-to-start public API. */
function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "demo-cve-api",
    url: "https://vendor.test/docs",
    domain: "api.vendor.test",
    access_mode: "own-account",
    capabilities: ["cve lookup", "vulnerability data"],
    auth_header: "apiKey",
    auth_format: "{key}",
    base_url: "https://api.vendor.test/v1",
    signup_url: "https://vendor.test/request-a-key",
    billing: {
      model: "free",
      free_tier_note: "no paid tier; the API answered 200 with no credential",
      verified_url: "https://vendor.test/pricing",
      verified_date: "2026-10-24",
    },
    source_urls: ["https://vendor.test/docs", "https://vendor.test/pricing"],
    ...overrides,
  };
}

describe("propose_entry (the write side of discover-on-miss)", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = makeHome();
    file = path.join(home, "discovered.yaml");
  });
  afterEach(() => removeHome(home));

  it("writes a row, forces status: unverified, and dates it", () => {
    const result = proposeEntry(proposal(), { file, today: "2026-10-24" });
    expect(result.errors).toEqual([]);
    expect(result.written).toBe(true);
    expect(result.action).toBe("created");
    expect(result.entry?.status).toBe("unverified");
    expect(result.entry?.discovered_date).toBe("2026-10-24");
    // checked_date means "a human verified this"; a discovery has not been.
    expect(result.entry?.checked_date).toBeNull();
    expect(validateApisFile(file).valid).toBe(true);
  });

  it("refuses to let an agent mark its own research verified", () => {
    const result = proposeEntry(
      proposal({ status: "verified", promoted_date: "2026-10-24", promoted_by: "trust me" }),
      { file },
    );
    expect(result.entry?.status).toBe("unverified");
    expect(result.entry?.promoted_date ?? null).toBeNull();
    expect(result.entry?.promoted_by ?? null).toBeNull();
    expect(result.notes.join(" ")).toMatch(/forced to `unverified`/);
  });

  it("rejects a row with no source URL", () => {
    const result = proposeEntry(proposal({ source_urls: [] }), { file });
    expect(result.written).toBe(false);
    expect(result.action).toBe("rejected");
    expect(result.errors.join(" ")).toMatch(/at least one http\(s\) URL is required/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects a price with no URL behind it", () => {
    const result = proposeEntry(
      proposal({
        aggregators: [{ name: "monid", carries: true, per_call_price: 0.01, price_verified_url: null }],
      }),
      { file },
    );
    expect(result.written).toBe(false);
    expect(result.errors.join(" ")).toMatch(/never ship a price with no source/);
  });

  it("rejects a free-tier model with no description of the free tier", () => {
    const result = proposeEntry(
      proposal({
        billing: {
          model: "free_tier+payg",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
      }),
      { file },
    );
    expect(result.written).toBe(false);
    expect(result.errors.join(" ")).toMatch(/say what the free tier actually is/);
  });

  it("refuses to shadow a reviewed apis.yaml row, by name or by domain", () => {
    const reviewed = new Set(["example-apollo-contacts"]);
    const domains = new Set(["api.apollo.io"]);
    const byName = proposeEntry(proposal({ name: "example-apollo-contacts" }), {
      file,
      reservedNames: reviewed,
      reservedDomains: domains,
    });
    expect(byName.written).toBe(false);
    expect(byName.errors.join(" ")).toMatch(/already a reviewed row in apis\.yaml/);

    const byDomain = proposeEntry(proposal({ domain: "api.apollo.io" }), {
      file,
      reservedNames: reviewed,
      reservedDomains: domains,
    });
    expect(byDomain.written).toBe(false);
    expect(byDomain.errors.join(" ")).toMatch(/already covered by a reviewed row/);
  });

  it("replaces an earlier discovery of the same vendor instead of duplicating it", () => {
    proposeEntry(proposal(), { file });
    const again = proposeEntry(proposal({ auth_header: "X-Api-Key" }), { file });
    expect(again.action).toBe("updated");
    expect(again.notes.join(" ")).toMatch(/was replaced/);
    const stored = readUserIndex(file).document.entries;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.auth_header).toBe("X-Api-Key");
  });

  it("writes the file 0600 and puts no secret-looking field in it", () => {
    proposeEntry(proposal({ tos_notes: "nothing secret here" }), { file });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(file, "utf8");
    expect(body).not.toMatch(/sk-|secret:|token:|api_key:/i);
  });
});

describe("promotion (the only way a row becomes verified)", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = makeHome();
    file = path.join(home, "discovered.yaml");
    proposeEntry(proposal(), { file, today: "2026-10-24" });
  });
  afterEach(() => removeHome(home));

  it("leaves a row unverified with no ledger at all", () => {
    const result = promoteFromLedger({ file, home });
    expect(result.promoted).toEqual([]);
    expect(readUserIndex(file).document.entries[0]?.status).toBe("unverified");
  });

  it("leaves a row unverified when the only calls failed", () => {
    const ledger = openLedger(home);
    ledger.record({ alias: null, domain: "api.vendor.test", status: 401, bytes: 10 });
    ledger.record({ alias: null, domain: "api.vendor.test", status: 500, bytes: 10 });
    ledger.close();
    const result = promoteFromLedger({ file, home });
    expect(result.promoted).toEqual([]);
    expect(result.pending[0]?.why).toMatch(/no 2xx call to api\.vendor\.test/);
  });

  it("promotes on the first 2xx, and records which ledger row did it", () => {
    const ledger = openLedger(home);
    ledger.record({
      alias: "vendor-personal",
      domain: "api.vendor.test",
      status: 200,
      bytes: 512,
      timestamp: "2026-10-24T12:00:00.000Z",
    });
    ledger.close();
    const result = promoteFromLedger({ file, home, today: "2026-10-25" });
    expect(result.promoted).toHaveLength(1);
    const stored = readUserIndex(file).document.entries[0];
    expect(stored?.status).toBe("verified");
    expect(stored?.promoted_date).toBe("2026-10-25");
    expect(stored?.promoted_by).toBe("ledger: 200 from api.vendor.test at 2026-10-24T12:00:00.000Z");
    // Idempotent: a second pass neither re-promotes nor rewrites the date.
    const second = promoteFromLedger({ file, home, today: "2026-11-01" });
    expect(second.promoted).toEqual([]);
    expect(readUserIndex(file).document.entries[0]?.promoted_date).toBe("2026-10-25");
  });

  it("matches a subdomain the key covers, not just the exact host", () => {
    const ledger = openLedger(home);
    ledger.record({ alias: null, domain: "eu.api.vendor.test", status: 204, bytes: 0 });
    ledger.close();
    expect(promoteFromLedger({ file, home }).promoted).toHaveLength(1);
  });

  it("cannot promote a row with no domain, and says why", () => {
    const other = path.join(home, "nodomain.yaml");
    proposeEntry(proposal({ name: "no-domain", domain: undefined }), { file: other });
    const ledger = openLedger(home);
    ledger.record({ alias: null, domain: "api.vendor.test", status: 200, bytes: 1 });
    ledger.close();
    const result = promoteFromLedger({ file: other, home });
    expect(result.promoted).toEqual([]);
    expect(result.pending[0]?.why).toMatch(/no domain recorded/);
  });
});

describe("the user index inside the merged index", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = makeHome();
    file = path.join(home, "discovered.yaml");
  });
  afterEach(() => removeHome(home));

  it("is ignored when absent, and never breaks the merge", () => {
    const index = loadApiIndex({ apisFile: APIS_YAML, shardDirs: [], userIndexFile: file, home });
    expect(index.counts.user_index).toBe(0);
    expect(index.errors).toEqual([]);
  });

  it("adds discovered rows, tagged origin: user", () => {
    proposeEntry(proposal(), { file });
    const index = loadApiIndex({ apisFile: APIS_YAML, shardDirs: [], userIndexFile: file, home });
    expect(index.counts.user_index).toBe(1);
    const found = index.entries.find((entry) => entry.name === "demo-cve-api");
    expect(found?.origin).toBe("user");
    expect(found?.origin_file).toBe(file);
    expect(found?.status).toBe("unverified");
  });

  it("reports a broken user index instead of throwing, and still loads apis.yaml", () => {
    fs.writeFileSync(file, "entries: [not-a-mapping]\n");
    const index = loadApiIndex({ apisFile: APIS_YAML, shardDirs: [], userIndexFile: file, home });
    expect(index.counts.apis_yaml).toBeGreaterThan(0);
    expect(index.counts.user_index).toBe(0);
    expect(index.errors.join(" ")).toMatch(/expected a mapping|expected 1/);
  });

  it("lets apis.yaml win when a discovered row collides, and says so", () => {
    // Written straight to disk: propose_entry refuses this, the loader must too.
    fs.writeFileSync(
      file,
      "version: 1\nentries:\n  - name: example-apollo-contacts\n    url: https://evil.test\n" +
        "    access_mode: own-account\n    min_topup: null\n    billing_unit: null\n" +
        "    signup_automatable: null\n    tos_notes: null\n    source: null\n    checked_date: null\n",
    );
    const index = loadApiIndex({ apisFile: APIS_YAML, shardDirs: [], userIndexFile: file, home });
    const rows = index.entries.filter((entry) => entry.name === "example-apollo-contacts");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("apis.yaml");
    expect(index.errors.join(" ")).toMatch(/the reviewed row wins/);
  });

  it("can be switched off entirely with userIndexFile: null", () => {
    proposeEntry(proposal(), { file });
    const index = loadApiIndex({ apisFile: APIS_YAML, shardDirs: [], userIndexFile: null, home });
    expect(index.counts.user_index).toBe(0);
    expect(index.entries.some((entry) => entry.name === "demo-cve-api")).toBe(false);
  });
});

describe("the shipped seed of discovered rows", () => {
  it("validates, and ships both real discoveries as unverified", () => {
    const result = validateApisFile(SEED);
    expect(result.errors).toEqual([]);
    const entries = result.document?.entries ?? [];
    expect(entries.map((entry) => entry.name).sort()).toEqual(["abuseipdb-check", "nvd-cve-api"]);
    for (const entry of entries) {
      // A seed carries no proof: promotion belongs to the home that made the call.
      expect(entry.status, entry.name).toBe("unverified");
      expect(entry.promoted_date ?? null, entry.name).toBeNull();
      expect(entry.checked_date, entry.name).toBeNull();
      expect((entry.source_urls ?? []).length, entry.name).toBeGreaterThan(0);
      expect(entry.billing?.verified_url, entry.name).toBeTruthy();
      expect(entry.billing?.verified_date, entry.name).toBe("2026-10-24");
      expect(entry.auth_header, entry.name).toBeTruthy();
    }
  });

  it("records the header each vendor actually documents, not Bearer", () => {
    const byName = new Map(
      (validateApisFile(SEED).document?.entries ?? []).map((entry) => [entry.name, entry]),
    );
    expect(byName.get("nvd-cve-api")?.auth_header).toBe("apiKey");
    expect(byName.get("nvd-cve-api")?.auth_format).toBe("{key}");
    expect(byName.get("nvd-cve-api")?.billing?.model).toBe("free");
    expect(byName.get("abuseipdb-check")?.auth_header).toBe("Key");
    expect(byName.get("abuseipdb-check")?.billing?.model).toBe("free_tier+subscription");
    for (const entry of byName.values()) {
      expect(entry.auth_format, entry.name).not.toMatch(/Bearer/);
      // Neither vendor is carried by any aggregator, and none claims a price.
      for (const carrier of entry.aggregators ?? []) {
        expect(carrier.carries, `${entry.name}/${carrier.name}`).toBe(false);
        expect(carrier.per_call_price, `${entry.name}/${carrier.name}`).toBeNull();
      }
    }
  });
});

describe("the credential guard on propose_entry", () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = makeHome();
    file = path.join(home, "discovered.yaml");
  });
  afterEach(() => removeHome(home));

  it("spots the credential shapes that actually get pasted by accident", () => {
    const samples: [string, RegExp][] = [
      ["sk-test-abcdefghijklmnop", /sk-/],
      ["pk_live_abcdefgh12345678", /publishable/],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123", /GitHub/],
      ["xoxb-1234567890-abcdefghij", /Slack/],
      ["AIzaSyA1234567890abcdefghijklmnopqrs", /Google API/],
      ["AKIAIOSFODNN7EXAMPLE", /AWS/],
      ["hf_abcdefghijklmnopqrstuvwxyz12", /Hugging Face/],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", /JWT/],
      ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", /bearer token/],
    ];
    for (const [value, expected] of samples) {
      expect(looksLikeSecret(value), value).toMatch(expected);
    }
  });

  it("leaves the honest metadata an index is made of alone", () => {
    for (const value of [
      "Bearer {key}",
      "Authorization",
      "x-api-key",
      "apiKey",
      "The key goes in the `Key` header, per the vendor's docs.",
      "https://docs.vendor.test/reference/authentication",
      "$0.026 per call, verified 2026-10-24",
      "First 200 million tokens free for voyage-4-large",
    ]) {
      expect(looksLikeSecret(value), value).toBeNull();
    }
  });

  it("rejects the whole row and writes no file when a field holds a credential", () => {
    const result = proposeEntry(proposal({ tos_notes: "key: sk-live-0123456789abcdef" }), { file });
    expect(result.written).toBe(false);
    expect(result.errors[0]).toMatch(/^tos_notes: looks like/);
    expect(result.errors.join(" ")).toMatch(/a key belongs in the vault/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("finds a credential nested in a list or a sub-object", () => {
    const inList = proposeEntry(
      proposal({ human_steps: ["paste ghp_abcdefghijklmnopqrstuvwxyz0123 somewhere"] }),
      { file },
    );
    expect(inList.errors[0]).toMatch(/^human_steps\[0\]: looks like/);
    const nested = proposeEntry(
      proposal({
        billing: {
          model: "free",
          free_tier_note: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x",
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
      }),
      { file },
    );
    expect(nested.errors[0]).toMatch(/^billing\.free_tier_note: looks like/);
  });
});
