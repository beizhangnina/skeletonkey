/**
 * Bitwarden account detection, and vendor item lookup by the bound email.
 *
 * Two jobs, both read-only:
 *
 *   1. Say plainly whether `bw` is installed, logged in and unlocked, and
 *      whether the account it is logged in as is the bound email from
 *      `config.yaml`. When it is not usable, produce the exact commands the
 *      *human* runs in their own terminal.
 *   2. Find the vendor's existing login / API-key item for the bound email:
 *      `bw list items --search <domain>`, then filter to items whose login
 *      username, URIs, custom fields or notes carry the bound address.
 *
 * The master password is never part of any of this. SkeletonKey does not
 * prompt for it, does not read it, does not pass it to `bw`, and never puts it
 * in argv or in an MCP response: `bw login` and `bw unlock` are human actions,
 * and the only thing that crosses back into this process is `BW_SESSION`,
 * which the human exports themselves.
 */
import { domainMatches, normalizeDomain } from "../keys.js";
import { run } from "./exec.js";

export interface BwRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `bw` invocation seam, so tests can drive a fake without installing one. */
export type BwRunner = (args: string[], stdin?: string) => Promise<BwRunResult>;

export function childProcessBw(binary = "bw"): BwRunner {
  return (args, stdin) => run(binary, args, stdin);
}

export type BwSessionState =
  | "unlocked"
  | "locked"
  | "unauthenticated"
  | "not-installed"
  | "unknown";

export interface BwAccount {
  state: BwSessionState;
  /** True only for `unlocked`: the one state in which items can be read. */
  usable: boolean;
  /** Address `bw status` reports for the logged-in account, when it reports one. */
  account: string | null;
  /** The bound email from the SkeletonKey config, when there is one. */
  bound: string | null;
  /** null when either side is unknown. `+alias` variants count as a match. */
  matchesBound: boolean | null;
  /** One line, safe to print. Never a password and never a session key. */
  summary: string;
}

/** Shown wherever `bw` has to be installed first. */
export const BW_INSTALL_URL = "https://bitwarden.com/help/cli/";

/**
 * `bw status` prints JSON like
 * `{"serverUrl":null,"userEmail":"you@example.com","status":"unlocked"}`.
 * Older builds printed a bare word, so both shapes are read.
 */
export function parseBwStatus(stdout: string): { status: string; userEmail: string | null } {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as { status?: unknown; userEmail?: unknown };
    const status = typeof parsed.status === "string" ? parsed.status : "";
    const email =
      typeof parsed.userEmail === "string" && parsed.userEmail.trim() !== ""
        ? parsed.userEmail.trim()
        : null;
    if (status !== "") return { status, userEmail: email };
  } catch {
    // fall through: not JSON
  }
  return { status: trimmed.replace(/^"|"$/g, ""), userEmail: null };
}

/** `apis+tikhub@example.com` is the same mailbox as `apis@example.com`. */
export function sameMailbox(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalAddress(a);
  const right = canonicalAddress(b);
  return left !== "" && left === right;
}

function canonicalAddress(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at).replace(/\+.*$/, "");
  return `${local}@${trimmed.slice(at + 1)}`;
}

/** Runs `bw status` and reports what a human would have to fix, if anything. */
export async function bwAccountStatus(
  options: { bound?: string | null; bw?: BwRunner } = {},
): Promise<BwAccount> {
  const bw = options.bw ?? childProcessBw();
  const bound = options.bound?.trim() ?? null;
  let result: BwRunResult;
  try {
    result = await bw(["status"]);
  } catch (error) {
    // `run` rejects with ENOENT when the binary is not on PATH.
    const message = error instanceof Error ? error.message : String(error);
    return account("not-installed", null, bound, /not found/i.test(message) ? null : message);
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (/not found|no such file|command not found|ENOENT/i.test(stderr)) {
      return account("not-installed", null, bound, null);
    }
    return account("unknown", null, bound, stderr === "" ? null : stderr);
  }
  const parsed = parseBwStatus(result.stdout);
  const state: BwSessionState =
    parsed.status === "unlocked"
      ? "unlocked"
      : parsed.status === "locked"
        ? "locked"
        : parsed.status === "unauthenticated"
          ? "unauthenticated"
          : "unknown";
  return account(state, parsed.userEmail, bound, null);
}

function account(
  state: BwSessionState,
  email: string | null,
  bound: string | null,
  note: string | null,
): BwAccount {
  const matchesBound = email === null || bound === null ? null : sameMailbox(email, bound);
  const parts: string[] = [];
  switch (state) {
    case "unlocked":
      parts.push("the `bw` CLI is installed, logged in and unlocked");
      break;
    case "locked":
      parts.push("the `bw` CLI is logged in but locked");
      break;
    case "unauthenticated":
      parts.push("the `bw` CLI is installed but not logged in");
      break;
    case "not-installed":
      parts.push("the `bw` CLI was not found on PATH");
      break;
    case "unknown":
      parts.push("`bw status` could not be read");
      break;
  }
  if (email !== null) parts.push(`account ${email}`);
  if (bound !== null && matchesBound === false) {
    parts.push(`which is NOT the bound email ${bound}`);
  } else if (bound !== null && matchesBound === true) {
    parts.push(`which matches the bound email ${bound}`);
  }
  if (note !== null) parts.push(note);
  return {
    state,
    usable: state === "unlocked",
    account: email,
    bound,
    matchesBound,
    summary: parts.join(", "),
  };
}

/**
 * The guided prompt: what the human runs, in their own terminal, to get from
 * wherever they are to an unlocked `bw`. Returns an empty list when nothing
 * needs doing and the account matches the bound email.
 *
 * `loginAs` lets a caller use an address the human has just confirmed instead
 * of the one in the config.
 */
export function bwGuidance(status: BwAccount, loginAs?: string | null): string[] {
  const address = (loginAs ?? status.bound ?? "").trim();
  const login = address === "" ? "bw login <your bound email>" : `bw login ${address}`;
  const lines: string[] = [];
  switch (status.state) {
    case "not-installed":
      lines.push(
        "Bitwarden's `bw` CLI is not on PATH. Install it as yourself, with one of:",
        "  npm install -g @bitwarden/cli",
        "  brew install bitwarden-cli          # macOS / Linuxbrew",
        "  snap install bw                     # Linux",
        `  or download the binary from ${BW_INSTALL_URL}`,
        `Then: ${login}`,
        '     : export BW_SESSION="$(bw unlock --raw)"',
      );
      break;
    case "unauthenticated":
      lines.push(
        "Bitwarden is installed but not logged in. In your own terminal, run:",
        `  ${login}`,
        '  export BW_SESSION="$(bw unlock --raw)"',
      );
      break;
    case "locked":
      lines.push(
        "Bitwarden is logged in but locked. Unlocking is a human action. In your own terminal:",
        '  export BW_SESSION="$(bw unlock --raw)"',
        "Then run SkeletonKey from that same shell, so it inherits BW_SESSION.",
      );
      break;
    case "unknown":
      lines.push(
        "`bw status` did not answer in a way SkeletonKey understands. Check your install:",
        "  bw status",
        `  ${BW_INSTALL_URL}`,
      );
      break;
    case "unlocked":
      break;
  }
  if (status.state !== "unlocked") {
    lines.push(
      "SkeletonKey never asks for, stores, or passes on your Bitwarden master password: " +
        "run these yourself. No agent and no MCP tool ever sees it, and the only thing " +
        "SkeletonKey reads is the BW_SESSION you export.",
    );
  }
  if (status.matchesBound === false) {
    lines.push(
      `Note: \`bw\` is logged in as ${status.account ?? "another account"}, not the bound ` +
        `email ${status.bound ?? "(unset)"}. SkeletonKey looks vendor accounts up by the ` +
        "bound email, so either `bw logout` and log in as the bound email, or change " +
        "`email:` in config.yaml to the account you actually use.",
    );
  }
  return lines;
}

/** One error message carrying the whole guided prompt, for a hard failure. */
export function bwGuidanceError(status: BwAccount, loginAs?: string | null): Error {
  const lines = bwGuidance(status, loginAs);
  return new Error(
    [`Bitwarden is not ready: ${status.summary}.`, ...lines.map((line) => `  ${line}`)].join("\n"),
  );
}

/** Where the bound email was found on an item. */
export type BwEmailMatch = "username" | "field" | "uri" | "notes";
/** Where the vendor's domain was found on an item. */
export type BwDomainMatch = "uri" | "name" | "notes";

export interface BwVendorItem {
  id: string;
  name: string;
  email_match: BwEmailMatch;
  domain_match: BwDomainMatch;
  /** Login username as stored, so the human can see which account it is. */
  username: string | null;
  has_password: boolean;
  /** Name of the custom field that looks like an API key, when there is one. */
  api_key_field: string | null;
  /**
   * The values. Runner memory only: no caller may log these, write them to a
   * file, or return them from an MCP tool. `describeVendorItems` exists so the
   * human-readable form never has to touch them.
   */
  password: string | null;
  api_key: string | null;
}

export interface BwVendorLookup {
  account: BwAccount;
  /** Best match first: a login username hit beats a field or notes hit. */
  items: BwVendorItem[];
  /** Searches actually run, for the log. */
  searched: string[];
  /** Human-readable account of the lookup. Never contains a value. */
  detail: string;
}

interface BwRawItem {
  id?: unknown;
  name?: unknown;
  notes?: unknown;
  login?: {
    username?: unknown;
    password?: unknown;
    uris?: unknown;
  };
  fields?: unknown;
}

/** Field names that mean "this is the API key" on a vendor item. */
const API_KEY_FIELD = /^(x-)?(api[\s_-]*(key|token|secret)|access[\s_-]*token|secret[\s_-]*key|token|key|apikey)$/i;

/**
 * Finds the vendor's item(s) for the bound email.
 *
 * `bw list items --search` matches loosely (name and URIs), so the result is
 * filtered here twice: once for the domain, once for the bound address. An
 * item that mentions the domain but belongs to a *different* mailbox is never
 * returned -- that is the whole point of binding an email.
 */
export async function findVendorItems(options: {
  domain: string;
  bound: string | null;
  bw?: BwRunner;
  /** A status already taken, to avoid a second `bw status`. */
  account?: BwAccount;
}): Promise<BwVendorLookup> {
  const bw = options.bw ?? childProcessBw();
  const bound = options.bound?.trim() ?? null;
  const status =
    options.account ?? (await bwAccountStatus({ bound, ...(options.bw ? { bw } : {}) }));
  const domain = normalizeDomain(options.domain);
  if (!status.usable) {
    return {
      account: status,
      items: [],
      searched: [],
      detail: `Bitwarden cannot be read right now (${status.summary}); no lookup was attempted.`,
    };
  }
  if (domain === "") {
    return {
      account: status,
      items: [],
      searched: [],
      detail: "No vendor domain was given, so there was nothing to search for.",
    };
  }
  if (bound === null || bound === "") {
    return {
      account: status,
      items: [],
      searched: [],
      detail:
        "No bound email is configured, so an item could not be tied to an account. " +
        "Run `skeletonkey init --email <bound email>` first.",
    };
  }

  const searched = searchTerms(domain);
  const seen = new Map<string, BwRawItem>();
  for (const term of searched) {
    for (const item of await listItems(bw, term)) {
      const id = typeof item.id === "string" ? item.id : JSON.stringify(item.name ?? term);
      if (!seen.has(id)) seen.set(id, item);
    }
  }

  const items: BwVendorItem[] = [];
  for (const [id, raw] of seen) {
    // Both halves must hold: `bw --search` is loose, and an item for the right
    // mailbox that has nothing to do with this vendor must not answer for it.
    const emailMatch = emailMatchFor(raw, bound);
    if (emailMatch === null) continue;
    const domainMatch = domainMatchFor(raw, domain);
    if (domainMatch === null) continue;
    items.push(buildItem(id, raw, emailMatch, domainMatch));
  }
  items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return {
    account: status,
    items,
    searched,
    detail:
      items.length === 0
        ? `No Bitwarden item for ${bound} mentions ${domain} (searched ${searched.join(", ")}).`
        : `${items.length} Bitwarden item(s) for ${bound} match ${domain}.`,
  };
}

/** Names and matches, with no values in them. Safe to print or log. */
export function describeVendorItems(lookup: BwVendorLookup): string[] {
  return lookup.items.map((item) => {
    const parts = [
      `bound email in ${item.email_match === "username" ? "the login username" : `the item ${item.email_match}`}`,
      `domain from the item ${item.domain_match}`,
      item.has_password ? "has a password" : "no password stored",
    ];
    if (item.api_key_field !== null) parts.push(`API key in field "${item.api_key_field}"`);
    return `${item.name} (${item.id}) -- ${parts.join("; ")}`;
  });
}

/** `api.tikhub.io` is also searched as `tikhub.io`: items are filed either way. */
export function searchTerms(domain: string): string[] {
  const terms = [domain];
  const labels = domain.split(".");
  if (labels.length > 2) terms.push(labels.slice(-2).join("."));
  return [...new Set(terms)];
}

async function listItems(bw: BwRunner, search: string): Promise<BwRawItem[]> {
  let result: BwRunResult;
  try {
    result = await bw(["list", "items", "--search", search]);
  } catch {
    return [];
  }
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as BwRawItem[]) : [];
  } catch {
    return [];
  }
}

function emailMatchFor(raw: BwRawItem, bound: string): BwEmailMatch | null {
  const username = text(raw.login?.username);
  if (sameMailbox(username, bound)) return "username";
  for (const field of fieldsOf(raw)) {
    if (sameMailbox(field.value, bound)) return "field";
  }
  for (const uri of urisOf(raw)) {
    if (containsAddress(uri, bound)) return "uri";
  }
  const notes = text(raw.notes);
  if (notes !== null && containsAddress(notes, bound)) return "notes";
  return null;
}

/**
 * A mailbox mentioned inside free text (a `mailto:` URI, a notes line). Every
 * address in the text is compared as a mailbox, so `+alias` still matches.
 */
function containsAddress(haystack: string, bound: string): boolean {
  const found = haystack.match(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g) ?? [];
  return found.some((candidate) => sameMailbox(candidate.replace(/[.,;]+$/, ""), bound));
}

/** null when the item carries no sign of belonging to this vendor. */
function domainMatchFor(raw: BwRawItem, domain: string): BwDomainMatch | null {
  for (const uri of urisOf(raw)) {
    const host = normalizeDomain(uri.replace(/^[a-z]+:\/\//i, ""));
    if (host !== "" && (domainMatches(domain, host) || domainMatches(host, domain))) return "uri";
  }
  const name = text(raw.name)?.toLowerCase() ?? "";
  const labels = domain.split(".");
  const base = labels.length > 2 ? labels.slice(-2).join(".") : domain;
  const brand = base.split(".")[0] ?? base;
  if (name.includes(domain) || name.includes(base) || (brand.length > 2 && name.includes(brand))) {
    return "name";
  }
  const notes = text(raw.notes)?.toLowerCase() ?? "";
  if (notes.includes(domain) || notes.includes(base)) return "notes";
  return null;
}

function buildItem(
  id: string,
  raw: BwRawItem,
  emailMatch: BwEmailMatch,
  domainMatch: BwDomainMatch,
): BwVendorItem {
  const password = text(raw.login?.password);
  const apiKeyField = fieldsOf(raw).find(
    (field) => API_KEY_FIELD.test(field.name.trim()) && field.value !== null && field.value !== "",
  );
  return {
    id,
    name: text(raw.name) ?? "(unnamed item)",
    email_match: emailMatch,
    domain_match: domainMatch,
    username: text(raw.login?.username),
    has_password: password !== null,
    api_key_field: apiKeyField?.name.trim() ?? null,
    password,
    api_key: apiKeyField?.value ?? null,
  };
}

function rank(item: BwVendorItem): number {
  const email = { username: 0, field: 1, uri: 2, notes: 3 }[item.email_match];
  const domainRank = { uri: 0, name: 1, notes: 2 }[item.domain_match];
  return email * 3 + domainRank;
}

function fieldsOf(raw: BwRawItem): { name: string; value: string | null }[] {
  if (!Array.isArray(raw.fields)) return [];
  return (raw.fields as { name?: unknown; value?: unknown }[]).map((field) => ({
    name: typeof field?.name === "string" ? field.name : "",
    value: text(field?.value),
  }));
}

function urisOf(raw: BwRawItem): string[] {
  const uris = raw.login?.uris;
  if (!Array.isArray(uris)) return [];
  return (uris as { uri?: unknown }[])
    .map((entry) => text(entry?.uri))
    .filter((uri): uri is string => uri !== null);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
