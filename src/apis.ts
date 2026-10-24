import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { skeletonKeyHome } from "./paths.js";

export const ACCESS_MODES = ["x402", "intermediary", "own-account", "byok"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export interface ApiEntry {
  name: string;
  url: string;
  access_mode: AccessMode;
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

const OPTIONAL_FIELDS = ["example", "capabilities", "domain"] as const;

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
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    document: errors.length === 0 ? { version: 1, entries } : null,
  };
}

/**
 * Matches a free-text capability ("web scraping", "embeddings") against an
 * entry's tags, name, domain, and billing unit. Deliberately does NOT search
 * `tos_notes`: that field is prose, and matching common words against prose
 * returns junk.
 */
export function matchesCapability(entry: ApiEntry, capability: string): boolean {
  const needle = capability.trim().toLowerCase();
  if (needle === "") return true;

  const haystacks = [
    entry.name,
    entry.domain ?? "",
    ...(entry.capabilities ?? []),
    entry.billing_unit ?? "",
  ]
    .map((text) => text.toLowerCase())
    .filter((text) => text !== "");

  const words = needle.split(/[^a-z0-9.+]+/).filter((word) => word.length >= 3);

  for (const haystack of haystacks) {
    if (haystack.includes(needle)) return true;
    // Reverse containment lets "I need embeddings" find the tag "embeddings",
    // but only for tags long enough to be meaningful.
    if (haystack.length >= 5 && needle.includes(haystack)) return true;
    for (const word of words) {
      if (haystack.includes(word)) return true;
      // One character of stemming, so "scrape" finds "scraping".
      if (word.length >= 5 && haystack.includes(word.slice(0, -1))) return true;
    }
  }
  return false;
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
