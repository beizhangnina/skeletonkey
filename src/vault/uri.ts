/**
 * The `vault://` grammar.
 *
 * ```
 * vault://<name>[.<field>]
 * ```
 *
 * The parse is deterministic and has no backtracking: the last dot decides,
 * and only if what follows it is a known field name. That is what makes
 * `vault://stripe.com-key` an entry called `stripe.com-key` rather than the
 * `com-key` field of an entry called `stripe`.
 *
 * Nothing here touches the vault: this module answers "is this a well-formed
 * reference, and what does it name?" only.
 */
import { SkeletonKeyError } from "../exit-codes.js";

/** Field names the grammar knows about. `totp` is reserved, not implemented. */
export const ENTRY_FIELD_NAMES = ["username", "password", "api_key", "totp"] as const;
export type EntryFieldName = (typeof ENTRY_FIELD_NAMES)[number];

/** The scheme, matched case-insensitively; the rest of the URI is case-sensitive. */
export const VAULT_URI_SCHEME = "vault://";

/** Entry names: start with a letter or digit, then letters, digits, `.`, `_`, `-`. */
export const ENTRY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface VaultUri {
  /** The entry name, without any field suffix. */
  name: string;
  /** The field, or null when the reference did not name one. */
  field: string | null;
}

/**
 * Thrown for a reference that does not parse. It carries the `bad_vault_uri`
 * code so the CLI can report it with the standard exit-code format.
 */
export class VaultUriError extends SkeletonKeyError {
  constructor(message: string, hint?: string) {
    super("bad_vault_uri", message, hint);
    this.name = "VaultUriError";
  }
}

export function isVaultUri(input: string): boolean {
  return input.toLowerCase().startsWith(VAULT_URI_SCHEME);
}

/** True when the name may be used as an entry name (and addressable in a URI). */
export function isValidEntryName(name: string): boolean {
  return ENTRY_NAME_PATTERN.test(name);
}

/**
 * A name may not end in `.<field>`: `github.password` would be unreachable,
 * because the parser would read `password` as the field of `github`.
 */
export function endsWithFieldSuffix(name: string): boolean {
  return ENTRY_FIELD_NAMES.some(
    (field) => name.endsWith(`.${field}`) && name.length > field.length + 1,
  );
}

/** Throws a `usage` error when the name cannot be used for a new entry. */
export function assertUsableEntryName(name: string): void {
  if (!isValidEntryName(name)) {
    throw new SkeletonKeyError(
      "usage",
      `Entry names must start with a letter or digit and contain only [A-Za-z0-9._-] (max 64 characters).`,
      `Got ${JSON.stringify(name)}.`,
    );
  }
  if (endsWithFieldSuffix(name)) {
    throw new SkeletonKeyError(
      "usage",
      `Entry names must not end in ".${ENTRY_FIELD_NAMES.join('", "')}".`,
      `Pick another name: "${name}" could not be addressed as vault://${name}.<field>.`,
    );
  }
}

/**
 * Parses a `vault://` reference.
 *
 * - the scheme is case-insensitive, the rest is case-sensitive;
 * - a `/`, `?`, `#`, whitespace, or an empty body is a bad reference;
 * - the last dot only splits when the suffix is a known field name.
 */
export function parseVaultUri(input: string): VaultUri {
  if (!isVaultUri(input)) {
    throw new VaultUriError(
      `${JSON.stringify(input)} is not a vault reference.`,
      "Grammar: vault://<entry>[.<field>], no slashes or spaces.",
    );
  }
  const body = input.slice(VAULT_URI_SCHEME.length);
  if (body === "" || /[/\\?#\s]/.test(body)) {
    throw new VaultUriError(
      `${JSON.stringify(input)} is not a vault reference.`,
      "Grammar: vault://<entry>[.<field>], no slashes or spaces.",
    );
  }
  const dot = body.lastIndexOf(".");
  if (dot > 0) {
    const suffix = body.slice(dot + 1);
    if ((ENTRY_FIELD_NAMES as readonly string[]).includes(suffix)) {
      const name = body.slice(0, dot);
      if (!isValidEntryName(name)) {
        throw new VaultUriError(
          `${JSON.stringify(input)} is not a vault reference.`,
          "Grammar: vault://<entry>[.<field>], no slashes or spaces.",
        );
      }
      return { name, field: suffix };
    }
  }
  if (!isValidEntryName(body)) {
    throw new VaultUriError(
      `${JSON.stringify(input)} is not a vault reference.`,
      "Grammar: vault://<entry>[.<field>], no slashes or spaces.",
    );
  }
  return { name: body, field: null };
}

/** Builds a reference back from a name and a field. */
export function formatVaultUri(name: string, field?: string | null): string {
  return field === undefined || field === null || field === ""
    ? `${VAULT_URI_SCHEME}${name}`
    : `${VAULT_URI_SCHEME}${name}.${field}`;
}

/**
 * The environment variable name a reference maps to by default: upper case,
 * with everything that is not a letter or a digit turned into `_`.
 * `github-login` + `password` becomes `GITHUB_LOGIN_PASSWORD`.
 */
export function envNameFor(name: string, field?: string | null): string {
  const parts = [name, field].filter((part): part is string => part !== null && part !== undefined && part !== "");
  return parts
    .join("-")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
}
