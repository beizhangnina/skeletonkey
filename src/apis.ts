import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { skeletonKeyHome } from "./paths.js";

export {
  CAPABILITY_STOPWORDS,
  MATCH_WEIGHTS,
  matchesCapability,
  rankByCapability,
  scoreCapability,
  queryTokens,
  type CapabilityScore,
} from "./match.js";

export const ACCESS_MODES = ["intermediary", "own-account", "byok"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/**
 * How a vendor charges for direct access. Verified on the vendor's own pricing
 * page or left null -- there is no guessed value for this field.
 *
 *   payg                     pay per request/token, no subscription required
 *   subscription             a recurring plan is required before the API works
 *   free_tier+payg           a free allowance, then metered usage
 *   free_tier+subscription   a free plan, then a recurring plan for more
 *   free                     no paid tier exists at all (e.g. a public gov API)
 *
 * `free` is an extension beyond the five models the v0.2 brief named: forcing a
 * genuinely free API (NVD) into `free_tier+payg` would assert a paid tier that
 * does not exist, which is the same sin as guessing a price.
 */
export const BILLING_MODELS = [
  "payg",
  "subscription",
  "free_tier+payg",
  "free_tier+subscription",
  "free",
] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];

/** The three agent-tool aggregators the generated index was built from. */
export const AGGREGATOR_NAMES = ["monid", "glasser", "flatkey"] as const;
export type AggregatorName = (typeof AGGREGATOR_NAMES)[number];

/**
 * What the vendor charges, and where that was read. `verified_url` plus
 * `verified_date` is the whole point of this block: a billing model with no
 * verified_url is a claim nobody checked, and the router says so out loud.
 */
export interface BillingFacts {
  /** Null = nobody checked. Never inferred from a free-trial banner. */
  model: BillingModel | null;
  /** What the free allowance actually is, in the vendor's own words. */
  free_tier_note: string | null;
  /** The vendor's own page the model above was read from. */
  verified_url: string | null;
  /** ISO date that page was read. Null whenever verified_url is null. */
  verified_date: string | null;
  /**
   * Does the free tier include API access? Vendors routinely offer a free plan
   * whose API is paid-only (Apollo's own docs say API access "depends on your
   * plan"). null = nobody established it, and the router then refuses to treat
   * the free tier as a usable route.
   */
  free_tier_covers_api?: boolean | null;
}

/**
 * Whether one aggregator resells this provider, and at what published price.
 *
 * `per_call_price` is the LOWEST flat per-call (or per-run) price in USD the
 * aggregator publishes for this provider, excluding zero-priced endpoints. It
 * is null when the aggregator prices that provider per *result* or in tiers, so
 * no single per-call number exists -- null is "no comparable price published",
 * never "free". A non-null price requires `price_verified_url`.
 */
export interface AggregatorCarriage {
  name: AggregatorName;
  carries: boolean;
  per_call_price: number | null;
  price_verified_url: string | null;
  /** What the number means, or why it is null. */
  price_note?: string | null;
}

/** Lifecycle of a row discovered by an agent rather than written by a human. */
export const ENTRY_STATUSES = ["unverified", "verified"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export interface ApiEntry {
  name: string;
  /**
   * http(s) URL of the API or its docs. Required in `apis.yaml`; null is only
   * reachable for a generated index shard that never resolved a vendor URL.
   */
  url: string | null;
  /** Null only for an index shard row whose access path was never determined. */
  access_mode: AccessMode | null;
  /** Minimum top-up in USD, or null when unknown. Never guess a price. */
  min_topup: number | null;
  /** e.g. "per 1M input tokens", "per request". Null when unknown. */
  billing_unit: string | null;
  signup_automatable: boolean | null;
  tos_notes: string | null;
  /** Where the facts above came from. */
  source: string | null;
  /** ISO date (YYYY-MM-DD) the entry was last verified, or null if unverified. */
  checked_date: string | null;
  /** True for illustrative placeholder rows shipped with the repo. */
  example?: boolean;
  /** Free-text capability tags matched by the MCP `find_api` tool. */
  capabilities?: string[];
  /** API hostname, so `skeletonkey add --domain` can be suggested automatically. */
  domain?: string;

  // --- auth facts, so an agent never has to guess how to authenticate -------
  // All of these are optional and null-when-unknown. A null is "nobody checked",
  // never "none needed" -- the same rule min_topup follows.

  /** Header the vendor documents for the key, e.g. `Authorization`, `x-api-key`. */
  auth_header?: string | null;
  /** Header value template containing `{key}`, e.g. `Bearer {key}` or `{key}`. */
  auth_format?: string | null;
  /** Base URL requests go to, e.g. `https://api.apollo.io/api/v1`. */
  base_url?: string | null;
  /** Where signup actually starts. Often NOT the docs root in `url`. */
  signup_url?: string | null;
  /** Page in the vendor's dashboard where the key is created or copied. */
  key_page_url?: string | null;
  /** True when an email address alone completes signup: no card, no phone. */
  email_only_signup?: boolean | null;
  /** True when the vendor requires a saved payment card. */
  requires_card?: boolean | null;
  /** True when the vendor requires phone/SMS verification. */
  requires_phone?: boolean | null;
  /** True when the vendor requires a work email (so a `+alias` may be refused). */
  requires_work_email?: boolean | null;
  /** Steps only a human can do, in the vendor's own terms. */
  human_steps?: string[] | null;

  // --- billing + routing ----------------------------------------------------

  /** How the vendor charges, and the vendor page it was verified on. */
  billing?: BillingFacts | null;
  /** Which aggregators resell this provider, and their published prices. */
  aggregators?: AggregatorCarriage[] | null;

  // --- discover-on-miss provenance -----------------------------------------

  /**
   * Set only on rows an agent discovered: `unverified` on write, promoted to
   * `verified` after a 2xx call through the proxy. Hand-maintained rows leave
   * it undefined -- their provenance is `checked_date`.
   */
  status?: EntryStatus | null;
  /** Every page the discovered facts were read from. */
  source_urls?: string[] | null;
  /** ISO date the row was discovered. */
  discovered_date?: string | null;
  /** ISO date the row was promoted to `verified`. */
  promoted_date?: string | null;
  /** What promoted it, e.g. "ledger: 200 from api.example.com at <ts>". */
  promoted_by?: string | null;
}

export interface ApisDocument {
  version: 1;
  entries: ApiEntry[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  document: ApisDocument | null;
}

const REQUIRED_FIELDS = [
  "name",
  "url",
  "access_mode",
  "min_topup",
  "billing_unit",
  "signup_automatable",
  "tos_notes",
  "source",
  "checked_date",
] as const;

const OPTIONAL_FIELDS = [
  "example",
  "capabilities",
  "domain",
  "auth_header",
  "auth_format",
  "base_url",
  "signup_url",
  "key_page_url",
  "email_only_signup",
  "requires_card",
  "requires_phone",
  "requires_work_email",
  "human_steps",
  "billing",
  "aggregators",
  "status",
  "source_urls",
  "discovered_date",
  "promoted_date",
  "promoted_by",
] as const;

/** Optional auth URLs, all validated the same way: an http(s) URL or null. */
const URL_FIELDS = ["base_url", "signup_url", "key_page_url"] as const;

/** Optional tri-state gates: true, false, or null for "nobody checked". */
const FLAG_FIELDS = [
  "email_only_signup",
  "requires_card",
  "requires_phone",
  "requires_work_email",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateApis(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["root: expected a mapping"], document: null };
  }
  const root = input as Record<string, unknown>;
  if (root["version"] !== 1) errors.push("root.version: expected 1");
  if (!Array.isArray(root["entries"])) {
    errors.push("root.entries: expected a list");
    return { valid: false, errors, document: null };
  }

  const entries: ApiEntry[] = [];
  const seen = new Set<string>();
  (root["entries"] as unknown[]).forEach((raw, index) => {
    const at = `entries[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${at}: expected a mapping`);
      return;
    }
    const entry = raw as Record<string, unknown>;

    const known = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
    for (const field of Object.keys(entry)) {
      if (!known.has(field)) errors.push(`${at}.${field}: unknown field`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) errors.push(`${at}.${field}: missing (use null if unknown)`);
    }

    const name = entry["name"];
    if (typeof name !== "string" || name.trim() === "") {
      errors.push(`${at}.name: expected a non-empty string`);
    } else if (seen.has(name)) {
      errors.push(`${at}.name: duplicate entry ${JSON.stringify(name)}`);
    } else {
      seen.add(name);
    }

    const url = entry["url"];
    if (typeof url !== "string" || !isHttpUrl(url)) {
      errors.push(`${at}.url: expected an http(s) URL`);
    }

    const mode = entry["access_mode"];
    if (typeof mode !== "string" || !(ACCESS_MODES as readonly string[]).includes(mode)) {
      errors.push(`${at}.access_mode: expected one of ${ACCESS_MODES.join(" | ")}`);
    }

    const minTopup = entry["min_topup"];
    if (minTopup !== null && minTopup !== undefined) {
      if (typeof minTopup !== "number" || !Number.isFinite(minTopup) || minTopup < 0) {
        errors.push(`${at}.min_topup: expected a non-negative number or null`);
      }
    }

    requireStringOrNull(errors, at, "billing_unit", entry["billing_unit"]);
    requireStringOrNull(errors, at, "tos_notes", entry["tos_notes"]);

    const source = entry["source"];
    if (source !== null && source !== undefined && !(typeof source === "string" && isHttpUrl(source))) {
      errors.push(`${at}.source: expected an http(s) URL or null`);
    }

    const automatable = entry["signup_automatable"];
    if (automatable !== null && automatable !== undefined && typeof automatable !== "boolean") {
      errors.push(`${at}.signup_automatable: expected a boolean or null`);
    }

    const checked = entry["checked_date"];
    if (checked !== null && checked !== undefined) {
      if (typeof checked !== "string" || !DATE_RE.test(checked) || Number.isNaN(Date.parse(checked))) {
        errors.push(`${at}.checked_date: expected an ISO date (YYYY-MM-DD) or null`);
      }
    }

    const example = entry["example"];
    if (example !== undefined && typeof example !== "boolean") {
      errors.push(`${at}.example: expected a boolean`);
    }

    const capabilities = entry["capabilities"];
    if (capabilities !== undefined) {
      if (
        !Array.isArray(capabilities) ||
        capabilities.some((item) => typeof item !== "string" || item.trim() === "")
      ) {
        errors.push(`${at}.capabilities: expected a list of non-empty strings`);
      }
    }

    const domain = entry["domain"];
    if (domain !== undefined && (typeof domain !== "string" || domain.trim() === "")) {
      errors.push(`${at}.domain: expected a non-empty hostname string`);
    }

    const authHeader = entry["auth_header"];
    if (authHeader !== null && authHeader !== undefined) {
      if (typeof authHeader !== "string" || authHeader.trim() === "") {
        errors.push(`${at}.auth_header: expected a non-empty header name or null`);
      } else if (/[\s:]/.test(authHeader)) {
        errors.push(`${at}.auth_header: expected a header name only, with no colon or spaces`);
      }
    }

    const authFormat = entry["auth_format"];
    if (authFormat !== null && authFormat !== undefined) {
      if (typeof authFormat !== "string" || authFormat.trim() === "") {
        errors.push(`${at}.auth_format: expected a non-empty template or null`);
      } else if (!authFormat.includes("{key}")) {
        errors.push(`${at}.auth_format: must contain the {key} placeholder`);
      }
    }
    if (authFormat !== null && authFormat !== undefined && (authHeader === null || authHeader === undefined)) {
      errors.push(`${at}.auth_header: required when auth_format is set (which header holds it?)`);
    }

    for (const field of URL_FIELDS) {
      const value = entry[field];
      if (value !== null && value !== undefined && !(typeof value === "string" && isHttpUrl(value))) {
        errors.push(`${at}.${field}: expected an http(s) URL or null`);
      }
    }

    for (const field of FLAG_FIELDS) {
      const value = entry[field];
      if (value !== null && value !== undefined && typeof value !== "boolean") {
        errors.push(`${at}.${field}: expected a boolean or null`);
      }
    }

    // "Email alone is enough" cannot be true while a card or a phone is required.
    if (entry["email_only_signup"] === true) {
      for (const field of ["requires_card", "requires_phone"] as const) {
        if (entry[field] === true) {
          errors.push(`${at}.email_only_signup: contradicts ${field}: true`);
        }
      }
    }

    validateBilling(errors, at, entry["billing"]);
    validateAggregators(errors, at, entry["aggregators"]);
    validateDiscovery(errors, at, entry);

    const humanSteps = entry["human_steps"];
    if (humanSteps !== null && humanSteps !== undefined) {
      if (
        !Array.isArray(humanSteps) ||
        humanSteps.some((item) => typeof item !== "string" || item.trim() === "")
      ) {
        errors.push(`${at}.human_steps: expected a list of non-empty strings or null`);
      }
    }

    if (errors.length === 0 || errorsFor(errors, at).length === 0) {
      entries.push({
        name: name as string,
        url: url as string,
        access_mode: mode as AccessMode,
        min_topup: typeof minTopup === "number" ? minTopup : null,
        billing_unit: typeof entry["billing_unit"] === "string" ? (entry["billing_unit"] as string) : null,
        signup_automatable: typeof automatable === "boolean" ? automatable : null,
        tos_notes: typeof entry["tos_notes"] === "string" ? (entry["tos_notes"] as string) : null,
        source: typeof source === "string" ? source : null,
        checked_date: typeof checked === "string" ? checked : null,
        ...(typeof example === "boolean" ? { example } : {}),
        ...(Array.isArray(capabilities) ? { capabilities: capabilities as string[] } : {}),
        ...(typeof domain === "string" ? { domain } : {}),
        ...optionalAuthFields(entry),
        ...optionalIndexFields(entry),
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    document: errors.length === 0 ? { version: 1, entries } : null,
  };
}

/** The apis.yaml shipped inside the package. */
export function packagedApisPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "apis.yaml");
}

/**
 * Which apis.yaml to read: `SKELETONKEY_APIS` wins, then a user-maintained copy in
 * SKELETONKEY_HOME, then the one shipped with the package.
 */
export function resolveApisPath(home = skeletonKeyHome()): string {
  const override = process.env.SKELETONKEY_APIS;
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  const local = path.join(home, "apis.yaml");
  if (fs.existsSync(local)) return local;
  return packagedApisPath();
}

export function validateApisFile(file: string): ValidationResult {
  if (!fs.existsSync(file)) {
    return { valid: false, errors: [`${file}: file not found`], document: null };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, errors: [`${file}: invalid YAML -- ${message}`], document: null };
  }
  return validateApis(parsed);
}

function requireStringOrNull(
  errors: string[],
  at: string,
  field: string,
  value: unknown,
): void {
  if (value !== null && value !== undefined && typeof value !== "string") {
    errors.push(`${at}.${field}: expected a string or null`);
  }
}

function errorsFor(errors: string[], at: string): string[] {
  return errors.filter((error) => error.startsWith(`${at}.`) || error === `${at}: expected a mapping`);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates a `billing:` block. The rules all exist to stop an unverified
 * claim from reading like a verified one:
 *   - `model` must be one of BILLING_MODELS, or null for "nobody checked".
 *   - a model naming a free tier must say what the free tier IS.
 *   - `verified_date` without `verified_url` is unverifiable, and vice versa.
 */
function validateBilling(errors: string[], at: string, value: unknown): void {
  if (value === null || value === undefined) return;
  const field = `${at}.billing`;
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field}: expected a mapping or null`);
    return;
  }
  const raw = value as Record<string, unknown>;
  const known = new Set([
    "model",
    "free_tier_note",
    "verified_url",
    "verified_date",
    "free_tier_covers_api",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${field}.${key}: unknown field`);
  }
  if (!("model" in raw)) {
    errors.push(`${field}.model: missing (use null if nobody checked)`);
  }
  const model = raw["model"];
  if (model !== null && model !== undefined) {
    if (typeof model !== "string" || !(BILLING_MODELS as readonly string[]).includes(model)) {
      errors.push(`${field}.model: expected one of ${BILLING_MODELS.join(" | ")} or null`);
    } else if (model.startsWith("free_tier") && typeof raw["free_tier_note"] !== "string") {
      errors.push(
        `${field}.free_tier_note: required when model is ${model} -- say what the free tier actually is`,
      );
    }
  }
  requireStringOrNull(errors, field, "free_tier_note", raw["free_tier_note"]);

  const verifiedUrl = raw["verified_url"];
  if (
    verifiedUrl !== null &&
    verifiedUrl !== undefined &&
    !(typeof verifiedUrl === "string" && isHttpUrl(verifiedUrl))
  ) {
    errors.push(`${field}.verified_url: expected an http(s) URL or null`);
  }
  const date = raw["verified_date"];
  if (date !== null && date !== undefined) {
    if (typeof date !== "string" || !DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
      errors.push(`${field}.verified_date: expected an ISO date (YYYY-MM-DD) or null`);
    } else if (typeof raw["verified_url"] !== "string") {
      errors.push(`${field}.verified_url: required when verified_date is set (verified where?)`);
    }
  } else if (typeof raw["verified_url"] === "string") {
    errors.push(`${field}.verified_date: required when verified_url is set (verified when?)`);
  }
  const covers = raw["free_tier_covers_api"];
  if (covers !== null && covers !== undefined && typeof covers !== "boolean") {
    errors.push(`${field}.free_tier_covers_api: expected a boolean or null`);
  }
}

/**
 * Validates `aggregators:`. The load-bearing rule is the last one: a price with
 * no `price_verified_url` is exactly the invented number this repo refuses to
 * ship, so it is rejected rather than quietly nulled.
 */
function validateAggregators(errors: string[], at: string, value: unknown): void {
  if (value === null || value === undefined) return;
  const field = `${at}.aggregators`;
  if (!Array.isArray(value)) {
    errors.push(`${field}: expected a list or null`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const row = `${field}[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${row}: expected a mapping`);
      return;
    }
    const item = raw as Record<string, unknown>;
    const known = new Set([
      "name",
      "carries",
      "per_call_price",
      "price_verified_url",
      "price_note",
    ]);
    for (const key of Object.keys(item)) {
      if (!known.has(key)) errors.push(`${row}.${key}: unknown field`);
    }
    const name = item["name"];
    if (typeof name !== "string" || !(AGGREGATOR_NAMES as readonly string[]).includes(name)) {
      errors.push(`${row}.name: expected one of ${AGGREGATOR_NAMES.join(" | ")}`);
    } else if (seen.has(name)) {
      errors.push(`${row}.name: duplicate aggregator ${JSON.stringify(name)}`);
    } else {
      seen.add(name);
    }
    if (typeof item["carries"] !== "boolean") {
      errors.push(`${row}.carries: expected a boolean`);
    }
    const price = item["per_call_price"];
    if (price !== null && price !== undefined) {
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
        errors.push(`${row}.per_call_price: expected a non-negative number or null`);
      }
      if (item["carries"] === false) {
        errors.push(`${row}.per_call_price: must be null when carries is false`);
      }
      if (typeof item["price_verified_url"] !== "string") {
        errors.push(
          `${row}.price_verified_url: required when per_call_price is set -- never ship a price with no source`,
        );
      }
    }
    const url = item["price_verified_url"];
    if (url !== null && url !== undefined && !(typeof url === "string" && isHttpUrl(url))) {
      errors.push(`${row}.price_verified_url: expected an http(s) URL or null`);
    }
    requireStringOrNull(errors, row, "price_note", item["price_note"]);
  });
}

/** Validates the discover-on-miss provenance fields. */
function validateDiscovery(errors: string[], at: string, entry: Record<string, unknown>): void {
  const status = entry["status"];
  if (status !== null && status !== undefined) {
    if (typeof status !== "string" || !(ENTRY_STATUSES as readonly string[]).includes(status)) {
      errors.push(`${at}.status: expected one of ${ENTRY_STATUSES.join(" | ")} or null`);
    }
  }
  const sources = entry["source_urls"];
  if (sources !== null && sources !== undefined) {
    if (!Array.isArray(sources) || sources.some((item) => typeof item !== "string" || !isHttpUrl(item))) {
      errors.push(`${at}.source_urls: expected a list of http(s) URLs or null`);
    }
  }
  for (const field of ["discovered_date", "promoted_date"] as const) {
    const date = entry[field];
    if (date !== null && date !== undefined) {
      if (typeof date !== "string" || !DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
        errors.push(`${at}.${field}: expected an ISO date (YYYY-MM-DD) or null`);
      }
    }
  }
  requireStringOrNull(errors, at, "promoted_by", entry["promoted_by"]);
  // A row cannot claim promotion without saying what promoted it: promotion is
  // only ever earned by a 2xx row in the ledger.
  if (typeof entry["promoted_date"] === "string" && typeof entry["promoted_by"] !== "string") {
    errors.push(`${at}.promoted_by: required when promoted_date is set (promoted by what?)`);
  }
}

/**
 * Copies billing, aggregator carriage, and discovery provenance onto a
 * validated entry, normalising "absent" (undefined) and "unknown" (null) the
 * same way the auth fields do.
 */
function optionalIndexFields(entry: Record<string, unknown>): Partial<ApiEntry> {
  const out: Record<string, unknown> = {};
  if ("billing" in entry) {
    const raw = entry["billing"];
    out["billing"] =
      raw === null || typeof raw !== "object" || Array.isArray(raw)
        ? null
        : billingFacts(raw as Record<string, unknown>);
  }
  if ("aggregators" in entry) {
    const raw = entry["aggregators"];
    out["aggregators"] = Array.isArray(raw)
      ? raw.map((item) => carriage(item as Record<string, unknown>))
      : null;
  }
  if ("status" in entry) {
    out["status"] = typeof entry["status"] === "string" ? entry["status"] : null;
  }
  if ("source_urls" in entry) {
    out["source_urls"] = Array.isArray(entry["source_urls"]) ? entry["source_urls"] : null;
  }
  for (const field of ["discovered_date", "promoted_date", "promoted_by"] as const) {
    if (field in entry) out[field] = typeof entry[field] === "string" ? entry[field] : null;
  }
  return out as Partial<ApiEntry>;
}

function billingFacts(raw: Record<string, unknown>): BillingFacts {
  const text = (field: string): string | null =>
    typeof raw[field] === "string" ? (raw[field] as string) : null;
  const flag = (field: string): boolean | null =>
    typeof raw[field] === "boolean" ? (raw[field] as boolean) : null;
  return {
    model: (text("model") as BillingModel | null) ?? null,
    free_tier_note: text("free_tier_note"),
    verified_url: text("verified_url"),
    verified_date: text("verified_date"),
    free_tier_covers_api: flag("free_tier_covers_api"),
  };
}

function carriage(raw: Record<string, unknown>): AggregatorCarriage {
  return {
    name: raw["name"] as AggregatorName,
    carries: raw["carries"] === true,
    per_call_price: typeof raw["per_call_price"] === "number" ? raw["per_call_price"] : null,
    price_verified_url:
      typeof raw["price_verified_url"] === "string" ? (raw["price_verified_url"] as string) : null,
    price_note: typeof raw["price_note"] === "string" ? (raw["price_note"] as string) : null,
  };
}

/**
 * Copies the optional auth fields onto a validated entry, omitting the ones the
 * file never mentioned (so `undefined` = absent, `null` = explicitly unknown).
 */
function optionalAuthFields(entry: Record<string, unknown>): Partial<ApiEntry> {
  const out: Record<string, unknown> = {};
  for (const field of ["auth_header", "auth_format", ...URL_FIELDS] as const) {
    if (field in entry) out[field] = typeof entry[field] === "string" ? entry[field] : null;
  }
  for (const field of FLAG_FIELDS) {
    if (field in entry) out[field] = typeof entry[field] === "boolean" ? entry[field] : null;
  }
  if ("human_steps" in entry) {
    out["human_steps"] = Array.isArray(entry["human_steps"]) ? entry["human_steps"] : null;
  }
  return out as Partial<ApiEntry>;
}

// --- the merged index: apis.yaml + the generated data/apis/*.yaml shards ----

export type IndexOrigin = "apis.yaml" | "user" | "shard";

/** An index row plus where it came from. Agents are told the difference. */
export interface IndexEntry extends ApiEntry {
  origin: IndexOrigin;
  /** Absolute path of the file this row was read from. */
  origin_file: string;
  /** Shard category (`people-company-data`), when `origin` is "shard". */
  category?: string;
  /**
   * The shard's `provider_url` (the vendor's homepage). Kept because `url`
   * prefers the docs URL, and because both hosts are used to recognise a vendor
   * that `apis.yaml` already covers.
   */
  vendor_url?: string | null;
  /**
   * Where `aggregators` came from when the row did not declare it: the shard
   * row for the same vendor that this row displaced in the merge.
   */
  aggregators_source?: string;
}

export interface ApiIndex {
  entries: IndexEntry[];
  /** Files actually read, apis.yaml first. */
  files: string[];
  errors: string[];
  counts: {
    apis_yaml: number;
    /** Rows from the local user index written by `propose_entry`. */
    user_index: number;
    shards: number;
    /** Shard rows dropped because a hand-written row already covers that vendor. */
    merged_duplicates: number;
    total: number;
  };
}

/** Suffixes where the registrable name is the third label from the right. */
const TWO_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "com.br",
  "com.cn",
  "com.mx",
  "com.tr",
  "co.jp",
  "co.kr",
  "co.in",
  "co.nz",
  "co.za",
]);

/**
 * `www.apollo.io` and `api.apollo.io` reduce to `apollo.io`, so a hand-written
 * apis.yaml row and a generated shard row for the same vendor can be recognised
 * as the same vendor. Returns "" for anything that is not a dotted hostname
 * (an IP literal, a single label) rather than guessing.
 */
export function registrableDomain(input: string): string {
  let host = input.trim().toLowerCase();
  if (host === "") return "";
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  host = host.replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "";
  const labels = host.split(".").filter((label) => label !== "");
  if (labels.length < 2) return "";
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** The generated provider shards shipped inside the package. */
export function packagedShardDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "data", "apis");
}

/**
 * Which shard directories `find_api` reads, in precedence order: a
 * `SKELETONKEY_API_SHARDS` override (path-separator list, or the literal `none`
 * to switch shards off), else a user-maintained `apis.d/` in SKELETONKEY_HOME,
 * then the shards shipped with the package.
 */
export function resolveShardDirs(home = skeletonKeyHome()): string[] {
  const override = process.env.SKELETONKEY_API_SHARDS;
  if (override !== undefined && override.trim() !== "") {
    if (override.trim().toLowerCase() === "none") return [];
    return override
      .split(path.delimiter)
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => path.resolve(part));
  }
  const dirs: string[] = [];
  const local = path.join(home, "apis.d");
  if (fs.existsSync(local)) dirs.push(local);
  const packaged = packagedShardDir();
  if (fs.existsSync(packaged)) dirs.push(packaged);
  return dirs;
}

function shardDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && DATE_RE.test(value.trim())) return value.trim();
  return null;
}

function shardUrl(value: unknown): string | null {
  return typeof value === "string" && isHttpUrl(value) ? value : null;
}

/**
 * Converts one row of a generated shard into an index entry.
 *
 * The shards are a different shape (`id`, `capability`, `provider_url`,
 * `auth_type`, string tri-states) and a different provenance: machine-generated
 * from three aggregator catalogs, with prices and free tiers deliberately null.
 * Nothing is invented here -- "unknown" becomes `null`, and no auth header is
 * synthesised from `auth_type` because `api_key` does not say *which* header.
 */
function shardEntry(raw: unknown, file: string): { entry?: IndexEntry; error?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${file}: expected a mapping in apis[]` };
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row["id"] === "string" ? row["id"].trim() : "";
  if (id === "") return { error: `${file}: an apis[] row has no id` };

  const displayName = typeof row["name"] === "string" ? row["name"].trim() : "";
  const capability = typeof row["capability"] === "string" ? row["capability"].trim() : "";
  const category = typeof row["category"] === "string" ? row["category"].trim() : "";
  const mode = typeof row["access_mode"] === "string" ? row["access_mode"] : "";
  const automatable = typeof row["signup_automatable"] === "string" ? row["signup_automatable"] : "";
  const authType = typeof row["auth_type"] === "string" ? row["auth_type"] : "";

  const capabilities = [displayName, category.replace(/[-_]+/g, " "), capability].filter(
    (text) => text !== "",
  );

  // Carriage comes straight out of the catalog scrape: `seen_in` is the list of
  // aggregator catalogs this provider was found in, so a name missing from it is
  // a verified negative as of the shard's checked_date -- not an unknown. No
  // price is carried: the shards deliberately record none, and the aggregators'
  // own resale prices have to be read off their own catalogs (see
  // `price_verified_url`).
  const seenIn = Array.isArray(row["seen_in"])
    ? (row["seen_in"] as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const aggregators: AggregatorCarriage[] = AGGREGATOR_NAMES.map((name) => ({
    name,
    carries: seenIn.includes(name),
    per_call_price: null,
    price_verified_url: null,
    price_note: seenIn.includes(name)
      ? `Carriage from the generated index (seen_in). ${name} publishes its own resale price; ` +
        "nobody has read it, so per_call_price is null (unknown, not free)."
      : null,
  }));

  // The only thing auth_type is allowed to produce is a warning for a human:
  // an OAuth vendor may have no static header for the proxy to inject at all.
  const humanSteps =
    authType === "oauth"
      ? [
          `The index records OAuth for ${displayName === "" ? id : displayName}, not a static ` +
            "API key: complete the OAuth consent yourself and check whether a long-lived token " +
            "exists that the proxy could inject.",
        ]
      : [];

  return {
    entry: {
      name: id,
      url: shardUrl(row["docs_url"]) ?? shardUrl(row["provider_url"]),
      access_mode: (ACCESS_MODES as readonly string[]).includes(mode) ? (mode as AccessMode) : null,
      min_topup: typeof row["min_topup"] === "number" ? row["min_topup"] : null,
      billing_unit: typeof row["billing_unit"] === "string" ? row["billing_unit"] : null,
      signup_automatable: automatable === "yes" ? true : automatable === "no" ? false : null,
      tos_notes: typeof row["tos_notes"] === "string" ? row["tos_notes"] : null,
      source: shardUrl(row["source_url"]),
      checked_date: shardDate(row["checked_date"]),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      // No `domain`: the shards record the vendor's homepage and docs host, not
      // the API host a key would be registered for. Guessing one would send a
      // key to the wrong place.
      auth_header: null,
      auth_format: null,
      base_url: null,
      signup_url: null,
      key_page_url: null,
      email_only_signup: null,
      requires_card: null,
      requires_phone: null,
      requires_work_email: null,
      human_steps: humanSteps,
      // The shards record `free_tier: null` on every row by design, so there is
      // no verified billing model to report -- only the carriage above.
      billing: null,
      aggregators,
      vendor_url: shardUrl(row["provider_url"]),
      origin: "shard",
      origin_file: file,
      ...(category === "" ? {} : { category }),
    },
  };
}

/** Reads one generated shard file. Never throws: bad files become errors. */
export function readShardFile(file: string): { entries: IndexEntry[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entries: [], errors: [`${file}: invalid YAML -- ${message}`] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { entries: [], errors: [`${file}: expected a mapping with an apis: list`] };
  }
  const list = (parsed as Record<string, unknown>)["apis"];
  if (!Array.isArray(list)) {
    return { entries: [], errors: [`${file}: expected an apis: list`] };
  }
  const entries: IndexEntry[] = [];
  const errors: string[] = [];
  for (const raw of list) {
    const { entry, error } = shardEntry(raw, file);
    if (entry !== undefined) entries.push(entry);
    if (error !== undefined) errors.push(error);
  }
  return { entries, errors };
}

/** Every `*.yaml` in a shard directory, sorted so the merge is deterministic. */
export function shardFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * The local user index: rows an agent discovered itself with `discover_api` /
 * `propose_entry`, kept apart from the packaged `apis.yaml` so a shipped file is
 * never rewritten and a discovered row is never mistaken for a reviewed one.
 *
 * `SKELETONKEY_DISCOVERED` overrides the location (tests use it); the default
 * sits next to the vault metadata, inside SKELETONKEY_HOME.
 */
export function resolveUserIndexPath(home = skeletonKeyHome()): string {
  const override = process.env.SKELETONKEY_DISCOVERED;
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return path.join(home, "discovered.yaml");
}

/**
 * Reads the user index. A missing file is not an error -- most homes never have
 * one. A malformed one is reported, never thrown, so one bad row cannot take
 * `find_api` down.
 */
export function loadUserIndex(file: string): { entries: ApiEntry[]; errors: string[]; exists: boolean } {
  if (!fs.existsSync(file)) return { entries: [], errors: [], exists: false };
  const result = validateApisFile(file);
  return {
    entries: result.document?.entries ?? [],
    errors: result.errors.map((error) => (error.startsWith(file) ? error : `${file}: ${error}`)),
    exists: true,
  };
}

/**
 * The index `find_api` and `request_access` search: the hand-maintained
 * `apis.yaml` merged with every generated `data/apis/*.yaml` shard.
 *
 * `apis.yaml` wins. A shard row is dropped when apis.yaml already has a row
 * with the same name or the same registrable domain, so the richer hand-written
 * row (the one that knows the auth header) is the one an agent sees. Shard rows
 * are deduped against each other by id only -- two providers may legitimately
 * share a registrable domain.
 */
export interface LoadApiIndexOptions {
  apisFile?: string;
  home?: string;
  shardDirs?: string[];
  /** Path to the local user index, or `null` to ignore it entirely. */
  userIndexFile?: string | null;
  /** Bypass the parse cache (and refill it). Mostly for tests. */
  noCache?: boolean;
}

/** Which files an index is built from, with every path already resolved. */
interface ResolvedIndexSources {
  apisFile: string;
  userFile: string | null;
  shardDirs: string[];
}

export function loadApiIndex(options: LoadApiIndexOptions = {}): ApiIndex {
  const home = options.home ?? skeletonKeyHome();
  const sources: ResolvedIndexSources = {
    apisFile: options.apisFile ?? resolveApisPath(home),
    userFile:
      options.userIndexFile === null
        ? null
        : options.userIndexFile ?? resolveUserIndexPath(home),
    shardDirs: options.shardDirs ?? resolveShardDirs(home),
  };
  return cachedApiIndex(sources, options.noCache === true);
}

/**
 * Parse cache.
 *
 * Building the index parses `apis.yaml`, ~25 generated shards and the user
 * index: roughly 180 rows of YAML. Every MCP tool call did that from scratch,
 * several times per agent turn. The cache is keyed by the resolved file list
 * plus each file's mtime and size, so an edit (or a `propose_entry` write) is
 * picked up on the very next call without anyone having to invalidate anything.
 *
 * The cached `ApiIndex` is shared, so treat it as read-only.
 */
interface CacheRecord {
  signature: string;
  index: ApiIndex;
}

const indexCache = new Map<string, CacheRecord>();

/** Plenty for one process: a home, a test fixture, and an explicit override. */
const INDEX_CACHE_LIMIT = 16;

/** Counters a test (or a curious human) can read to prove nothing reparsed. */
export const apiIndexCacheStats = { hits: 0, misses: 0 };

/** Drops every cached index. Tests call this; nothing else needs to. */
export function clearApiIndexCache(): void {
  indexCache.clear();
  apiIndexCacheStats.hits = 0;
  apiIndexCacheStats.misses = 0;
}

/** `path:mtimeMs:size`, or `path:-` when the file does not exist. */
function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${file}:-`;
  }
}

/**
 * Identity of the inputs: every file that would be read, in the order it would
 * be read, with its mtime and size. Listing the shard directories is a readdir
 * and a stat per file -- microseconds against the YAML parse it saves.
 */
function sourceSignature(sources: ResolvedIndexSources): string {
  const files = [
    sources.apisFile,
    ...(sources.userFile === null ? [] : [sources.userFile]),
    ...sources.shardDirs.flatMap((dir) => shardFiles(dir)),
  ];
  return files.map(fileStamp).join("|");
}

function cachedApiIndex(sources: ResolvedIndexSources, noCache: boolean): ApiIndex {
  const key = JSON.stringify([sources.apisFile, sources.userFile, sources.shardDirs]);
  const signature = sourceSignature(sources);
  const hit = indexCache.get(key);
  if (!noCache && hit !== undefined && hit.signature === signature) {
    apiIndexCacheStats.hits += 1;
    return hit.index;
  }
  apiIndexCacheStats.misses += 1;
  const index = buildApiIndex(sources);
  if (indexCache.size >= INDEX_CACHE_LIMIT) {
    const oldest = indexCache.keys().next();
    if (!oldest.done) indexCache.delete(oldest.value);
  }
  indexCache.set(key, { signature, index });
  return index;
}

function buildApiIndex(sources: ResolvedIndexSources): ApiIndex {
  const { apisFile, userFile, shardDirs } = sources;
  const primary = validateApisFile(apisFile);
  const errors = [...primary.errors];
  const files = [apisFile];

  const entries: IndexEntry[] = (primary.document?.entries ?? []).map((entry) => ({
    ...entry,
    origin: "apis.yaml" as const,
    origin_file: apisFile,
  }));
  const apisYamlCount = entries.length;

  const claimedNames = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const claimedDomains = new Set<string>();
  const claim = (entry: IndexEntry): void => {
    for (const candidate of [entry.domain, entry.base_url, entry.url]) {
      const registrable =
        candidate === undefined || candidate === null ? "" : registrableDomain(candidate);
      if (registrable !== "") claimedDomains.add(registrable);
    }
  };
  for (const entry of entries) claim(entry);

  // The user index sits between apis.yaml and the shards: a row an agent
  // researched knows the auth header and the billing model, which a generated
  // shard row never does -- but a reviewed apis.yaml row still wins over both.
  let userCount = 0;
  if (userFile !== null) {
    const user = loadUserIndex(userFile);
    errors.push(...user.errors);
    if (user.exists) files.push(userFile);
    for (const entry of user.entries) {
      const name = entry.name.toLowerCase();
      if (claimedNames.has(name)) {
        errors.push(
          `${userFile}: ${JSON.stringify(entry.name)} is already in ${path.basename(apisFile)}; ` +
            "the reviewed row wins and the discovered one was dropped",
        );
        continue;
      }
      const row: IndexEntry = { ...entry, origin: "user", origin_file: userFile };
      claimedNames.add(name);
      claim(row);
      entries.push(row);
      userCount += 1;
    }
  }

  let shardCount = 0;
  let duplicates = 0;
  /** Carriage from shard rows displaced by a hand-written row, by lookup key. */
  const displacedCarriage = new Map<string, { aggregators: AggregatorCarriage[]; file: string }>();

  for (const dir of shardDirs) {
    for (const file of shardFiles(dir)) {
      const shard = readShardFile(file);
      errors.push(...shard.errors);
      files.push(file);
      for (const entry of shard.entries) {
        const name = entry.name.toLowerCase();
        const hosts = [entry.url, entry.vendor_url ?? null]
          .map((candidate) => (candidate === null ? "" : registrableDomain(candidate)))
          .filter((registrable) => registrable !== "");
        const displaced = claimedNames.has(name) || hosts.some((host) => claimedDomains.has(host));
        if (displaced) {
          duplicates += 1;
          // Keep what the catalogs knew about this vendor so the richer row can
          // inherit its carriage instead of silently losing it.
          if (entry.aggregators != null) {
            for (const lookupKey of [name, ...hosts]) {
              if (!displacedCarriage.has(lookupKey)) {
                displacedCarriage.set(lookupKey, { aggregators: entry.aggregators, file });
              }
            }
          }
          continue;
        }
        claimedNames.add(name);
        entries.push(entry);
        shardCount += 1;
      }
    }
  }

  // Inherit carriage, but never override a row that states its own: a
  // hand-verified price always beats "seen in this catalog".
  for (const entry of entries) {
    if (entry.origin === "shard" || entry.aggregators != null) continue;
    const keys = [
      entry.name.toLowerCase(),
      ...[entry.domain, entry.base_url, entry.url]
        .map((candidate) => (candidate === undefined || candidate === null ? "" : registrableDomain(candidate)))
        .filter((host) => host !== ""),
    ];
    for (const key of keys) {
      const found = displacedCarriage.get(key);
      if (found !== undefined) {
        entry.aggregators = found.aggregators;
        entry.aggregators_source = found.file;
        break;
      }
    }
  }

  return {
    entries,
    files,
    errors,
    counts: {
      apis_yaml: apisYamlCount,
      user_index: userCount,
      shards: shardCount,
      merged_duplicates: duplicates,
      total: entries.length,
    },
  };
}
