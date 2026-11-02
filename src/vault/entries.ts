/**
 * The entry model: what SkeletonKey can store locally.
 *
 * Two kinds of entry in v1:
 *
 *   - `api_key` -- one secret, the thing the proxy injects into a header.
 *     These are **not migrated**: they keep living in `keys.yaml` plus a
 *     `<alias>` record in the vault, exactly as before.
 *   - `login`   -- a username and a password for a site or app. These live in
 *     the new `entries.yaml` plus a `login/<name>` record in the vault.
 *
 * The metadata file holds **no secret values at all**. A login's username is
 * treated as a secret too (it is PII, and "the AI only ever gets a reference"
 * is the whole point), so the metadata only keeps a masked `username_hint`.
 */
import fs from "node:fs";
import YAML from "yaml";
import { ensureHome } from "../config.js";
import { SkeletonKeyError } from "../exit-codes.js";
import { readKeys } from "../keys.js";
import { entriesPath, skeletonKeyHome } from "../paths.js";
import { ENTRY_FIELD_NAMES } from "./uri.js";

export type VaultEntryType = "api_key" | "login";

/** The secret fields each type has. `totp` is reserved for a later release. */
export const ENTRY_FIELDS: Record<VaultEntryType, string[]> = {
  api_key: ["api_key"],
  login: ["username", "password"],
};

export interface VaultEntryMeta {
  name: string;
  type: VaultEntryType;
  /** Human label; never a secret. */
  label?: string;
  /** Where this login is used (https only). */
  url?: string;
  /** Normalised host; derived from `url` when not given. */
  domain?: string | null;
  /** Masked username. Never the username itself. */
  username_hint?: string;
  /** The secret fields this entry carries. */
  fields: string[];
  created: string;
  last_used: string | null;
  disabled: boolean;
}

export interface EntriesFile {
  version: 1;
  entries: VaultEntryMeta[];
}

/** What `vault list` and the MCP tools see: metadata, never values. */
export interface VaultEntrySummary {
  name: string;
  type: VaultEntryType;
  /** Where the entry points: a domain for a key, a host for a login. */
  target: string | null;
  label?: string;
  fields: string[];
  created: string;
  last_used: string | null;
  disabled: boolean;
  username_hint?: string;
  /** True when an api_key row shadows a login entry of the same name. */
  shadowed?: boolean;
}

const HEADER = `# SkeletonKey entry metadata -- NO SECRET VALUES ARE STORED HERE.
# Passwords and usernames live in the configured vault (Bitwarden, 1Password, OS
# keychain, or the encrypted file vault). See \`skeletonkey vault list\` and docs/vault.md.
`;

// --- reading and writing --------------------------------------------------

export function readEntries(home = skeletonKeyHome()): EntriesFile {
  const file = entriesPath(home);
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object") return { version: 1, entries: [] };
  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw["entries"]) ? (raw["entries"] as unknown[]) : [];
  return { version: 1, entries: list.map(coerceEntry).filter((entry) => entry !== null) };
}

export function writeEntries(data: EntriesFile, home = skeletonKeyHome()): void {
  ensureHome(home);
  const file = entriesPath(home);
  const body = YAML.stringify({
    version: 1,
    entries: [...data.entries].sort((a, b) => a.name.localeCompare(b.name)),
  });
  fs.writeFileSync(file, HEADER + body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function findEntry(name: string, home = skeletonKeyHome()): VaultEntryMeta | undefined {
  return readEntries(home).entries.find((entry) => entry.name === name);
}

export function upsertEntry(meta: VaultEntryMeta, home = skeletonKeyHome()): void {
  const data = readEntries(home);
  const index = data.entries.findIndex((entry) => entry.name === meta.name);
  if (index >= 0) data.entries[index] = meta;
  else data.entries.push(meta);
  writeEntries(data, home);
}

export function removeEntry(name: string, home = skeletonKeyHome()): boolean {
  const data = readEntries(home);
  const index = data.entries.findIndex((entry) => entry.name === name);
  if (index < 0) return false;
  data.entries.splice(index, 1);
  writeEntries(data, home);
  return true;
}

// --- the merged view -------------------------------------------------------

/**
 * Every entry SkeletonKey knows about: the api_key rows of `keys.yaml`
 * projected onto the entry shape, plus the `entries.yaml` logins.
 *
 * The two files share one namespace, so a name can only exist once. If a hand
 * edit ever produces a collision, the api_key row wins and the login is marked
 * `shadowed` rather than silently dropped.
 */
export function listVaultEntries(home = skeletonKeyHome()): VaultEntrySummary[] {
  const keys = readKeys(home).keys;
  const logins = readEntries(home).entries;
  const summaries: VaultEntrySummary[] = keys.map((key) => ({
    name: key.alias,
    type: "api_key" as const,
    target: key.domain,
    fields: [...ENTRY_FIELDS.api_key],
    created: key.created,
    last_used: key.last_used ?? null,
    disabled: key.disabled === true,
  }));
  for (const entry of logins) {
    const shadowed = summaries.some((summary) => summary.name === entry.name);
    const summary: VaultEntrySummary = {
      name: entry.name,
      type: entry.type,
      target: entryTarget(entry),
      fields: [...entry.fields],
      created: entry.created,
      last_used: entry.last_used ?? null,
      disabled: entry.disabled === true,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.username_hint === undefined ? {} : { username_hint: entry.username_hint }),
      ...(shadowed ? { shadowed: true } : {}),
    };
    if (!shadowed) summaries.push(summary);
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Where a login points: its domain, else the host of its url, else nothing. */
export function entryTarget(entry: VaultEntryMeta): string | null {
  if (entry.domain !== undefined && entry.domain !== null && entry.domain !== "") {
    return entry.domain;
  }
  if (entry.url !== undefined && entry.url !== "") {
    try {
      return new URL(entry.url).host;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The key an entry is stored under in the vault.
 *
 * api_key entries keep the v0.3 layout (`<alias>`) so nothing has to be
 * migrated; a login gets `login/<name>`.
 */
export function storageAlias(entry: { name: string; type: VaultEntryType }): string {
  return entry.type === "login" ? `login/${entry.name}` : entry.name;
}

// --- the login envelope ----------------------------------------------------

/** What a login looks like inside the vault: one line of JSON, one record. */
export interface LoginEnvelope {
  v: 1;
  type: "login";
  username: string;
  password: string;
  totp: null;
}

/**
 * Encodes a login as the single-line JSON envelope every backend can store.
 * One line matters: the OS keychain refuses values containing newlines.
 */
export function encodeLogin(username: string, password: string): string {
  const envelope: LoginEnvelope = { v: 1, type: "login", username, password, totp: null };
  return JSON.stringify(envelope);
}

/**
 * Decodes a login envelope.
 *
 * A corrupt envelope throws `entry_corrupt`, and the message never quotes the
 * stored bytes -- an error message that repeated the secret would be the leak.
 */
export function decodeLogin(raw: string, name: string): LoginEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptEntry(name);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw corruptEntry(name);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj["v"] !== 1 || obj["type"] !== "login") throw corruptEntry(name);
  const username = obj["username"];
  const password = obj["password"];
  if (typeof username !== "string" || typeof password !== "string") throw corruptEntry(name);
  return { v: 1, type: "login", username, password, totp: null };
}

function corruptEntry(name: string): SkeletonKeyError {
  return new SkeletonKeyError(
    "entry_corrupt",
    `Entry "${name}" could not be decoded (stored envelope is not a v1 login).`,
    `Re-add it: skeletonkey vault add ${name} --type login`,
  );
}

/**
 * Masks a username for the metadata file.
 *
 * An address keeps its domain and its first character; anything else keeps its
 * first character only. The result is a hint, never the username.
 */
export function maskUsername(username: string): string {
  const value = username.trim();
  if (value === "") return "";
  const at = value.indexOf("@");
  if (at > 0 && at < value.length - 1 && !value.slice(at + 1).includes("@")) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const stars = "*".repeat(Math.max(1, local.length - 1));
    return `${local[0]}${stars}@${domain}`;
  }
  return `${value[0]}***`;
}

/** The secret fields of an entry type, as a fresh array. */
export function fieldsFor(type: VaultEntryType): string[] {
  return [...ENTRY_FIELDS[type]];
}

/** True when the field name is one the grammar reserves. */
export function isKnownFieldName(field: string): boolean {
  return (ENTRY_FIELD_NAMES as readonly string[]).includes(field);
}

// --- coercion --------------------------------------------------------------

function coerceEntry(raw: unknown): VaultEntryMeta | null {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const name = typeof obj["name"] === "string" ? (obj["name"] as string).trim() : "";
  if (name === "") return null;
  const type: VaultEntryType = obj["type"] === "login" ? "login" : "api_key";
  const rawFields = Array.isArray(obj["fields"])
    ? (obj["fields"] as unknown[]).filter((field): field is string => typeof field === "string")
    : [];
  const fields = rawFields.length > 0 ? rawFields : fieldsFor(type);
  const entry: VaultEntryMeta = {
    name,
    type,
    fields,
    created: typeof obj["created"] === "string" ? (obj["created"] as string) : "",
    last_used: typeof obj["last_used"] === "string" ? (obj["last_used"] as string) : null,
    disabled: obj["disabled"] === true,
  };
  if (typeof obj["label"] === "string") entry.label = obj["label"];
  if (typeof obj["url"] === "string") entry.url = obj["url"];
  if (typeof obj["domain"] === "string") entry.domain = obj["domain"];
  else if (typeof obj["domain"] === "boolean") entry.domain = null;
  if (typeof obj["username_hint"] === "string") entry.username_hint = obj["username_hint"];
  return entry;
}
