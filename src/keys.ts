import fs from "node:fs";
import YAML from "yaml";
import { ensureHome } from "./config.js";
import { skeletonKeyHome, keysPath } from "./paths.js";
import { isUpstreamScheme, type KeyMeta, type KeysFile } from "./types.js";

const HEADER = `# SkeletonKey metadata index -- NO SECRET VALUES ARE STORED HERE.
# Secrets live in the configured vault (Bitwarden, 1Password, OS keychain, or the
# encrypted file vault). See \`skeletonkey list\` and README.md.
`;

export function readKeys(home = skeletonKeyHome()): KeysFile {
  const file = keysPath(home);
  if (!fs.existsSync(file)) return { version: 1, keys: [] };
  const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object") return { version: 1, keys: [] };
  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw["keys"]) ? (raw["keys"] as unknown[]) : [];
  return { version: 1, keys: list.map(coerceKey) };
}

export function writeKeys(data: KeysFile, home = skeletonKeyHome()): void {
  ensureHome(home);
  const file = keysPath(home);
  const body = YAML.stringify({
    version: 1,
    keys: [...data.keys].sort((a, b) => a.alias.localeCompare(b.alias)),
  });
  fs.writeFileSync(file, HEADER + body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function findKey(alias: string, home = skeletonKeyHome()): KeyMeta | undefined {
  return readKeys(home).keys.find((k) => k.alias === alias);
}

export function upsertKey(meta: KeyMeta, home = skeletonKeyHome()): void {
  const data = readKeys(home);
  const index = data.keys.findIndex((k) => k.alias === meta.alias);
  if (index >= 0) data.keys[index] = meta;
  else data.keys.push(meta);
  writeKeys(data, home);
}

export function setDisabled(alias: string, disabled: boolean, home = skeletonKeyHome()): KeyMeta {
  const data = readKeys(home);
  const key = data.keys.find((k) => k.alias === alias);
  if (!key) throw new Error(`Unknown alias ${JSON.stringify(alias)}.`);
  key.disabled = disabled;
  writeKeys(data, home);
  return key;
}

export function touchLastUsed(alias: string, when: string, home = skeletonKeyHome()): void {
  const data = readKeys(home);
  const key = data.keys.find((k) => k.alias === alias);
  if (!key) return;
  key.last_used = when;
  writeKeys(data, home);
}

/** Lowercased hostname without a port, for domain comparison. */
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  if (value.includes("://")) {
    try {
      value = new URL(value).host;
    } catch {
      // fall through and treat the input as a bare host
    }
  }
  value = value.replace(/\/.*$/, "");
  // Strip a trailing :port, but keep IPv6 literals intact.
  if (!value.includes("]")) value = value.replace(/:\d+$/, "");
  return value.replace(/^\.+|\.+$/g, "");
}

/** A key registered for `example.com` also covers `api.example.com`. */
export function domainMatches(keyDomain: string, host: string): boolean {
  const key = normalizeDomain(keyDomain);
  const target = normalizeDomain(host);
  if (!key || !target) return false;
  return target === key || target.endsWith(`.${key}`);
}

function coerceKey(raw: unknown): KeyMeta {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const str = (name: string, fallback = ""): string =>
    typeof obj[name] === "string" ? (obj[name] as string) : fallback;
  return {
    alias: str("alias"),
    platform: str("platform"),
    domain: str("domain"),
    header: str("header", "Authorization"),
    format: str("format", "Bearer {key}"),
    created: str("created"),
    last_used: typeof obj["last_used"] === "string" ? (obj["last_used"] as string) : null,
    disabled: obj["disabled"] === true,
    // An unreadable scheme is left undefined (decide per host) rather than
    // guessed: downgrading an upstream to http would send the key in clear.
    ...(typeof obj["scheme"] === "string" && isUpstreamScheme(obj["scheme"].trim().toLowerCase())
      ? { scheme: obj["scheme"].trim().toLowerCase() as KeyMeta["scheme"] }
      : {}),
  };
}
