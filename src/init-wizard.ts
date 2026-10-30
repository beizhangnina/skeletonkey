/**
 * The interactive `skeletonkey init` wizard (v0.3).
 *
 * Six steps, each one ticked off as it completes, run only when stdin is a TTY
 * and `--yes` was not passed. Every existing flag still works: anything given
 * on the command line is accepted as already answered, and `--yes` or a
 * non-TTY stdin takes the old straight-line path instead (that is the CI
 * contract -- see `cmdInit`).
 *
 *   1. Email        -- the bound address every vendor account is filed under.
 *                      **The one required step**: there is nothing to bind
 *                      accounts to without it, so it re-asks until it has one.
 *   2. Bitwarden    -- recommended, and skippable. Detect `bw`, print the
 *                      install lines, point at the signup page -- and when it
 *                      is not ready offer three ways on: set it up now (and
 *                      re-check), take the `encrypted-file` vault instead, or
 *                      leave it for later. The last two still finish `init`.
 *   3. Inbox        -- coming soon (v0.5); announced and skipped.
 *   4. Spend caps   -- optional; skipped leaves every cap at $0.
 *   5. Card         -- optional, existence of one Bitwarden item, never read.
 *   6. Agents       -- register the MCP server with Claude Code and Codex.
 *
 * Only step 1 is mandatory. Every other step can be deferred, and the closing
 * summary splits what is set up from what is deferred, printing under each
 * deferred line the exact command that finishes it (`FINISH_COMMANDS`, each one
 * a real verb in `src/cli.ts`). The wizard itself never refuses to finish
 * because `bw` is unusable; the only path that still refuses is the explicit
 * non-interactive one (`--backend bitwarden` with no TTY -- see `cmdInit`),
 * where there is no human to offer the choice to.
 *
 * Two invariants are enforced here rather than merely documented:
 *
 *   - **No password is ever requested.** `ask()` refuses to put a question
 *     containing "password", "passphrase", "CVV", "card number", "API key" or
 *     "secret" to the human. `bw login` and `bw unlock` are run by the human in
 *     their own terminal; the only thing that comes back is `BW_SESSION`.
 *   - **The card number is never read.** Step 5 looks at item *names* only
 *     (`cardItemPresent`), so no card value reaches a variable that is printed,
 *     logged, or returned.
 *
 * Everything the wizard touches outside this process -- the prompt, stdout,
 * `bw`, the browser -- arrives as a dependency, so the tests drive it with
 * fakes and a temp home and never talk to a real vault.
 */
import { capsUnset, readPolicy, setCaps, type SpendPolicy } from "./policy.js";
import {
  bwAccountStatus,
  bwGuidance,
  childProcessBw,
  type BwAccount,
  type BwRunner,
} from "./vault/bw-account.js";
import { noopOpener, type UrlOpener } from "./open-url.js";
import { PUBLIC_BACKENDS, resolveBackendId, type BackendId } from "./types.js";

/** The human creates the account themselves; SkeletonKey only opens the page. */
export const BITWARDEN_REGISTER_URL = "https://vault.bitwarden.com/#/register";

/** The one card item the runner will ever look for (existence only). */
export const CARD_ITEM_NAME = "skeletonkey: card";

/** What step 2 offers instead of Bitwarden: no install, no account, no sync. */
export const BITWARDEN_FALLBACK_BACKEND: BackendId = "encrypted-file";

/**
 * The commands the summary prints under each deferred item. Every one of these
 * is a real command in `src/cli.ts`, and `test/init-wizard.test.ts` resolves
 * each of them against the actual command tree so a rename cannot leave the
 * wizard handing out a verb that does not exist.
 */
export const FINISH_COMMANDS = {
  bitwarden: "skeletonkey bitwarden status",
  caps: "skeletonkey policy set --global <usd>",
  card: "skeletonkey init --force",
  agents: "skeletonkey register",
} as const;

export const WIZARD_STEPS = 6;

export const TICK = "✔";
export const SKIPPED = "—";
export const TODO = "!";

/** How many times a step re-asks before giving up on a malformed answer. */
const MAX_ATTEMPTS = 5;
/** How many "press Enter and I will re-check" rounds Bitwarden gets. */
const MAX_RECHECKS = 20;
/** Upper bound on per-vendor caps collected in one wizard run. */
const MAX_VENDOR_CAPS = 20;

/**
 * Anything matching this must never be put to the human as a question. The
 * wizard collects no secret of any kind: the vault CLIs prompt for their own
 * unlock, and key/card/CVV values are collected by the runner's Secure Input
 * Popup or read straight from Bitwarden.
 */
const SECRET_QUESTION =
  /pass(word|phrase|code)|master\s*key|card\s*(number|no\b)|\bcvv\b|\bcvc\b|security\s*code|api[\s_-]*(key|token|secret)|\bsecret\b|\bpin\b/i;

export interface WizardIo {
  /** Asks one question. `fallback` is the answer an empty line means. */
  prompt(question: string, fallback?: string): Promise<string>;
  /** One line of wizard output. */
  print(line: string): void;
}

export interface WizardDeps {
  io: WizardIo;
  /** `bw` invocation seam. Reads only; never given a password. */
  bw: BwRunner;
  openUrl: UrlOpener;
}

/** The real dependencies, for a CLI run. */
export function wizardDeps(
  io: WizardIo,
  overrides: Partial<Omit<WizardDeps, "io">> = {},
): WizardDeps {
  return {
    io,
    bw: overrides.bw ?? childProcessBw(),
    openUrl: overrides.openUrl ?? noopOpener(),
  };
}

/** The answers already on the command line, so the wizard does not re-ask. */
export interface WizardAnswers {
  email?: string;
  backend?: string;
}

export interface WizardPlan {
  /** SKELETONKEY_HOME for this run. */
  home: string;
  answers: WizardAnswers;
  /**
   * Writes config.yaml, keys.yaml and the ledger, checks the chosen vault, and
   * returns where secrets will live. Called once, after step 2.
   */
  commit(input: { email: string; backend: BackendId }): Promise<string>;
  /** Step 6: the existing registration logic. Returns one summary line. */
  register(): Promise<string | { summary: string; deferred: boolean }>;
  /** `--no-register`: step 6 is announced and skipped. */
  registerSkipped?: boolean;
}

export interface WizardResult {
  email: string;
  backend: BackendId;
  /** Where secrets will live, as the vault reports it. */
  location: string;
  bitwarden: BwAccount | null;
  /** True when step 2 moved the vault off Bitwarden at the human's request. */
  switchedVault: boolean;
  caps: CapsOutcome;
  card: CardOutcome;
  /** The step-6 summary line. */
  agents: string;
  /** True when step 6 was announced and skipped (`--no-register`). */
  agentsDeferred: boolean;
}

// --- shared helpers -------------------------------------------------------

function header(io: WizardIo, index: number, title: string): void {
  io.print("");
  io.print(`Step ${index}/${WIZARD_STEPS}  ${title}`);
}

function tick(io: WizardIo, text: string): void {
  io.print(`  ${TICK} ${text}`);
}

function skipped(io: WizardIo, text: string): void {
  io.print(`  ${SKIPPED} ${text}`);
}

function todo(io: WizardIo, text: string): void {
  io.print(`  ${TODO} ${text}`);
}

/** Throws when a question would collect a secret. */
export function assertNotSecret(question: string): void {
  if (!SECRET_QUESTION.test(question)) return;
  throw new Error(
    `The init wizard must never ask for a secret, and ${JSON.stringify(question)} does. ` +
      "Master passwords are typed into `bw` by the human; keys, card numbers and CVVs are " +
      "collected by the runner's Secure Input Popup or read from Bitwarden.",
  );
}

/**
 * The only way this file asks the human anything. Refuses outright to ask for
 * a password or any other secret, so the invariant cannot be lost to a later
 * edit that reaches for `io.prompt` directly.
 */
export async function ask(
  deps: WizardDeps,
  question: string,
  fallback?: string,
): Promise<string> {
  assertNotSecret(question);
  return deps.io.prompt(question, fallback);
}

/**
 * `ask` for a question with untrusted text spliced into its `{}` -- a vendor
 * name the human just typed, an item name from a flag. Only the *template* is
 * checked for secret wording: a vendor legitimately called "Password Manager
 * Co" must not trip the guard, and nothing the human typed can slip a secret
 * question past it either, because the template is fixed in this file.
 */
async function askAbout(
  deps: WizardDeps,
  template: string,
  insert: string,
  fallback?: string,
): Promise<string> {
  assertNotSecret(template);
  return deps.io.prompt(template.replace("{}", insert), fallback);
}

function isSkip(answer: string): boolean {
  return /^(skip|s|no?|none)$/i.test(answer.trim());
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// --- step 1: email --------------------------------------------------------

/**
 * The bound email: the address every vendor account, password reset and
 * billing notice is filed under, and the one vendor lookups match on. A
 * dedicated address is recommended out loud, because mixing this with a
 * personal inbox is the thing people regret.
 *
 * **The only mandatory step.** There is nothing to file accounts under without
 * it, so a blank or malformed answer is re-asked rather than accepted, and a
 * run that never produces one fails instead of writing half a config.
 */
export async function stepEmail(deps: WizardDeps, answers: WizardAnswers): Promise<string> {
  header(deps.io, 1, "Email");
  const given = answers.email?.trim() ?? "";
  if (given !== "") {
    if (!isEmail(given)) throw new Error(`${JSON.stringify(given)} does not look like an email address.`);
    tick(deps.io, `bound email ${given} (from --email)`);
    return given;
  }
  deps.io.print("  This is the one answer `init` cannot do without; every step after it can be");
  deps.io.print("  deferred, and the summary will tell you how to finish each one later.");
  deps.io.print("  Recommended: a brand-new address used only for API signups, e.g.");
  deps.io.print("    apis@yourdomain.com  (or a free mailbox you make just for this)");
  deps.io.print("  Vendor mail, password resets and billing notices then stay out of your main");
  deps.io.print("  inbox, and `+aliases` (apis+tikhub@...) tell you who leaked the address.");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = await ask(deps, "  Dedicated email for API signups: ");
    if (isEmail(answer)) {
      const email = answer.trim();
      tick(deps.io, `bound email ${email}`);
      return email;
    }
    deps.io.print(`  ${TODO} ${JSON.stringify(answer)} does not look like an email address.`);
  }
  throw new Error("No usable email address was given, so there is nothing to bind accounts to.");
}

// --- step 2: Bitwarden ----------------------------------------------------

export interface VaultOutcome {
  backend: BackendId;
  /** The Bitwarden state, or null when another backend was chosen up front. */
  bitwarden: BwAccount | null;
  /** True when the human chose to carry on without an unlocked `bw`. */
  deferred: boolean;
  /** True when the human took `encrypted-file` instead of Bitwarden here. */
  switched: boolean;
}

/** What the human picked at the "Bitwarden is not ready" fork. */
export type VaultChoice = "bitwarden" | "encrypted-file" | "later";

/**
 * Picks the backend (Bitwarden unless `--backend` says otherwise) and, for
 * Bitwarden, walks the human from "not installed" to "unlocked".
 *
 * Recommended, **not** required. When `bw` is not ready the human is given
 * three ways on -- set it up now and re-check, take the `encrypted-file` vault
 * instead, or leave it for later -- and the last two still finish `init`.
 * Nothing in the wizard aborts the run because `bw` is unusable.
 *
 * Nothing here logs in, unlocks, or asks for the master password. The install
 * lines, the `bw login` line and the `bw unlock` line are printed for the
 * human to run in their own terminal; the wizard only re-reads `bw status`.
 */
export async function stepBitwarden(
  deps: WizardDeps,
  options: { email: string; backend?: string },
): Promise<VaultOutcome> {
  header(deps.io, 2, "Bitwarden (recommended, skippable)");
  const requested = options.backend?.trim() ?? "";
  const backend = await chooseBackend(deps, requested);
  if (backend !== "bitwarden") {
    skipped(deps.io, `backend ${backend}: no Bitwarden CLI needed`);
    return { backend, bitwarden: null, deferred: false, switched: false };
  }

  let status = await bwAccountStatus({ bound: options.email, bw: deps.bw });
  if (status.state === "not-installed") {
    deps.io.print("  The `bw` CLI is not on PATH. Install it as yourself, with one of:");
    deps.io.print("    npm install -g @bitwarden/cli");
    deps.io.print("    brew install bitwarden-cli          # macOS / Linuxbrew");
    deps.io.print("    snap install bw                     # Linux");
    deps.io.print("    or download the binary from https://bitwarden.com/help/cli/");
  }
  if (!status.usable && (status.state === "not-installed" || status.state === "unauthenticated")) {
    await offerSignup(deps);
  }

  for (let round = 0; !status.usable && round < MAX_RECHECKS; round += 1) {
    deps.io.print(`  Bitwarden: ${status.summary}.`);
    for (const line of bwGuidance(status, options.email)) deps.io.print(`    ${line}`);
    const choice = await askVaultChoice(deps, round);
    if (choice === "encrypted-file") {
      if (requested !== "") {
        deps.io.print(
          `  Taking ${BITWARDEN_FALLBACK_BACKEND} instead of the \`--backend bitwarden\` you ` +
            "asked for -- you chose it just now, at this prompt.",
        );
      }
      tick(
        deps.io,
        `vault switched to ${BITWARDEN_FALLBACK_BACKEND}: AES-256-GCM under SKELETONKEY_HOME, ` +
          "nothing to install. Set Bitwarden up whenever you like with " +
          `\`${FINISH_COMMANDS.bitwarden}\`.`,
      );
      return {
        backend: BITWARDEN_FALLBACK_BACKEND,
        bitwarden: status,
        deferred: false,
        switched: true,
      };
    }
    if (choice === "later") {
      skipped(
        deps.io,
        "Bitwarden not ready. `init` finishes anyway; `skeletonkey add` and the proxy will " +
          `refuse with these same steps until it is, and \`${FINISH_COMMANDS.bitwarden}\` ` +
          "re-checks any time.",
      );
      return { backend, bitwarden: status, deferred: true, switched: false };
    }
    status = await bwAccountStatus({ bound: options.email, bw: deps.bw });
  }

  if (!status.usable) {
    skipped(
      deps.io,
      `Bitwarden still not ready after ${MAX_RECHECKS} checks: ${status.summary}. ` +
        `Finishing without it; \`${FINISH_COMMANDS.bitwarden}\` re-checks.`,
    );
    return { backend, bitwarden: status, deferred: true, switched: false };
  }
  tick(
    deps.io,
    `bw installed, logged in and unlocked${status.account === null ? "" : ` as ${status.account}`}`,
  );
  if (status.matchesBound === false) {
    for (const line of bwGuidance(status, options.email)) deps.io.print(`    ${line}`);
  }
  return { backend, bitwarden: status, deferred: false, switched: false };
}

/**
 * The fork a human reaches when `bw` is not ready: three ways on, none of them
 * a dead end. Pressing Enter means "I ran those lines, re-check" -- the
 * recommended path -- so the quickest answer is still the one that sets
 * Bitwarden up. An unparseable answer, five times over, is taken as "later"
 * rather than aborting a run that only ever needed an email address.
 */
async function askVaultChoice(deps: WizardDeps, round: number): Promise<VaultChoice> {
  if (round === 0) {
    deps.io.print("  Only your email is required, so this step has three ways on:");
    deps.io.print("    1) set Bitwarden up now -- run the lines above, then I re-check (recommended)");
    deps.io.print(
      `    2) use the ${BITWARDEN_FALLBACK_BACKEND} vault instead -- AES-256-GCM under ` +
        "SKELETONKEY_HOME, nothing to install",
    );
    deps.io.print("    3) skip for now -- `init` finishes, and the summary says how to come back");
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = (
      await ask(
        deps,
        "  Press Enter once you have run those and I will re-check, or [2] " +
          `${BITWARDEN_FALLBACK_BACKEND} instead / [3] skip for now: `,
        "1",
      )
    ).trim();
    if (/^(1|recheck|re-check|retry|again|bitwarden|bw|y|yes)$/i.test(answer)) return "bitwarden";
    if (/^(2|encrypted|encrypted-file|encrypted_file|encryptedfile)$/i.test(answer)) {
      return "encrypted-file";
    }
    if (/^(3|later)$/i.test(answer) || isSkip(answer)) return "later";
    deps.io.print(`  ${TODO} ${JSON.stringify(answer)} is not 1, 2 or 3.`);
  }
  deps.io.print(`  ${TODO} Taking that as "skip for now".`);
  return "later";
}

/**
 * "Do you have a Bitwarden account?" -- and if not, the signup page, opened
 * best-effort and always printed. The human signs up themselves: SkeletonKey
 * submits no form and never learns the master password they choose.
 */
async function offerSignup(deps: WizardDeps): Promise<void> {
  const answer = await ask(deps, "  Do you already have a Bitwarden account? [Y/n]: ", "y");
  if (!/^n/i.test(answer.trim())) return;
  deps.io.print("  Create one yourself -- it is free and covers unlimited devices:");
  deps.io.print(`    ${BITWARDEN_REGISTER_URL}`);
  const opened = await deps.openUrl(BITWARDEN_REGISTER_URL);
  deps.io.print(
    opened
      ? "  Opened that page in your browser."
      : "  Could not open a browser here -- copy the URL above.",
  );
  deps.io.print(
    "  Pick your own master password. SkeletonKey never asks for it, never stores it, and " +
      "never passes it to anything.",
  );
  await ask(deps, "  Press Enter once the account exists: ", "");
}

async function chooseBackend(deps: WizardDeps, given?: string): Promise<BackendId> {
  const requested = given?.trim() ?? "";
  if (requested !== "") {
    const resolved = resolveBackendId(requested);
    if (resolved === null) {
      throw new Error(
        `Unknown backend ${JSON.stringify(requested)}. Expected one of ${PUBLIC_BACKENDS.join(", ")}.`,
      );
    }
    return resolved;
  }
  deps.io.print("  Where should secrets live?");
  deps.io.print("    1) bitwarden       `bw` CLI -- free, unlimited devices, syncs (default)");
  deps.io.print("    2) 1password       1Password items via the `op` CLI");
  deps.io.print("    3) keychain        macOS login keychain, or libsecret on Linux");
  deps.io.print("    4) encrypted-file  AES-256-GCM file under SKELETONKEY_HOME (zero install)");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = await ask(deps, "  Backend [1/2/3/4 or name] (1): ", "1");
    const byNumber = { "1": "bitwarden", "2": "1password", "3": "keychain", "4": "encrypted-file" }[
      answer.trim()
    ];
    const resolved = resolveBackendId(byNumber ?? answer);
    if (resolved !== null) return resolved;
    deps.io.print(
      `  ${TODO} Unknown backend ${JSON.stringify(answer)}. Expected one of ${PUBLIC_BACKENDS.join(", ")}.`,
    );
  }
  skipped(deps.io, "No backend chosen; keeping the Bitwarden default. You can skip its setup next.");
  return "bitwarden";
}

// --- step 3: inbox --------------------------------------------------------

/**
 * Binding a mailbox so the runner can read an email OTP itself lands in v0.5
 * (`src/secrets/inbox.ts` already carries the interface and the filters). Said
 * out loud and skipped rather than quietly left out.
 */
export function stepInbox(deps: WizardDeps): { skipped: true; note: string } {
  header(deps.io, 3, "Inbox connect");
  const note = "inbox connect: coming soon, skipped";
  deps.io.print("  Coming soon (v0.5): bind this mailbox so the runner can read a vendor's");
  deps.io.print("  verification code itself, filtered to that vendor's domain and a short");
  deps.io.print("  time window. Until then the runner asks you for the code in its Secure");
  deps.io.print("  Input Popup, and no agent is ever asked to read your mail instead.");
  skipped(deps.io, note);
  return { skipped: true, note };
}

// --- step 4: spend caps ---------------------------------------------------

export interface CapsOutcome {
  policy: SpendPolicy;
  /** True when the human set at least one cap and it was written. */
  wrote: boolean;
  skipped: boolean;
  /** One line for the summary screen. */
  summary: string;
}

/**
 * The global monthly cap and any per-vendor caps. Skippable, and a blank
 * answer keeps the $0 default (D11: no number is ever preset).
 *
 * Written through `setCaps(..., { by: "cli" })` -- the same human-only path
 * `skeletonkey policy set` uses. There is deliberately no second writer: an
 * agent cannot reach this, and the wizard does not invent one.
 */
export async function stepSpendCaps(deps: WizardDeps, home: string): Promise<CapsOutcome> {
  header(deps.io, 4, "Spend caps");
  deps.io.print("  Every cap starts at $0, so nothing can be spent until you set one. Agents can");
  deps.io.print("  never raise them: only this wizard, `skeletonkey policy set`, and the approval");
  deps.io.print("  page write policy.yaml. Blank keeps $0.");

  const global = await askAmount(
    deps,
    '  Global monthly cap in USD (blank keeps $0, "skip" to skip this step): ',
  );
  if (global === "skip") {
    const policy = readPolicy(home);
    const summary = "spend caps left at $0 (skipped)";
    skipped(deps.io, summary);
    return { policy, wrote: false, skipped: true, summary };
  }

  const vendors: { vendor: string; cap: number }[] = [];
  for (let index = 0; index < MAX_VENDOR_CAPS; index += 1) {
    const vendor = await ask(deps, "  Per-vendor cap -- vendor name (blank to finish): ", "");
    if (vendor.trim() === "" || isSkip(vendor)) break;
    const cap = await askAmount(deps, "  Monthly cap for {} in USD (blank skips it): ", vendor.trim());
    if (cap === "skip" || cap === null) continue;
    vendors.push({ vendor: vendor.trim(), cap });
  }

  if (global === null && vendors.length === 0) {
    const policy = readPolicy(home);
    const summary = "spend caps left at $0 -- the first paid action will ask you to set them";
    skipped(deps.io, summary);
    return { policy, wrote: false, skipped: false, summary };
  }

  // One human-authority write per cap; `setCaps` reads, merges and re-writes.
  let policy = readPolicy(home);
  if (global !== null) {
    policy = setCaps({ global_monthly_cap_usd: global }, { by: "cli" }, home);
  }
  for (const entry of vendors) {
    policy = setCaps({ vendor: entry.vendor, vendor_cap_usd: entry.cap }, { by: "cli" }, home);
  }
  const summary = describeCaps(policy);
  tick(deps.io, summary);
  if (capsUnset(policy)) {
    todo(deps.io, "Everything is still $0, so the first paid action will ask you again.");
  }
  return { policy, wrote: true, skipped: false, summary };
}

export function describeCaps(policy: SpendPolicy): string {
  const vendors = Object.entries(policy.vendor_caps_usd);
  const parts = [`global $${policy.global_monthly_cap_usd}/month`];
  for (const [vendor, cap] of vendors) parts.push(`${vendor} $${cap}`);
  return parts.join("; ");
}

/**
 * A non-negative dollar amount, `null` for blank, `"skip"` for skip. `insert`
 * is untrusted text for the `{}` in `question`, when there is one.
 */
async function askAmount(
  deps: WizardDeps,
  question: string,
  insert?: string,
): Promise<number | null | "skip"> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = (
      insert === undefined
        ? await ask(deps, question, "")
        : await askAbout(deps, question, insert, "")
    ).trim();
    if (answer === "") return null;
    if (/^(skip|s)$/i.test(answer)) return "skip";
    const amount = Number(answer.replace(/^\$/, ""));
    if (Number.isFinite(amount) && amount >= 0) return amount;
    deps.io.print(`  ${TODO} ${JSON.stringify(answer)} is not a number of dollars.`);
  }
  return null;
}

// --- step 5: card ---------------------------------------------------------

export interface CardOutcome {
  present: boolean;
  skipped: boolean;
  itemName: string;
  summary: string;
}

/**
 * The payment card. v0.3 pays for nothing; when payments land it is **one**
 * card item in the human's own Bitwarden vault (D12: no virtual cards), read
 * by the runner in memory and typed into the vendor's own checkout.
 *
 * So this step explains how to create that item **in Bitwarden's own app** and
 * then checks only that an item with the name exists. The number, the CVV and
 * the expiry are never read, never printed and never returned -- see
 * `cardItemPresent`.
 */
export async function stepCard(
  deps: WizardDeps,
  options: { bitwarden: BwAccount | null; itemName?: string } = { bitwarden: null },
): Promise<CardOutcome> {
  const itemName = options.itemName ?? CARD_ITEM_NAME;
  header(deps.io, 5, "Payment card (optional)");
  deps.io.print("  v0.3 pays for nothing. When payments land, the runner reads one card item");
  deps.io.print("  from your own Bitwarden vault, in memory, and types it into the vendor's own");
  deps.io.print("  checkout -- after you approve the amount against your caps.");
  deps.io.print("  Create it yourself, in the Bitwarden app or web vault:");
  deps.io.print("    New item -> type `Card` -> name it exactly:");
  deps.io.print(`      ${itemName}`);
  deps.io.print("  SkeletonKey only ever checks that this item exists. It does not read, print or");
  deps.io.print("  log the number, and there is no MCP tool and no runner verb that can.");

  const answer = await askAbout(deps, '  Check whether "{}" exists now? [Y/n]: ', itemName, "y");
  if (/^n/i.test(answer.trim()) || /^(skip|s)$/i.test(answer.trim())) {
    const summary = "card check skipped";
    skipped(deps.io, summary);
    return { present: false, skipped: true, itemName, summary };
  }
  if (options.bitwarden !== null && !options.bitwarden.usable) {
    const summary = `could not look for "${itemName}": ${options.bitwarden.summary}`;
    skipped(deps.io, summary);
    return { present: false, skipped: true, itemName, summary };
  }
  const present = await cardItemPresent(deps.bw, itemName);
  const summary = present
    ? `Bitwarden item "${itemName}" exists (name only -- no value was read)`
    : `no Bitwarden item named "${itemName}" yet; create it when you want payments`;
  if (present) tick(deps.io, summary);
  else todo(deps.io, summary);
  return { present, skipped: false, itemName, summary };
}

/**
 * Does an item with exactly this name exist?
 *
 * `bw list items` returns whole items, so the card number is in the JSON this
 * function parses. Only `name` is ever looked at, and nothing but a boolean
 * leaves the function: no value can be printed, logged or returned by
 * accident. The runner reads the actual card at payment time, in memory.
 */
export async function cardItemPresent(bw: BwRunner, itemName = CARD_ITEM_NAME): Promise<boolean> {
  let result;
  try {
    result = await bw(["list", "items", "--search", itemName]);
  } catch {
    return false;
  }
  if (result.code !== 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((item) => {
    const name = (item as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim() === itemName;
  });
}

// --- step 6 + summary -----------------------------------------------------

/** Step 6 is the existing registration logic; the wizard only frames it. */
async function stepAgents(
  deps: WizardDeps,
  plan: WizardPlan,
): Promise<{ summary: string; deferred: boolean }> {
  header(deps.io, 6, "Register with Claude Code / Codex");
  if (plan.registerSkipped === true) {
    const note = `agent registration skipped (--no-register); run \`${FINISH_COMMANDS.agents}\` later`;
    skipped(deps.io, note);
    return { summary: note, deferred: true };
  }
  const outcome = await plan.register();
  const result = typeof outcome === "string"
    ? { summary: outcome, deferred: false }
    : outcome;
  if (result.deferred) skipped(deps.io, result.summary);
  else tick(deps.io, result.summary);
  return result;
}

/** One line of the summary screen. */
export interface SummaryLine {
  glyph: string;
  label: string;
  detail: string;
  /**
   * The exact command that finishes this item later, or null when there is
   * nothing to run (a set-up item).
   */
  command: string | null;
}

/**
 * The summary, split into what is set up and what is deferred.
 *
 * Every deferred line carries the command that finishes it, so the human never
 * has to go looking: Bitwarden re-checks with `skeletonkey bitwarden status`,
 * caps move with `skeletonkey policy set`, the card item is re-checked by
 * re-running the wizard (`skeletonkey init --force` -- v0.3 has no `card`
 * verb), and agent registration is `skeletonkey register`. Inbox connect is listed separately as
 * coming soon: it has no command until v0.5.
 */
export function summarySections(result: WizardResult): {
  set: SummaryLine[];
  deferred: SummaryLine[];
} {
  const set: SummaryLine[] = [
    { glyph: TICK, label: "email", detail: result.email, command: null },
    {
      glyph: TICK,
      label: "vault",
      detail: `${result.backend} -- ${result.location}`,
      command: null,
    },
  ];
  const deferred: SummaryLine[] = [];

  // Omitted entirely when the backend was never Bitwarden: the vault line
  // above has already said where secrets live.
  if (result.bitwarden !== null) {
    if (result.bitwarden.usable) {
      set.push({
        glyph: TICK,
        label: "bitwarden",
        detail: "installed, logged in, unlocked",
        command: null,
      });
    } else {
      deferred.push({
        glyph: result.switchedVault ? SKIPPED : TODO,
        label: "bitwarden",
        detail: result.switchedVault
          ? `not needed by the ${result.backend} vault -- set it up when you want the card item`
          : result.bitwarden.summary,
        command: FINISH_COMMANDS.bitwarden,
      });
    }
  }

  if (result.caps.wrote) {
    set.push({ glyph: TICK, label: "spend caps", detail: result.caps.summary, command: null });
  } else {
    deferred.push({
      glyph: SKIPPED,
      label: "spend caps",
      detail: "every cap is still $0, so nothing can be spent",
      command: FINISH_COMMANDS.caps,
    });
  }

  if (result.card.present) {
    set.push({ glyph: TICK, label: "card", detail: result.card.summary, command: null });
  } else {
    deferred.push({
      glyph: result.card.skipped ? SKIPPED : TODO,
      label: "card",
      // "skipped" on its own says nothing about what finishing it means, so
      // the deferred line spells out the one thing the human has to do first.
      detail: result.card.skipped
        ? `not checked -- create "${result.card.itemName}" in Bitwarden when you want payments`
        : result.card.summary,
      command: FINISH_COMMANDS.card,
    });
  }

  if (result.agentsDeferred) {
    deferred.push({
      glyph: SKIPPED,
      label: "agents",
      detail: result.agents,
      command: FINISH_COMMANDS.agents,
    });
  } else {
    set.push({ glyph: TICK, label: "agents", detail: result.agents, command: null });
  }

  return { set, deferred };
}

/** The end-of-run screen: what is set up, what is deferred, and what to run. */
export function printSummary(io: WizardIo, result: WizardResult): void {
  const { set, deferred } = summarySections(result);
  const width = Math.max(...[...set, ...deferred].map((row) => row.label.length));
  io.print("");
  io.print("Summary");
  io.print("  Set up");
  for (const row of set) io.print(`    ${row.glyph} ${row.label.padEnd(width)}  ${row.detail}`);
  if (deferred.length > 0) {
    io.print("");
    io.print("  Deferred -- not required now; under each line is the command that finishes it");
    for (const row of deferred) {
      io.print(`    ${row.glyph} ${row.label.padEnd(width)}  ${row.detail}`);
      if (row.command !== null) io.print(`        ${row.command}`);
    }
  }
  io.print("");
  io.print("  Coming soon: inbox connect (v0.5) -- nothing to run yet");
  io.print("");
  io.print("Next:");
  io.print("  skeletonkey runner      # approvals, spend caps, secure input, secrets");
  io.print("  skeletonkey proxy       # the injecting proxy your calls go through");
  io.print("  skeletonkey policy show # the caps, any time");
  io.print("  Restart Claude Code / Codex so they pick the MCP server up.");
}

/** Runs all six steps in order and prints the summary. */
export async function runInitWizard(
  deps: WizardDeps,
  plan: WizardPlan,
): Promise<WizardResult> {
  deps.io.print(`SkeletonKey init -- ${WIZARD_STEPS} steps. Ctrl-C quits; nothing is written yet.`);
  deps.io.print("Only step 1 (your email) is required. Anything else can be deferred, and the");
  deps.io.print("summary ends with the exact command that finishes each deferred item.");
  const email = await stepEmail(deps, plan.answers);
  const vault = await stepBitwarden(deps, {
    email,
    ...(plan.answers.backend === undefined ? {} : { backend: plan.answers.backend }),
  });
  const location = await plan.commit({ email, backend: vault.backend });
  stepInbox(deps);
  const caps = await stepSpendCaps(deps, plan.home);
  const card = await stepCard(deps, { bitwarden: vault.bitwarden });
  const agents = await stepAgents(deps, plan);
  const result: WizardResult = {
    email,
    backend: vault.backend,
    location,
    bitwarden: vault.bitwarden,
    switchedVault: vault.switched,
    caps,
    card,
    agents: agents.summary,
    agentsDeferred: agents.deferred,
  };
  printSummary(deps.io, result);
  return result;
}
