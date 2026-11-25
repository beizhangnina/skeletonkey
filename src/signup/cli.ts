/**
 * `skeletonkey signup list|start|status|complete|abandon` (ND-2).
 *
 * `start` creates a local session and, with no driver injected (the only path
 * reachable from the CLI or an agent), stops at `needs_human`: it prints the
 * official URLs, the steps a human still has to do, and the exact command to
 * run once they have the key. It never claims success. `complete` is how the
 * human hands the key back, through the same hidden-prompt/--stdin contract
 * `account add` uses, bound into the vault via `addAccount` with the vendor
 * playbook's own domain/header/format -- so the agent only ever sees a
 * `vault://` reference afterward.
 */
import { SkeletonKeyError } from "../exit-codes.js";
import { noopOpener, type UrlOpener } from "../open-url.js";
import { skeletonKeyHome } from "../paths.js";
import { addAccount } from "../accounts/cli.js";
import { findAccount, todayLocalDate, upsertAccount, type AccountMeta } from "../accounts/store.js";
import { findKey, normalizeDomain, upsertKey } from "../keys.js";
import { openEntryStore } from "../vault/entry-store.js";
import { formatVaultUri } from "../vault/uri.js";
import type { KeyMeta } from "../types.js";
import { driveSignup, type Nd2SignupDriver } from "./drive.js";
import { signupPlaybook, listSignupPlaybooks, SIGNUP_VENDORS, type SignupPlaybook } from "./playbooks.js";
import {
  readSignups,
  sessionsForVendor,
  touchSession,
  upsertSession,
  type SignupSession,
} from "./sessions.js";

function requireVendor(vendor: string): SignupPlaybook {
  const playbook = signupPlaybook(vendor);
  if (playbook === null) {
    throw new SkeletonKeyError(
      "entry_not_found",
      `Unknown vendor "${vendor}" for \`skeletonkey signup\`.`,
      `First-wave vendors: ${SIGNUP_VENDORS.join(", ")}.`,
    );
  }
  return playbook;
}

function defaultAccountName(vendor: string): string {
  return `${vendor}-main`;
}

export interface PlaybookView {
  vendor: string;
  signup_url: string | null;
  key_page_url: string | null;
  docs: string;
  domain: string;
  env_hint: string;
  automation: "human-handoff";
  human_steps: string[];
}

export function playbookView(playbook: SignupPlaybook): PlaybookView {
  return {
    vendor: playbook.vendor,
    signup_url: playbook.signupUrl,
    key_page_url: playbook.keyPageUrl,
    docs: playbook.docs,
    domain: playbook.domain,
    env_hint: playbook.envHint,
    automation: playbook.automation,
    human_steps: [...playbook.humanSteps],
  };
}

/** Data for `skeletonkey signup list`. */
export function listSignupVendors(): PlaybookView[] {
  return listSignupPlaybooks().map(playbookView);
}

/**
 * Stores a secret directly as this account's `api_key`, and links the
 * account to it -- the same two writes `account add --store-key` makes, minus
 * the stdin/prompt plumbing, since here the secret is already in hand (from a
 * driver, in-process; never printed, never logged). Used only by the
 * trusted-host driver seam in `cmdSignupStart`, never by anything reachable
 * from a CLI flag or agent input.
 */
async function bindApiKey(
  account: string,
  vendor: string,
  playbook: SignupPlaybook,
  secret: string,
  home: string,
): Promise<AccountMeta> {
  const store = openEntryStore(home);
  await store.putApiKey(account, secret);
  const existingKey = findKey(account, home);
  const meta: KeyMeta = {
    alias: account,
    platform: vendor,
    domain: normalizeDomain(playbook.domain),
    header: playbook.header ?? "",
    format: playbook.format ?? "{key}",
    created: existingKey?.created ?? new Date().toISOString(),
    last_used: existingKey?.last_used ?? null,
    disabled: existingKey?.disabled ?? false,
    ...(playbook.injection === "env-only" ? { injection: "env-only" as const } : {}),
  };
  upsertKey(meta, home);

  const existingAccount = findAccount(account, home);
  const accountMeta: AccountMeta = {
    name: account,
    vendor,
    registered: existingAccount?.registered ?? todayLocalDate(),
    email_hint: existingAccount?.email_hint ?? null,
    key_alias: account,
    login_entry: existingAccount?.login_entry ?? null,
    created: existingAccount?.created ?? new Date().toISOString(),
    disabled: existingAccount?.disabled ?? false,
    disabled_at: existingAccount?.disabled_at ?? null,
  };
  upsertAccount(accountMeta, home);
  return accountMeta;
}

export interface SignupStartOptions {
  account?: string;
  noOpen: boolean;
  json: boolean;
  /** Test/trusted-host seam only. Never set from a CLI flag or agent input. */
  driverFor?: (vendor: string) => Nd2SignupDriver | undefined;
  openUrl?: UrlOpener;
}

interface StartResultView {
  vendor: string;
  account: string;
  status: "needs_human" | "bound";
  reason: string | null;
  signup_url: string | null;
  key_page_url: string | null;
  docs: string;
  steps: string[];
  next_command: string | null;
  refs: string[];
  opened: boolean;
  session_id: string;
}

export async function cmdSignupStart(
  vendorArg: string,
  options: SignupStartOptions,
  home = skeletonKeyHome(),
): Promise<void> {
  const vendor = vendorArg.trim().toLowerCase();
  const playbook = requireVendor(vendor);
  const account = options.account ?? defaultAccountName(vendor);

  const driver = options.driverFor?.(vendor);
  const outcome = await driveSignup(driver);

  if (outcome.status === "ready" && outcome.handle !== null) {
    // A driver advanced all the way to a key: bind it now, so the only thing
    // that comes back -- here or through signup status -- is a vault:// ref.
    const meta = await bindApiKey(account, vendor, playbook, outcome.handle, home);
    const session = touchSession(vendor, account, { state: "bound", reason: "complete", steps: [] }, home);
    printStartResult(
      {
        vendor,
        account,
        status: "bound",
        reason: "complete",
        signup_url: playbook.signupUrl,
        key_page_url: playbook.keyPageUrl,
        docs: playbook.docs,
        steps: [],
        next_command: null,
        refs: meta.key_alias !== null ? [formatVaultUri(meta.key_alias)] : [],
        opened: false,
        session_id: session.id,
      },
      options.json,
    );
    return;
  }

  const reason = outcome.reason;
  const session = touchSession(
    vendor,
    account,
    { state: "needs_human", reason, steps: [...playbook.humanSteps] },
    home,
  );

  let opened = false;
  if (!options.noOpen && playbook.signupUrl !== null && process.stdout.isTTY === true) {
    const opener = options.openUrl ?? noopOpener();
    opened = await opener(playbook.signupUrl);
  }

  printStartResult(
    {
      vendor,
      account,
      status: "needs_human",
      reason,
      signup_url: playbook.signupUrl,
      key_page_url: playbook.keyPageUrl,
      docs: playbook.docs,
      steps: [...playbook.humanSteps],
      next_command: `skeletonkey signup complete ${vendor} --account ${account}`,
      refs: [],
      opened,
      session_id: session.id,
    },
    options.json,
  );
}

function printStartResult(result: StartResultView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "bound") {
    console.log(`Signup bound for ${result.vendor} (account "${result.account}").`);
    console.log("status: bound");
    for (const ref of result.refs) console.log(`  ${ref}`);
    return;
  }
  console.log(
    `skeletonkey signup start: ${result.vendor} needs a human (reason: ${result.reason}).`,
  );
  console.log("status: needs_human");
  if (result.signup_url !== null) console.log(`Signup page: ${result.signup_url}`);
  if (result.key_page_url !== null) console.log(`Key page:    ${result.key_page_url}`);
  console.log(`Docs:        ${result.docs}`);
  if (result.opened) console.log("Opened the signup page in your browser.");
  console.log("Steps:");
  for (const step of result.steps) console.log(`  - ${step}`);
  console.log(`Once you have the key: ${result.next_command}`);
}

export interface SignupStatusRow {
  id: string;
  vendor: string;
  account: string;
  state: string;
  reason: string | null;
  created: string;
  updated: string;
}

function statusRow(session: SignupSession): SignupStatusRow {
  return {
    id: session.id,
    vendor: session.vendor,
    account: session.account,
    state: session.state,
    reason: session.reason,
    created: session.created,
    updated: session.updated,
  };
}

/** Data for `skeletonkey signup status [<vendor>]`. */
export function signupStatusRows(vendor: string | undefined, home = skeletonKeyHome()): SignupStatusRow[] {
  if (vendor === undefined) {
    return readSignups(home)
      .sessions.slice()
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .map(statusRow);
  }
  const normalized = vendor.trim().toLowerCase();
  requireVendor(normalized);
  return sessionsForVendor(normalized, home).map(statusRow);
}

export interface SignupCompleteOptions {
  account?: string;
  registered?: string;
  emailStdin: boolean;
  stdin: boolean;
  yes: boolean;
}

export async function cmdSignupComplete(
  vendorArg: string,
  options: SignupCompleteOptions,
  home = skeletonKeyHome(),
): Promise<void> {
  const vendor = vendorArg.trim().toLowerCase();
  const playbook = requireVendor(vendor);
  const account = options.account ?? defaultAccountName(vendor);

  const meta = await addAccount(
    account,
    {
      vendor,
      ...(options.registered === undefined ? {} : { registered: options.registered }),
      storeKey: true,
      domain: playbook.domain,
      platform: vendor,
      header: playbook.header ?? "",
      format: playbook.format ?? "{key}",
      injection: playbook.injection,
      storeLogin: false,
      emailStdin: options.emailStdin,
      stdin: options.stdin,
      yes: options.yes,
    },
    home,
  );

  touchSession(vendor, account, { state: "bound", reason: "complete", steps: [] }, home);

  console.log(`Bound a key for ${vendor} to account "${account}".`);
  console.log("status: bound");
  if (meta.key_alias !== null) {
    const ref = formatVaultUri(meta.key_alias);
    console.log(`  ${ref}`);
    console.log(`  skeletonkey run --env ${playbook.envHint}=${ref} -- <your command>`);
  }
}

export function cmdSignupAbandon(vendorArg: string, home = skeletonKeyHome()): void {
  const vendor = vendorArg.trim().toLowerCase();
  requireVendor(vendor);
  const sessions = sessionsForVendor(vendor, home);
  if (sessions.length === 0) {
    throw new SkeletonKeyError(
      "entry_not_found",
      `No signup session for "${vendor}".`,
      "List sessions with `skeletonkey signup status`.",
    );
  }
  const latest = sessions[0]!;
  const updated: SignupSession = {
    ...latest,
    state: "abandoned",
    reason: "abandoned",
    updated: new Date().toISOString(),
  };
  upsertSession(updated, home);
  console.log(`Abandoned the signup session for ${vendor} (account "${updated.account}").`);
}
