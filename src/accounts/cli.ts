/**
 * `skeletonkey account add|list|show|disable|enable` (ND-1).
 *
 * An account is metadata only: who the account is with, when it was
 * registered, a masked email hint, and which vault entries (if any) hold its
 * secrets. The secrets themselves are never read, printed, or returned by
 * anything in this file -- `--store-key`/`--store-login` write them straight
 * into the vault through `VaultEntryStore`, the same path `vault add` uses.
 */
import { SkeletonKeyError } from "../exit-codes.js";
import { findKey, normalizeDomain, setDisabled, upsertKey } from "../keys.js";
import { accountsPath, skeletonKeyHome } from "../paths.js";
import { promptHidden, readSecret, readStdin } from "../prompt.js";
import { rejectIfPaymentCard } from "../secret-intake.js";
import type { KeyInjection, KeyMeta, UpstreamScheme } from "../types.js";
import { fieldsFor, findEntry, maskUsername, setEntryDisabled, upsertEntry } from "../vault/entries.js";
import { openEntryStore } from "../vault/entry-store.js";
import { envNameFor, formatVaultUri } from "../vault/uri.js";
import {
  accountSummary,
  findAccount,
  isValidAccountName,
  isValidRegisteredDate,
  isValidVendorId,
  readAccounts,
  todayLocalDate,
  upsertAccount,
  vendorKnown,
  type AccountMeta,
  type AccountSummary,
} from "./store.js";

export interface AccountAddOptions {
  vendor: string;
  registered?: string;
  /**
   * Set only when the removed `--email <value>` flag was passed (commander
   * reports `true` with no value, or the string with one); its sole purpose
   * is to be detected and rejected before anything else runs.
   */
  email?: string | boolean;
  emailStdin: boolean;
  keyAlias?: string;
  storeKey: boolean;
  domain?: string;
  platform?: string;
  header: string;
  format: string;
  scheme?: UpstreamScheme;
  /**
   * Not a CLI flag: set only by callers in this process (e.g. `skeletonkey
   * signup complete`) that already know a vendor authenticates some other
   * way (a query parameter, not a header). `account add` never sets this.
   */
  injection?: KeyInjection;
  storeLogin: boolean;
  url?: string;
  stdin: boolean;
  yes: boolean;
}

function assertUsableAccountName(name: string): void {
  if (!isValidAccountName(name)) {
    throw new SkeletonKeyError(
      "usage",
      "Account names must start with a letter or digit and contain only [A-Za-z0-9._-] (max 64 characters).",
      `Got ${JSON.stringify(name)}.`,
    );
  }
}

function requirePassword(password: string): string {
  if (password.trim() === "") {
    throw new SkeletonKeyError(
      "usage",
      "An empty password is not an entry; nothing was stored.",
      "Type the password, or pipe it on stdin.",
    );
  }
  return password;
}

/** Reads the password for `--store-login`. The username always comes from `--email`. */
async function readAccountPassword(stdin: boolean): Promise<string> {
  if (stdin) {
    const data = await readStdin();
    if (data.includes("\n")) {
      throw new SkeletonKeyError(
        "usage",
        "A password read from stdin has to be a single line.",
        "Put only the password on stdin.",
      );
    }
    return requirePassword(data);
  }
  if (process.stdin.isTTY !== true) {
    throw new SkeletonKeyError(
      "usage",
      "--store-login needs --stdin when stdin is not a terminal.",
      "Pipe the password on stdin, or run this from a terminal.",
    );
  }
  let password: string;
  let repeat: string;
  try {
    password = await promptHidden("Password (not echoed): ");
    repeat = await promptHidden("Repeat password: ");
  } catch {
    throw new SkeletonKeyError(
      "usage",
      "A login password can only be typed on a terminal or piped on stdin.",
      "Use --stdin, or run this in your own terminal.",
    );
  }
  if (password !== repeat) {
    throw new SkeletonKeyError("usage", "The two passwords did not match; nothing was stored.", "Try again.");
  }
  return requirePassword(password);
}

/**
 * Rejects the removed plaintext `--email <value>` flag, shared by `account
 * add` and anything else that could plausibly be handed it (`signup
 * start`/`signup complete`; see `src/signup/cli.ts`).
 */
export function rejectPlaintextEmailFlag(email: string | boolean | undefined): void {
  if (email === undefined) return;
  throw new SkeletonKeyError(
    "usage",
    "--email <value> is no longer accepted: it would stay in shell history and the process list.",
    "Type it at the hidden prompt, or pipe it with --email-stdin.",
  );
}

/** A non-empty, single-line email read off stdin, or a usage error. */
function requireEmailLine(line: string | undefined): string {
  const email = (line ?? "").trim();
  if (email === "") {
    throw new SkeletonKeyError(
      "usage",
      "An empty email is not a value; nothing was stored.",
      "Pipe a non-empty email address, or type it at the hidden prompt.",
    );
  }
  return email;
}

/**
 * The account email and, when `--email-stdin` shares stdin with `--stdin`,
 * the secret that followed it on a second line.
 *
 * - `--email-stdin` alone: stdin must be exactly one line, the email.
 * - `--email-stdin --stdin`: stdin must be exactly two lines, the email then
 *   the secret (stdin carries only one value otherwise, so this is the one
 *   way to supply both without either ever appearing in argv).
 * - Neither flag, on a TTY: a hidden prompt (not echoed; Enter to skip).
 * - Neither flag, off a TTY: no email, same as today.
 */
async function resolveEmailAndStdinSecret(
  options: AccountAddOptions,
): Promise<{ email: string | null; stdinSecret: string | null }> {
  if (options.emailStdin) {
    const data = await readStdin();
    const lines = data.split("\n");
    if (options.stdin) {
      if (lines.length !== 2) {
        throw new SkeletonKeyError(
          "usage",
          "--email-stdin with --stdin expects exactly two lines on stdin: the email, then the secret.",
          "Put the email on the first line and the secret on the second.",
        );
      }
      return { email: requireEmailLine(lines[0]), stdinSecret: lines[1] ?? "" };
    }
    if (lines.length !== 1) {
      throw new SkeletonKeyError(
        "usage",
        "--email-stdin expects a single line on stdin.",
        "Pipe just the email address, or add --stdin to also send the secret as a second line.",
      );
    }
    return { email: requireEmailLine(lines[0]), stdinSecret: null };
  }
  if (process.stdin.isTTY !== true) return { email: null, stdinSecret: null };
  const answer = (await promptHidden("Account email (not echoed, Enter to skip): ")).trim();
  return { email: answer === "" ? null : answer, stdinSecret: null };
}

/**
 * Does the validation, storage, and metadata work for `account add` (and for
 * `skeletonkey signup complete`, which calls this directly with the vendor
 * playbook's domain/header/format so it can print its own, narrower output
 * instead of `account add`'s). Never prints anything itself.
 */
export async function addAccount(
  name: string,
  options: AccountAddOptions,
  home = skeletonKeyHome(),
): Promise<AccountMeta> {
  rejectPlaintextEmailFlag(options.email);
  assertUsableAccountName(name);
  if (!isValidVendorId(options.vendor)) {
    throw new SkeletonKeyError(
      "usage",
      `--vendor must match ^[a-z0-9][a-z0-9._-]{0,63}$ (got ${JSON.stringify(options.vendor)}).`,
      "Vendor ids are the lower-case index id, e.g. apify.",
    );
  }
  if (options.storeKey && options.storeLogin && options.stdin) {
    throw new SkeletonKeyError(
      "usage",
      "--store-key and --store-login together with --stdin only carries one secret.",
      "Run two commands (one per secret), or use a terminal for at least one of them.",
    );
  }
  if (options.registered !== undefined && !isValidRegisteredDate(options.registered)) {
    throw new SkeletonKeyError(
      "usage",
      `--registered must be a real YYYY-MM-DD date (got ${JSON.stringify(options.registered)}).`,
      "Example: --registered 2026-11-24",
    );
  }

  const existing = findAccount(name, home);
  if (existing !== undefined && options.yes !== true) {
    throw new SkeletonKeyError(
      "name_taken",
      `"${name}" already exists as an account.`,
      "Pass --yes to overwrite, or pick another name.",
    );
  }

  if (!vendorKnown(options.vendor, { home })) {
    console.error(
      `Warning: vendor "${options.vendor}" is not in the bundled API index; recording it anyway.`,
    );
  }

  const { email, stdinSecret } = await resolveEmailAndStdinSecret(options);
  if (options.storeLogin && email === null) {
    throw new SkeletonKeyError(
      "usage",
      "--store-login needs an email for the login username.",
      "Type it at the hidden prompt, or pipe it with --email-stdin.",
    );
  }

  const store = openEntryStore(home);
  let createdKeyAlias: string | null = null;
  let createdLoginName: string | null = null;

  try {
    let keyAlias: string | null = existing?.key_alias ?? null;
    if (options.storeKey) {
      if (options.domain === undefined || options.domain.trim() === "") {
        throw new SkeletonKeyError(
          "usage",
          "--domain is required with --store-key.",
          "Example: --store-key --domain api.example.com",
        );
      }
      if (!options.format.includes("{key}")) {
        throw new SkeletonKeyError(
          "usage",
          `--format must contain the {key} placeholder (got ${JSON.stringify(options.format)}).`,
        );
      }
      const alias = options.keyAlias ?? name;
      const domain = normalizeDomain(options.domain);
      const secret = (stdinSecret ?? (await readSecret(options.stdin))).trim();
      if (secret === "") {
        throw new SkeletonKeyError("usage", "An empty API key is not an entry; nothing was stored.");
      }
      rejectIfPaymentCard(secret);
      await store.putApiKey(alias, secret);
      createdKeyAlias = alias;
      const keyExisting = findKey(alias, home);
      const meta: KeyMeta = {
        alias,
        platform: options.platform ?? options.vendor,
        domain,
        header: options.header,
        format: options.format,
        created: keyExisting?.created ?? new Date().toISOString(),
        last_used: keyExisting?.last_used ?? null,
        disabled: keyExisting?.disabled ?? false,
        ...(options.scheme === undefined ? {} : { scheme: options.scheme }),
        ...(options.injection === undefined ? {} : { injection: options.injection }),
      };
      upsertKey(meta, home);
      keyAlias = alias;
    } else if (options.keyAlias !== undefined) {
      if (findKey(options.keyAlias, home) === undefined) {
        throw new SkeletonKeyError(
          "entry_not_found",
          `No api_key vault entry named "${options.keyAlias}".`,
          "Store one first with --store-key, or check `skeletonkey vault list`.",
        );
      }
      keyAlias = options.keyAlias;
    }

    let loginEntry: string | null = existing?.login_entry ?? null;
    if (options.storeLogin) {
      const url = options.url?.trim();
      if (url !== undefined && url !== "" && !/^https?:\/\//i.test(url)) {
        throw new SkeletonKeyError("usage", "--url must be an http(s) URL.", "Example: --url https://apify.com/login");
      }
      const loginName = `${name}-login`;
      const password = stdinSecret !== null ? requirePassword(stdinSecret) : await readAccountPassword(options.stdin);
      await store.putLogin(loginName, { username: email as string, password });
      createdLoginName = loginName;
      const domain = url === undefined || url === "" ? null : normalizeDomain(url);
      upsertEntry(
        {
          name: loginName,
          type: "login",
          fields: fieldsFor("login"),
          created: new Date().toISOString(),
          last_used: null,
          disabled: false,
          ...(url === undefined || url === "" ? {} : { url }),
          domain,
          username_hint: maskUsername(email as string),
        },
        home,
      );
      loginEntry = loginName;
    }

    const registered = options.registered ?? existing?.registered ?? todayLocalDate();
    const meta: AccountMeta = {
      name,
      vendor: options.vendor,
      registered,
      email_hint: email !== null ? maskUsername(email) : existing?.email_hint ?? null,
      key_alias: keyAlias,
      login_entry: loginEntry,
      created: existing?.created ?? new Date().toISOString(),
      disabled: existing?.disabled ?? false,
      disabled_at: existing?.disabled_at ?? null,
    };
    upsertAccount(meta, home);
    return meta;
  } catch (error) {
    if (createdKeyAlias !== null) {
      try {
        await store.deleteEntry(createdKeyAlias);
      } catch {
        // best effort: the original error is what the caller needs to see
      }
    }
    if (createdLoginName !== null) {
      try {
        await store.deleteEntry(createdLoginName);
      } catch {
        // best effort
      }
    }
    throw error;
  }
}

export async function cmdAccountAdd(
  name: string,
  options: AccountAddOptions,
  home = skeletonKeyHome(),
): Promise<void> {
  const meta = await addAccount(name, options, home);

  console.log(`Registered account "${name}" (vendor: ${options.vendor}).`);
  console.log(`Metadata recorded in ${accountsPath(home)} (never contains secret values).`);
  const refs: string[] = [];
  if (meta.key_alias !== null) refs.push(`${formatVaultUri(meta.key_alias)} (api key)`);
  if (meta.login_entry !== null) refs.push(formatVaultUri(meta.login_entry, "password"));
  if (refs.length > 0) {
    console.log(`Give an agent only these references: ${refs.join(", ")}`);
    console.log(`Use them with: skeletonkey run --env NAME=<ref> -- <your command>`);
  } else {
    console.log(
      "No secret is linked yet. Add one with --store-key, --store-login, or --key-alias <existing entry>.",
    );
  }
}

export interface AccountListOptions {
  json: boolean;
  active: boolean;
}

export function listAccountSummaries(home = skeletonKeyHome(), activeOnly = false): AccountSummary[] {
  const accounts = readAccounts(home).accounts;
  const filtered = activeOnly ? accounts.filter((account) => !account.disabled) : accounts;
  return filtered.map(accountSummary).sort((a, b) => a.name.localeCompare(b.name));
}

export function cmdAccountShowData(name: string, home = skeletonKeyHome()): AccountSummary {
  const account = findAccount(name, home);
  if (account === undefined) {
    throw new SkeletonKeyError(
      "entry_not_found",
      `No account named "${name}".`,
      "List them with `skeletonkey account list`.",
    );
  }
  return accountSummary(account);
}

/** The exact `run` command to suggest for one account's primary secret. */
export function accountRunCommand(account: AccountMeta): string | null {
  if (account.login_entry !== null) {
    const ref = formatVaultUri(account.login_entry, "password");
    return `skeletonkey run --env ${envNameFor(account.login_entry, "password")}=${ref} -- <your command>`;
  }
  if (account.key_alias !== null) {
    const ref = formatVaultUri(account.key_alias);
    return `skeletonkey run --env ${envNameFor(account.key_alias)}=${ref} -- <your command>`;
  }
  return null;
}

/**
 * Flips `disabled` on the account and on whatever vault entries it points at,
 * so `skeletonkey run` refuses them (`entry_disabled`) and the proxy stops
 * injecting the key. Idempotent: disabling (or enabling) twice leaves the same
 * state and never errors.
 */
export function setAccountDisabled(
  name: string,
  disabled: boolean,
  home = skeletonKeyHome(),
): AccountMeta {
  const account = findAccount(name, home);
  if (account === undefined) {
    throw new SkeletonKeyError(
      "entry_not_found",
      `No account named "${name}".`,
      "List them with \`skeletonkey account list\`.",
    );
  }
  const updated: AccountMeta = {
    ...account,
    disabled,
    disabled_at: disabled ? account.disabled_at ?? new Date().toISOString() : null,
  };
  upsertAccount(updated, home);
  if (account.key_alias !== null && findKey(account.key_alias, home) !== undefined) {
    setDisabled(account.key_alias, disabled, home);
  }
  if (account.login_entry !== null && findEntry(account.login_entry, home) !== undefined) {
    setEntryDisabled(account.login_entry, disabled, home);
  }
  return updated;
}
