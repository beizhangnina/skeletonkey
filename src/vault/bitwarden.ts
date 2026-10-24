import { run } from "./exec.js";
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
 * Item creation goes through `bw create item` reading base64 JSON on stdin, so
 * the secret never appears in argv.
 */
export class BitwardenVault implements Vault {
  readonly id = "bitwarden" as const;
  readonly location: string;
  readonly testOnly = false;

  constructor(private readonly folder?: string) {
    this.location = folder
      ? `Bitwarden folder ${folder} (items named "${ITEM_PREFIX}<alias>")`
      : `Bitwarden vault (items named "${ITEM_PREFIX}<alias>")`;
  }

  async check(): Promise<void> {
    const status = await run("bw", ["status"]);
    if (status.code !== 0) {
      throw new Error(
        `\`bw status\` failed: ${status.stderr.trim() || "unknown error"}. ` +
          "Install the Bitwarden CLI (https://bitwarden.com/help/cli/) and log in with `bw login`.",
      );
    }
    const state = parseStatus(status.stdout);
    if (state === "unauthenticated") {
      throw new Error("Bitwarden is not logged in. Run `bw login` first.");
    }
    if (state === "locked") {
      throw new Error(
        'Bitwarden is locked. Run: export BW_SESSION="$(bw unlock --raw)" and retry.',
      );
    }
  }

  async set(alias: string, secret: string): Promise<void> {
    await this.delete(alias); // Bitwarden allows duplicate names; keep exactly one.
    const item = {
      type: 1, // login
      name: ITEM_PREFIX + alias,
      notes: "Managed by SkeletonKey. The API key is the item password.",
      login: { username: alias, password: secret },
      ...(await this.folderId()),
    };
    // `bw create` wants the JSON base64-encoded on stdin.
    const encoded = Buffer.from(JSON.stringify(item), "utf8").toString("base64");
    const result = await run("bw", ["create", "item"], encoded);
    if (result.code !== 0) {
      throw new Error(`bw create item failed: ${result.stderr.trim()}`);
    }
  }

  async get(alias: string): Promise<string | null> {
    const item = await this.findItem(alias);
    const password = item?.login?.password;
    return typeof password === "string" && password !== "" ? password : null;
  }

  async delete(alias: string): Promise<void> {
    const item = await this.findItem(alias);
    if (!item) return;
    await run("bw", ["delete", "item", item.id]);
  }

  /** Exact-name lookup: `bw list` matches loosely, so filter ourselves. */
  private async findItem(alias: string): Promise<BwItem | null> {
    const result = await run("bw", [
      "list",
      "items",
      "--search",
      ITEM_PREFIX + alias,
    ]);
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
    const result = await run("bw", ["list", "folders", "--search", this.folder]);
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
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as { status?: unknown };
    if (typeof parsed.status === "string") return parsed.status;
  } catch {
    // fall through
  }
  return trimmed.replace(/^"|"$/g, "");
}
