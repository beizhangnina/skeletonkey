import {
  bwAccountStatus,
  bwGuidanceError,
  childProcessBw,
  findVendorItems,
  parseBwStatus,
  type BwAccount,
  type BwRunner,
  type BwVendorLookup,
} from "./bw-account.js";
import type { Vault } from "./types.js";

const ITEM_PREFIX = "skeletonkey: ";

interface BwItem {
  id: string;
  name: string;
  login?: { password?: string | null };
}

/**
 * Default backend: secrets live in Bitwarden as login items named
 * `skeletonkey: <alias>`, reached through the `bw` CLI. Chosen as the default
 * because the free tier covers unlimited devices and syncs, the clients are
 * open source, and it can be self-hosted with Vaultwarden.
 *
 * `bw` needs an unlocked session: `export BW_SESSION="$(bw unlock --raw)"`.
 * That is always a human action -- this class detects the state and prints the
 * commands, and never collects a master password. Item creation goes through
 * `bw create item` reading base64 JSON on stdin, so the secret never appears
 * in argv.
 */
export class BitwardenVault implements Vault {
  readonly id = "bitwarden" as const;
  readonly location: string;
  readonly testOnly = false;
  /** Set once `bw status` has said `unlocked`, so reads do not re-check. */
  private sessionVerified = false;

  constructor(
    private readonly folder?: string,
    /** Bound email from the config: used to log in and to find vendor items. */
    private readonly email?: string,
    private readonly bw: BwRunner = childProcessBw(),
  ) {
    this.location = folder
      ? `Bitwarden folder ${folder} (items named "${ITEM_PREFIX}<alias>")`
      : `Bitwarden vault (items named "${ITEM_PREFIX}<alias>")`;
  }

  /** Installed, logged in, unlocked, and as which account. */
  async status(): Promise<BwAccount> {
    return bwAccountStatus({ bound: this.email ?? null, bw: this.bw });
  }

  async check(): Promise<void> {
    const status = await this.status();
    if (!status.usable) throw bwGuidanceError(status);
    this.sessionVerified = true;
  }

  /**
   * Vendor accounts already in the vault for the bound email, found by domain.
   * Read-only, and the returned values stay in this process.
   */
  async findForDomain(domain: string): Promise<BwVendorLookup> {
    return findVendorItems({ domain, bound: this.email ?? null, bw: this.bw });
  }

  async set(alias: string, secret: string): Promise<void> {
    await this.ensureUsable();
    await this.delete(alias); // Bitwarden allows duplicate names; keep exactly one.
    const item = {
      type: 1, // login
      name: ITEM_PREFIX + alias,
      notes: "Managed by SkeletonKey. The API key is the item password.",
      login: { username: this.email ?? alias, password: secret },
      ...(await this.folderId()),
    };
    // `bw create` wants the JSON base64-encoded on stdin.
    const encoded = Buffer.from(JSON.stringify(item), "utf8").toString("base64");
    const result = await this.bw(["create", "item"], encoded);
    if (result.code !== 0) {
      throw new Error(`bw create item failed: ${result.stderr.trim()}`);
    }
  }

  async get(alias: string): Promise<string | null> {
    await this.ensureUsable();
    const item = await this.findItem(alias);
    const password = item?.login?.password;
    return typeof password === "string" && password !== "" ? password : null;
  }

  async delete(alias: string): Promise<void> {
    await this.ensureUsable();
    const item = await this.findItem(alias);
    if (!item) return;
    await this.bw(["delete", "item", item.id]);
  }

  /**
   * First secret use in this process: say why `bw` cannot answer, with the
   * commands the human runs, instead of quietly returning "no such key".
   */
  private async ensureUsable(): Promise<void> {
    if (this.sessionVerified) return;
    const status = await this.status();
    if (!status.usable) throw bwGuidanceError(status);
    this.sessionVerified = true;
  }

  /** Exact-name lookup: `bw list` matches loosely, so filter ourselves. */
  private async findItem(alias: string): Promise<BwItem | null> {
    const result = await this.bw(["list", "items", "--search", ITEM_PREFIX + alias]);
    if (result.code !== 0) return null;
    let items: unknown;
    try {
      items = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (!Array.isArray(items)) return null;
    const match = (items as BwItem[]).find((item) => item.name === ITEM_PREFIX + alias);
    return match ?? null;
  }

  private async folderId(): Promise<{ folderId?: string }> {
    if (!this.folder) return {};
    const result = await this.bw(["list", "folders", "--search", this.folder]);
    if (result.code !== 0) return {};
    try {
      const folders = JSON.parse(result.stdout) as { id: string; name: string }[];
      const match = folders.find((folder) => folder.name === this.folder);
      return match ? { folderId: match.id } : {};
    } catch {
      return {};
    }
  }
}

/** `bw status` prints JSON, but older builds printed a bare word. */
export function parseStatus(stdout: string): string {
  return parseBwStatus(stdout).status;
}
