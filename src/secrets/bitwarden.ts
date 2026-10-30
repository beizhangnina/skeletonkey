/**
 * Rung 1 of the ladder: Bitwarden, automatic, no human prompt.
 *
 * Talks to the `bw` CLI through `child_process` (the same `run` helper the
 * vault backend uses: arguments only, secrets on stdin, never in argv). The
 * command runner is injectable so the test suite can drive a fake `bw` without
 * installing one.
 *
 * Two ways to find a value:
 *
 *   - the item SkeletonKey itself wrote, `skeletonkey: <alias>`;
 *   - the vendor's own item, found by the bound email plus the vendor's
 *     domain, for an account the human created before SkeletonKey existed.
 *
 * Unlocking is never attempted: a locked or logged-out `bw` is reported as
 * "cannot answer", with the commands the human runs themselves, and the ladder
 * moves on. The master password is never asked for, read, or passed anywhere.
 */
import {
  bwAccountStatus,
  bwGuidance,
  childProcessBw,
  findVendorItems,
  type BwAccount,
  type BwRunner,
} from "../vault/bw-account.js";
import type { SecretClass, SecretRequest, SecretResolution, SecretSource } from "./types.js";

export type { BwRunResult, BwRunner } from "../vault/bw-account.js";
export { childProcessBw } from "../vault/bw-account.js";

interface BwItem {
  id?: string;
  name?: string;
  login?: { password?: string | null; username?: string | null };
  card?: {
    number?: string | null;
    code?: string | null;
    expMonth?: string | null;
    expYear?: string | null;
  };
}

const ITEM_PREFIX = "skeletonkey: ";

export interface BitwardenSecretOptions {
  cardItemName?: string;
  /** Bound email: vendor items are only accepted when they carry it. */
  boundEmail?: string | null;
  /**
   * Called once, the first time `bw` cannot answer because it is missing,
   * logged out or locked, with the guided prompt for the human. Lines contain
   * no values and no master password -- they are commands to run.
   */
  onGuidance?: (lines: string[], status: BwAccount) => void;
}

/**
 * Reads the card, an existing vendor login, or a generated password that was
 * saved to `bw` before submit. Unlocking is always a human action: a locked
 * vault is reported as "cannot answer", never worked around.
 */
export class BitwardenSecretSource implements SecretSource {
  readonly id = "bitwarden" as const;
  private detail: string | null = null;
  private guidanceGiven = false;

  constructor(
    private readonly bw: BwRunner = childProcessBw(),
    private readonly options: BitwardenSecretOptions = {},
  ) {}

  handles(secretClass: SecretClass): boolean {
    return secretClass !== "otp";
  }

  lastDetail(): string | null {
    return this.detail;
  }

  /** `unlocked` | `locked` | `unauthenticated` | `unavailable`. */
  async state(): Promise<string> {
    const status = await this.account();
    return status.state === "not-installed" || status.state === "unknown"
      ? "unavailable"
      : status.state;
  }

  /** Installed / logged in / unlocked, and whether it is the bound account. */
  async account(): Promise<BwAccount> {
    return bwAccountStatus({ bound: this.options.boundEmail ?? null, bw: this.bw });
  }

  async resolve(request: SecretRequest): Promise<SecretResolution | null> {
    this.detail = null;
    if (!this.handles(request.class)) {
      this.detail = "Bitwarden does not hold email OTPs.";
      return null;
    }
    const status = await this.account();
    if (!status.usable) {
      this.detail =
        status.state === "locked"
          ? "Bitwarden is locked. Unlocking is a human action (`bw unlock`); the ladder moves on."
          : status.state === "unauthenticated"
            ? "Bitwarden is not logged in (`bw login`); the ladder moves on."
            : "The `bw` CLI is not available here; the ladder moves on.";
      // First secret use with an unusable `bw`: hand the human the steps once.
      this.giveGuidance(status);
      return null;
    }

    if (request.class === "card_number" || request.class === "card_cvv" || request.class === "card_expiry") {
      return this.fromCard(request);
    }
    return this.fromLogin(request, status);
  }

  private giveGuidance(status: BwAccount): void {
    if (this.guidanceGiven || this.options.onGuidance === undefined) return;
    this.guidanceGiven = true;
    this.options.onGuidance(bwGuidance(status), status);
  }

  private async fromCard(request: SecretRequest): Promise<SecretResolution | null> {
    const name = this.options.cardItemName ?? `${ITEM_PREFIX}card`;
    const item = await this.findItem(name);
    if (item === null) {
      this.detail = `No Bitwarden card item named "${name}" was found; the ladder moves on.`;
      return null;
    }
    const card = item.card ?? {};
    const value =
      request.class === "card_number"
        ? card.number
        : request.class === "card_cvv"
          ? card.code
          : joinExpiry(card.expMonth, card.expYear);
    if (typeof value !== "string" || value.trim() === "") {
      this.detail =
        `The Bitwarden card item "${name}" has no ${request.class.replace("card_", "")} stored; ` +
        "the ladder moves on to the Secure Input Popup.";
      return null;
    }
    return {
      source: "bitwarden",
      value: value.trim(),
      detail: `Read ${request.class} from the Bitwarden card item "${name}". No human was prompted.`,
    };
  }

  private async fromLogin(
    request: SecretRequest,
    status: BwAccount,
  ): Promise<SecretResolution | null> {
    const alias = request.alias ?? request.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const name = `${ITEM_PREFIX}${alias}`;
    const item = await this.findItem(name);
    const password = item?.login?.password;
    if (typeof password === "string" && password !== "") {
      return {
        source: "bitwarden",
        value: password,
        detail: `Read ${request.class} from the Bitwarden login item "${name}". No human was prompted.`,
      };
    }
    const byAccount = await this.fromVendorAccount(request, status);
    if (byAccount !== null) return byAccount;
    this.detail =
      `No Bitwarden login item named "${name}" with a password` +
      `${this.detail === null ? "" : `, and ${this.detail}`}; the ladder moves on.`;
    return null;
  }

  /**
   * The account the human made themselves: searched by the vendor's domain and
   * accepted only when the item carries the bound email (§A). An item for a
   * different mailbox is never read, which is what stops a lookalike entry in
   * the vault from answering for the real vendor.
   */
  private async fromVendorAccount(
    request: SecretRequest,
    status: BwAccount,
  ): Promise<SecretResolution | null> {
    const domain = request.domain ?? hostOf(request.origin);
    const bound = this.options.boundEmail ?? null;
    if (domain === null || bound === null || bound === "") {
      this.detail =
        bound === null || bound === ""
          ? "no bound email is configured, so the vendor's own item could not be matched"
          : "no vendor domain was given, so the vendor's own item could not be looked up";
      return null;
    }
    // `status` is already in hand, so this does not run `bw status` again.
    const lookup = await findVendorItems({ domain, bound, bw: this.bw, account: status });
    const wanted = request.class === "api_key" ? "api_key" : "password";
    const hit = lookup.items.find((item) =>
      wanted === "api_key" ? item.api_key !== null : item.password !== null,
    );
    if (hit === undefined) {
      this.detail =
        lookup.items.length === 0
          ? `no Bitwarden item for ${bound} matches ${domain}`
          : `${lookup.items.length} Bitwarden item(s) for ${bound} match ${domain}, but none has a ${wanted}`;
      return null;
    }
    const value = wanted === "api_key" ? hit.api_key : hit.password;
    if (value === null) return null;
    return {
      source: "bitwarden",
      value,
      detail:
        `Read ${request.class} from the Bitwarden item "${hit.name}" (${hit.id}), matched by the ` +
        `bound email ${bound} in the item ${hit.email_match} and ${domain} from the item ` +
        `${hit.domain_match}${hit.api_key_field === null ? "" : `, field "${hit.api_key_field}"`}. ` +
        "No human was prompted.",
    };
  }

  /** Generated passwords are saved to `bw` *before* they are typed anywhere. */
  async savePassword(alias: string, secret: string): Promise<boolean> {
    const item = {
      type: 1,
      name: `${ITEM_PREFIX}${alias}`,
      notes: "Managed by SkeletonKey (runner-generated signup password).",
      login: { username: this.options.boundEmail ?? alias, password: secret },
    };
    const encoded = Buffer.from(JSON.stringify(item), "utf8").toString("base64");
    try {
      const result = await this.bw(["create", "item"], encoded);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private async findItem(name: string): Promise<BwItem | null> {
    try {
      const result = await this.bw(["list", "items", "--search", name]);
      if (result.code !== 0) return null;
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(parsed)) return null;
      return (parsed as BwItem[]).find((item) => item.name === name) ?? null;
    } catch {
      return null;
    }
  }
}

function joinExpiry(month: string | null | undefined, year: string | null | undefined): string {
  if (typeof month !== "string" || typeof year !== "string") return "";
  if (month.trim() === "" || year.trim() === "") return "";
  return `${month.trim().padStart(2, "0")}/${year.trim()}`;
}

/** Host of an absolute URL, or null when it is not one. */
function hostOf(origin: string): string | null {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}
