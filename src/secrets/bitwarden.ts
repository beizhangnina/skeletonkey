/**
 * Rung 1 of the ladder: Bitwarden, automatic, no human prompt.
 *
 * Talks to the `bw` CLI through `child_process` (the same `run` helper the
 * vault backend uses: arguments only, secrets on stdin, never in argv). The
 * command runner is injectable so the test suite can drive a fake `bw` without
 * installing one.
 */
import { run } from "../vault/exec.js";
import { parseStatus } from "../vault/bitwarden.js";
import type { SecretClass, SecretRequest, SecretResolution, SecretSource } from "./types.js";

export interface BwRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `bw` invocation seam. The real one is `run` from the vault helpers. */
export type BwRunner = (args: string[], stdin?: string) => Promise<BwRunResult>;

export function childProcessBw(binary = "bw"): BwRunner {
  return (args, stdin) => run(binary, args, stdin);
}

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

/**
 * Reads the card, an existing vendor login, or a generated password that was
 * saved to `bw` before submit. Unlocking is always a human action: a locked
 * vault is reported as "cannot answer", never worked around.
 */
export class BitwardenSecretSource implements SecretSource {
  readonly id = "bitwarden" as const;
  private detail: string | null = null;

  constructor(
    private readonly bw: BwRunner = childProcessBw(),
    private readonly options: { cardItemName?: string } = {},
  ) {}

  handles(secretClass: SecretClass): boolean {
    return secretClass !== "otp";
  }

  lastDetail(): string | null {
    return this.detail;
  }

  /** `unlocked` | `locked` | `unauthenticated` | `unavailable`. */
  async state(): Promise<string> {
    try {
      const result = await this.bw(["status"]);
      if (result.code !== 0) return "unavailable";
      return parseStatus(result.stdout);
    } catch {
      return "unavailable";
    }
  }

  async resolve(request: SecretRequest): Promise<SecretResolution | null> {
    this.detail = null;
    if (!this.handles(request.class)) {
      this.detail = "Bitwarden does not hold email OTPs.";
      return null;
    }
    const state = await this.state();
    if (state !== "unlocked") {
      this.detail =
        state === "locked"
          ? "Bitwarden is locked. Unlocking is a human action (`bw unlock`); the ladder moves on."
          : state === "unauthenticated"
            ? "Bitwarden is not logged in (`bw login`); the ladder moves on."
            : "The `bw` CLI is not available here; the ladder moves on.";
      return null;
    }

    if (request.class === "card_number" || request.class === "card_cvv" || request.class === "card_expiry") {
      return this.fromCard(request);
    }
    return this.fromLogin(request);
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

  private async fromLogin(request: SecretRequest): Promise<SecretResolution | null> {
    const alias = request.alias ?? request.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const name = `${ITEM_PREFIX}${alias}`;
    const item = await this.findItem(name);
    const password = item?.login?.password;
    if (typeof password !== "string" || password === "") {
      this.detail = `No Bitwarden login item named "${name}" with a password; the ladder moves on.`;
      return null;
    }
    return {
      source: "bitwarden",
      value: password,
      detail: `Read ${request.class} from the Bitwarden login item "${name}". No human was prompted.`,
    };
  }

  /** Generated passwords are saved to `bw` *before* they are typed anywhere. */
  async savePassword(alias: string, secret: string): Promise<boolean> {
    const item = {
      type: 1,
      name: `${ITEM_PREFIX}${alias}`,
      notes: "Managed by SkeletonKey (runner-generated signup password).",
      login: { username: alias, password: secret },
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
