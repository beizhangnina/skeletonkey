/**
 * Discover-on-miss: what happens when `find_api` has never heard of the vendor
 * an agent needs.
 *
 * The agent researches the vendor with its own tools, writes what it found into
 * a **local user index** (never into the packaged `apis.yaml`) with
 * `status: unverified` and the URLs it read, and the row is promoted to
 * `verified` only after a real call through the proxy came back 2xx. Nothing in
 * here can mark a row verified on an agent's word.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  loadUserIndex,
  resolveUserIndexPath,
  validateApis,
  type ApiEntry,
  type ApisDocument,
} from "./apis.js";
import { ensureHome } from "./config.js";
import { normalizeDomain } from "./keys.js";
import { openLedger } from "./ledger.js";
import { skeletonKeyHome } from "./paths.js";

const HEADER = `# SkeletonKey local user index -- rows an agent discovered itself.
#
# Written by the MCP tool \`propose_entry\`, read by \`find_api\` alongside the
# packaged apis.yaml (which always wins on a name or domain clash). Contains NO
# secrets: only how an API is reached, how it authenticates, and how it bills.
#
# status: unverified  nothing here has been confirmed by a working call. The
#                     facts came off the pages listed in source_urls.
# status: verified    a call to this domain through the SkeletonKey proxy came
#                     back 2xx; promoted_by names the ledger row that did it.
#
# Prices obey the same rule as everywhere else: read off the vendor's own page
# with billing.verified_url set, or left null. Never guessed.
`;

/**
 * The research recipe `discover_api` hands back. Ordered by how much the source
 * can be trusted: the vendor's own pages first, third-party directories last.
 */
export const DISCOVERY_SOURCES = [
  {
    order: 1,
    source: "The vendor's own API docs",
    how:
      "Search for \"<vendor> API docs\" and open the vendor's own domain. Read the auth page: the " +
      "exact header NAME and value template, and the base URL. Record them verbatim -- a guessed " +
      "`Authorization: Bearer` fails as a vendor 401 that looks exactly like a bad key.",
    fills: ["auth_header", "auth_format", "base_url", "url", "source_urls"],
  },
  {
    order: 2,
    source: "The vendor's own pricing page",
    how:
      "Open the vendor's pricing page and read the billing model off it: is it pay-per-use, a " +
      "monthly plan, a free tier, or free outright? Copy the free allowance in the vendor's own " +
      "words. Set billing.verified_url to that page and billing.verified_date to today. If you " +
      "cannot find or load the page, leave billing.model null -- null is honest, a guess is not.",
    fills: ["billing.model", "billing.free_tier_note", "billing.verified_url", "billing.verified_date"],
  },
  {
    order: 3,
    source: "An OpenAPI / Swagger spec, if one is published",
    how:
      "Try the conventional locations on the API host: /openapi.json, /openapi.yaml, /swagger.json, " +
      "/.well-known/openapi.json, and any link from the docs. A spec pins the base URL and the " +
      "securityScheme (`in: header`, `name: <header>`) better than prose can. Record the spec URL " +
      "in source_urls; a 404 is itself worth noting.",
    fills: ["base_url", "auth_header", "source_urls"],
  },
  {
    order: 4,
    source: "APIs.guru",
    how:
      "Fetch https://api.apis.guru/v2/list.json and look the vendor up. When it is there you get a " +
      "machine-readable spec for free; when it is not, say so rather than treating absence as a " +
      "fact about the vendor. It indexes ~2,500 APIs, mostly large platforms.",
    fills: ["base_url", "auth_header", "source_urls"],
  },
  {
    order: 5,
    source: "The signup and key pages",
    how:
      "Find where signup actually STARTS (often not the docs root) and where the key is created. " +
      "Leave key_page_url null when that page is behind a login and its URL is not documented, and " +
      "put the click-path in human_steps instead.",
    fills: ["signup_url", "key_page_url", "human_steps", "requires_card", "requires_work_email"],
  },
  {
    order: 6,
    source: "The aggregator catalogs, for carriage",
    how:
      "Only if a direct account needs a subscription: check whether an aggregator resells the vendor " +
      "per call. Their public catalogs answer without a key -- " +
      "https://api.glasser.ai/public/catalog and " +
      "https://api.monid.ai/public/v1/endpoints?provider=<slug>. A price must come with the URL you " +
      "read it from (price_verified_url) or stay null.",
    fills: ["aggregators"],
  },
] as const;

/** The non-negotiables, repeated to the agent at discovery time. */
export const DISCOVERY_RULES = [
  "Write status: unverified. There is no way to write `verified` yourself: a row is promoted only " +
    "after a call to its domain through the proxy returns 2xx, and promoted_by then names that ledger row.",
  "Every fact needs a URL in source_urls, and every price needs billing.verified_url or " +
    "aggregators[].price_verified_url. No URL means the field stays null.",
  "null means nobody checked. It never means free, and it never means `Authorization: Bearer`.",
  "Do not write the vendor's marketing copy into free_tier_note -- write what its pricing page says " +
    "the free tier IS, with the numbers on it.",
  "Never put a key, token, or credential into any field -- record the header NAME and the template " +
    "(`Bearer {key}`), never a value. This is enforced: propose_entry rejects the whole row if any " +
    "field looks like a credential, and writes nothing.",
] as const;

/**
 * Credential shapes that must never reach a metadata file. Deliberately
 * conservative: these are vendor-documented key prefixes plus a long opaque
 * token, so an ordinary note about `Authorization` or a price is not caught.
 */
const SECRET_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /\bsk[-_][A-Za-z0-9_-]{8,}/, what: "an `sk-...` API key" },
  { pattern: /\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/, what: "a publishable/restricted key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, what: "a GitHub token" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: "a Slack token" },
  { pattern: /\bAIza[A-Za-z0-9_-]{20,}/, what: "a Google API key" },
  { pattern: /\bAKIA[A-Z0-9]{12,}/, what: "an AWS access key id" },
  { pattern: /\bya29\.[A-Za-z0-9_-]{20,}/, what: "a Google OAuth token" },
  { pattern: /\bhf_[A-Za-z0-9]{20,}/, what: "a Hugging Face token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: "a JWT" },
  { pattern: /\bBearer\s+(?!\{key\})[A-Za-z0-9._-]{20,}/, what: "a bearer token (use `Bearer {key}`)" },
];

/**
 * Looks for a credential in a proposed row. `propose_entry`'s own rules already
 * say never to put a key in any field; this is the enforcement, because an
 * index file is exactly the kind of place a careless paste lands and stays.
 */
export function looksLikeSecret(value: string): string | null {
  for (const { pattern, what } of SECRET_PATTERNS) {
    if (pattern.test(value)) return what;
  }
  return null;
}

function scanForSecrets(value: unknown, at: string, found: string[]): void {
  if (typeof value === "string") {
    const what = looksLikeSecret(value);
    if (what !== null) found.push(`${at}: looks like ${what}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${at}[${index}]`, found));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      scanForSecrets(item, `${at}.${key}`, found);
    }
  }
}

export function userIndexPath(home = skeletonKeyHome()): string {
  return resolveUserIndexPath(home);
}

/** Reads the user index as a document, tolerating a missing file. */
export function readUserIndex(file: string): { document: ApisDocument; errors: string[]; exists: boolean } {
  const loaded = loadUserIndex(file);
  return {
    document: { version: 1, entries: loaded.entries },
    errors: loaded.errors,
    exists: loaded.exists,
  };
}

export function writeUserIndex(file: string, document: ApisDocument): void {
  ensureHome(path.dirname(file));
  const body = YAML.stringify({
    version: 1,
    entries: [...document.entries].sort((a, b) => a.name.localeCompare(b.name)),
  });
  fs.writeFileSync(file, HEADER + body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export interface ProposeResult {
  written: boolean;
  file: string;
  /** "created" | "updated" | "rejected" */
  action: "created" | "updated" | "rejected";
  entry: ApiEntry | null;
  errors: string[];
  notes: string[];
}

/**
 * Validates a proposed row and writes it to the user index.
 *
 * `status` is forced to `unverified` whatever the caller passed: an agent
 * cannot vouch for its own research. A row whose name already exists is
 * updated in place (re-discovery with better facts is normal), but one that
 * collides with a reviewed `apis.yaml` row is rejected -- that row already
 * knows more.
 */
export function proposeEntry(
  input: Record<string, unknown>,
  options: { file: string; reservedNames?: Set<string>; reservedDomains?: Set<string>; today?: string },
): ProposeResult {
  const file = options.file;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const notes: string[] = [];

  const candidate: Record<string, unknown> = { ...input };
  // Provenance is set here, not by the caller.
  candidate["status"] = "unverified";
  if (input["status"] === "verified") {
    notes.push(
      "status was forced to `unverified`: verification is earned by a 2xx call through the proxy, " +
        "not asserted by the agent that wrote the row.",
    );
  }
  if (typeof candidate["discovered_date"] !== "string") candidate["discovered_date"] = today;
  delete candidate["promoted_date"];
  delete candidate["promoted_by"];
  for (const field of ["min_topup", "billing_unit", "signup_automatable", "tos_notes", "source", "checked_date"]) {
    if (!(field in candidate)) candidate[field] = null;
  }
  // checked_date means "a human verified this row"; a discovered row has not been.
  candidate["checked_date"] = null;

  // Refuse the write outright if anything in the row looks like a credential.
  // A metadata file is forever; a rejected tool call costs one retry.
  const secrets: string[] = [];
  for (const [field, value] of Object.entries(candidate)) {
    scanForSecrets(value, field, secrets);
  }
  if (secrets.length > 0) {
    return {
      written: false,
      file,
      action: "rejected",
      entry: null,
      errors: [
        ...secrets,
        "Nothing was written. This index is metadata only: a key belongs in the vault, entered by " +
          "the human via `register_key` or `skeletonkey add`. Record the header NAME and the " +
          "template (`Bearer {key}`), never a key value.",
      ],
      notes,
    };
  }

  const sources = candidate["source_urls"];
  if (!Array.isArray(sources) || sources.length === 0) {
    return {
      written: false,
      file,
      action: "rejected",
      entry: null,
      errors: ["source_urls: at least one http(s) URL is required -- an unsourced row is a guess"],
      notes,
    };
  }

  const name = typeof candidate["name"] === "string" ? candidate["name"].trim() : "";
  if (options.reservedNames?.has(name.toLowerCase()) === true) {
    return {
      written: false,
      file,
      action: "rejected",
      entry: null,
      errors: [
        `name: ${JSON.stringify(name)} is already a reviewed row in apis.yaml. Use that row ` +
          "(find_api will return it); it knows more than a fresh discovery does.",
      ],
      notes,
    };
  }
  const domain = typeof candidate["domain"] === "string" ? normalizeDomain(candidate["domain"]) : "";
  if (domain !== "" && options.reservedDomains?.has(domain) === true) {
    return {
      written: false,
      file,
      action: "rejected",
      entry: null,
      errors: [
        `domain: ${domain} is already covered by a reviewed row in apis.yaml. Use that row instead ` +
          "of shadowing it.",
      ],
      notes,
    };
  }

  const existing = readUserIndex(file);
  notes.push(...existing.errors);
  const entries = existing.document.entries.filter(
    (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
  );
  const replaced = entries.length !== existing.document.entries.length;
  if (replaced) {
    notes.push(`An earlier discovered row named ${JSON.stringify(name)} was replaced.`);
  }

  // Validate the whole document, so a bad row cannot land in a file that
  // `find_api` then has to report as broken.
  const result = validateApis({ version: 1, entries: [...entries, candidate] });
  if (!result.valid || result.document === null) {
    return { written: false, file, action: "rejected", entry: null, errors: result.errors, notes };
  }

  writeUserIndex(file, result.document);
  const stored = result.document.entries.find(
    (entry) => entry.name.toLowerCase() === name.toLowerCase(),
  );
  return {
    written: true,
    file,
    action: replaced ? "updated" : "created",
    entry: stored ?? null,
    errors: [],
    notes,
  };
}

export interface PromotionResult {
  promoted: { name: string; domain: string; promoted_by: string }[];
  /** Rows still unverified, with why they have not been promoted. */
  pending: { name: string; domain: string | null; why: string }[];
  file: string;
}

/**
 * Promotes every `unverified` row in the user index whose domain has a 2xx row
 * in the ledger. Cheap and idempotent: called before `find_api` and
 * `request_access` answer, so a row flips the moment the first real call works.
 */
export function promoteFromLedger(
  options: { file?: string; home?: string; today?: string } = {},
): PromotionResult {
  const home = options.home ?? skeletonKeyHome();
  const file = options.file ?? userIndexPath(home);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const existing = readUserIndex(file);
  if (!existing.exists) return { promoted: [], pending: [], file };

  let succeeded: Map<string, { status: number; timestamp: string; calls: number }>;
  try {
    const ledger = openLedger(home);
    try {
      succeeded = ledger.succeededDomains();
    } finally {
      ledger.close();
    }
  } catch {
    // No ledger yet (or an unreadable one) means nothing has been proven: leave
    // every row where it is rather than failing the caller's tool call.
    return { promoted: [], pending: [], file };
  }

  const promoted: PromotionResult["promoted"] = [];
  const pending: PromotionResult["pending"] = [];
  let changed = false;

  for (const entry of existing.document.entries) {
    if (entry.status !== "unverified") continue;
    const domain = entry.domain === undefined ? "" : normalizeDomain(entry.domain);
    if (domain === "") {
      pending.push({
        name: entry.name,
        domain: null,
        why: "no domain recorded, so no ledger row can ever match it",
      });
      continue;
    }
    const hit = [...succeeded.entries()].find(
      ([called]) => called === domain || called.endsWith(`.${domain}`) || domain.endsWith(`.${called}`),
    );
    if (hit === undefined) {
      pending.push({
        name: entry.name,
        domain,
        why: `no 2xx call to ${domain} in the ledger yet -- call it through the proxy first`,
      });
      continue;
    }
    const [calledDomain, record] = hit;
    entry.status = "verified";
    entry.promoted_date = today;
    entry.promoted_by = `ledger: ${record.status} from ${calledDomain} at ${record.timestamp}`;
    promoted.push({ name: entry.name, domain, promoted_by: entry.promoted_by });
    changed = true;
  }

  if (changed) writeUserIndex(file, existing.document);
  return { promoted, pending, file };
}
