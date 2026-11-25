/**
 * The account model (ND-1): one record per vendor account a human registered.
 *
 * An account is metadata that points at the vault entries holding its secrets
 * -- it never holds a secret itself. The email a human signed up with is PII,
 * so like a login's username (`vault/entries.ts`) only a masked hint of it is
 * ever written here; the real address lives only inside a login entry's
 * envelope, if one was stored.
 */
import fs from "node:fs";
import YAML from "yaml";
import { loadApiIndex, readShardFile, resolveShardDirs, shardFiles } from "../apis.js";
import { ensureHome } from "../config.js";
import { accountsPath, skeletonKeyHome } from "../paths.js";

/** Same shape as a vault entry name: `vault/uri.ts`'s `ENTRY_NAME_PATTERN`. */
export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A vendor id, as it appears as an index entry's `name`: lower-case only. */
export const ACCOUNT_VENDOR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface AccountMeta {
  name: string;
  vendor: string;
  /** YYYY-MM-DD, local date the account was registered. */
  registered: string;
  /** Masked (e.g. `b**********@gmail.com`). Never the plaintext email. */
  email_hint: string | null;
  /** Name of an `api_key` vault entry, or null. */
  key_alias: string | null;
  /** Name of a `login` vault entry, or null. */
  login_entry: string | null;
  created: string;
  disabled: boolean;
  disabled_at: string | null;
}

export interface AccountsFile {
  version: 1;
  accounts: AccountMeta[];
}

/** What `account list` and the `list_accounts` MCP tool see: never a value. */
export interface AccountSummary extends AccountMeta {
  /** `vault://` references an agent may be given for this account's secrets. */
  refs: string[];
}

const HEADER = `# SkeletonKey account metadata -- NO SECRET VALUES ARE STORED HERE.
# This file holds no secret values: only the vendor accounts you registered and
# the vault entries they point at. See \`skeletonkey account list\` and docs/vault.md.
`;

export function readAccounts(home = skeletonKeyHome()): AccountsFile {
  const file = accountsPath(home);
  if (!fs.existsSync(file)) return { version: 1, accounts: [] };
  const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object") return { version: 1, accounts: [] };
  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw["accounts"]) ? (raw["accounts"] as unknown[]) : [];
  return {
    version: 1,
    accounts: list.map(coerceAccount).filter((account): account is AccountMeta => account !== null),
  };
}

export function writeAccounts(data: AccountsFile, home = skeletonKeyHome()): void {
  ensureHome(home);
  const file = accountsPath(home);
  const body = YAML.stringify({
    version: 1,
    accounts: [...data.accounts].sort((a, b) => a.name.localeCompare(b.name)),
  });
  fs.writeFileSync(file, HEADER + body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function findAccount(name: string, home = skeletonKeyHome()): AccountMeta | undefined {
  return readAccounts(home).accounts.find((account) => account.name === name);
}

export function upsertAccount(meta: AccountMeta, home = skeletonKeyHome()): void {
  const data = readAccounts(home);
  const index = data.accounts.findIndex((account) => account.name === meta.name);
  if (index >= 0) data.accounts[index] = meta;
  else data.accounts.push(meta);
  writeAccounts(data, home);
}

export function removeAccount(name: string, home = skeletonKeyHome()): boolean {
  const data = readAccounts(home);
  const index = data.accounts.findIndex((account) => account.name === name);
  if (index < 0) return false;
  data.accounts.splice(index, 1);
  writeAccounts(data, home);
  return true;
}

/** The `vault://` references an agent may be handed for one account. */
export function accountRefs(account: AccountMeta): string[] {
  const refs: string[] = [];
  if (account.key_alias !== null) refs.push(`vault://${account.key_alias}`);
  if (account.login_entry !== null) {
    refs.push(`vault://${account.login_entry}.username`);
    refs.push(`vault://${account.login_entry}.password`);
  }
  return refs;
}

export function accountSummary(account: AccountMeta): AccountSummary {
  return { ...account, refs: accountRefs(account) };
}

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_NAME_PATTERN.test(name);
}

export function isValidVendorId(id: string): boolean {
  return ACCOUNT_VENDOR_PATTERN.test(id);
}

/** Today's date, in the local timezone, as YYYY-MM-DD. */
export function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True for a real calendar date in YYYY-MM-DD form (rejects e.g. 2024-02-30). */
export function isValidRegisteredDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export interface VendorIndexOptions {
  home?: string;
  apisFile?: string;
  apiShardDirs?: string[];
}

/**
 * True when a vendor id matches an index entry's `name`, case-insensitively,
 * OR a raw shard row's `id`. The merged index built by `src/apis.ts` folds a
 * shard row into an apis.yaml entry that shares a registrable domain (e.g.
 * `apify` folds into `example-apify-scraping`), which drops the shard id from
 * `index.entries` -- so the shard files are also read directly here, via the
 * same `readShardFile`/`shardFiles`/`resolveShardDirs` helpers `src/apis.ts`
 * uses, to recover ids the merge discarded. This never fetches anything itself.
 */
export function vendorKnown(vendor: string, options: VendorIndexOptions = {}): boolean {
  const index = loadApiIndex({
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.apisFile === undefined ? {} : { apisFile: options.apisFile }),
    ...(options.apiShardDirs === undefined ? {} : { shardDirs: options.apiShardDirs }),
  });
  const target = vendor.toLowerCase();
  if (index.entries.some((entry) => entry.name.toLowerCase() === target)) return true;
  const shardDirs = options.apiShardDirs ?? resolveShardDirs(options.home);
  return shardDirs.some((dir) =>
    shardFiles(dir).some((file) =>
      readShardFile(file).entries.some((entry) => entry.name.toLowerCase() === target),
    ),
  );
}

function coerceAccount(raw: unknown): AccountMeta | null {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const name = typeof obj["name"] === "string" ? (obj["name"] as string).trim() : "";
  if (name === "") return null;
  const vendor = typeof obj["vendor"] === "string" ? (obj["vendor"] as string).trim() : "";
  if (vendor === "") return null;
  const str = (field: string): string | null =>
    typeof obj[field] === "string" ? (obj[field] as string) : null;
  return {
    name,
    vendor,
    registered: str("registered") ?? "",
    email_hint: str("email_hint"),
    key_alias: str("key_alias"),
    login_entry: str("login_entry"),
    created: str("created") ?? "",
    disabled: obj["disabled"] === true,
    disabled_at: str("disabled_at"),
  };
}
