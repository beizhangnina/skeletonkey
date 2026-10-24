import fs from "node:fs";
import path from "node:path";
import { ensureHome } from "../config.js";
import { skeletonKeyHome } from "../paths.js";
import { run } from "./exec.js";
import type { Vault } from "./types.js";

const TITLE_PREFIX = "skeletonkey: ";

/**
 * Stores secrets as API Credential items through the 1Password `op` CLI.
 * Creation uses a 0600 temp template file rather than argv, so the secret is
 * never visible in the process list.
 */
export class OnePasswordVault implements Vault {
  readonly id = "1password" as const;
  readonly location: string;
  readonly testOnly = false;

  constructor(
    private readonly vaultName: string,
    private readonly home: string = skeletonKeyHome(),
  ) {
    this.location = `1Password vault ${vaultName} (items titled "${TITLE_PREFIX}<alias>")`;
  }

  async check(): Promise<void> {
    const result = await run("op", ["vault", "get", this.vaultName, "--format", "json"]);
    if (result.code !== 0) {
      throw new Error(
        `\`op vault get ${this.vaultName}\` failed. Is the 1Password CLI signed in? ${result.stderr.trim()}`,
      );
    }
  }

  async set(alias: string, secret: string): Promise<void> {
    ensureHome(this.home);
    const template = {
      title: TITLE_PREFIX + alias,
      category: "API_CREDENTIAL",
      fields: [
        { id: "credential", type: "CONCEALED", label: "credential", value: secret },
      ],
    };
    const file = path.join(this.home, `.op-template-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(template), { mode: 0o600 });
    try {
      await this.delete(alias); // `op` allows duplicate titles; keep exactly one.
      const result = await run("op", [
        "item",
        "create",
        "--template",
        file,
        "--vault",
        this.vaultName,
        "--format",
        "json",
      ]);
      if (result.code !== 0) {
        throw new Error(`op item create failed: ${result.stderr.trim()}`);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async get(alias: string): Promise<string | null> {
    const result = await run("op", [
      "item",
      "get",
      TITLE_PREFIX + alias,
      "--vault",
      this.vaultName,
      "--fields",
      "label=credential",
      "--reveal",
    ]);
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  }

  async delete(alias: string): Promise<void> {
    await run("op", ["item", "delete", TITLE_PREFIX + alias, "--vault", this.vaultName]);
  }
}
