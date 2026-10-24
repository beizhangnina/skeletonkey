import fs from "node:fs";
import { ensureHome } from "../config.js";
import { devVaultPath, skeletonKeyHome } from "../paths.js";
import type { Vault } from "./types.js";

interface DevVaultFile {
  version: 1;
  warning: string;
  secrets: Record<string, string>;
}

const WARNING =
  "TEST-ONLY VAULT -- secrets are stored in PLAINTEXT. Never put a real key here. " +
  "Use bitwarden, 1password, keychain, or encrypted-file.";

/**
 * Plaintext vault, kept for the test suite and scripts/demo.sh only. It is
 * hidden from `skeletonkey init` and refused unless SKELETONKEY_ALLOW_TEST_BACKEND=1,
 * so nobody reaches for it by accident. Deliberately boring: a 0600 JSON file
 * under SKELETONKEY_HOME.
 */
export class FileVault implements Vault {
  readonly id = "file" as const;
  readonly location: string;
  readonly testOnly = true;

  constructor(private readonly home: string = skeletonKeyHome()) {
    this.location = devVaultPath(home);
  }

  async check(): Promise<void> {
    ensureHome(this.home);
  }

  async set(alias: string, secret: string): Promise<void> {
    const data = this.read();
    data.secrets[alias] = secret;
    this.write(data);
  }

  async get(alias: string): Promise<string | null> {
    const value = this.read().secrets[alias];
    return value === undefined ? null : value;
  }

  async delete(alias: string): Promise<void> {
    const data = this.read();
    delete data.secrets[alias];
    this.write(data);
  }

  private read(): DevVaultFile {
    const file = devVaultPath(this.home);
    if (!fs.existsSync(file)) return { version: 1, warning: WARNING, secrets: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const raw = (parsed ?? {}) as Record<string, unknown>;
    const secrets =
      raw["secrets"] !== null && typeof raw["secrets"] === "object"
        ? (raw["secrets"] as Record<string, string>)
        : {};
    return { version: 1, warning: WARNING, secrets };
  }

  private write(data: DevVaultFile): void {
    ensureHome(this.home);
    const file = devVaultPath(this.home);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
}
