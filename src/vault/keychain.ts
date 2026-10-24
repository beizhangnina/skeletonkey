import { commandExists, run } from "./exec.js";
import type { Vault } from "./types.js";

const SERVICE_PREFIX = "skeletonkey:";

/** Quote a token for `security -i`, which splits lines shell-style. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The OS keystore: the macOS login keychain via `security`, or a libsecret
 * keyring (GNOME Keyring, KWallet with the Secret Service bridge) via
 * `secret-tool` on Linux. Both receive the secret on stdin, not in argv.
 */
export class KeychainVault implements Vault {
  readonly id = "keychain" as const;
  readonly location: string;
  readonly testOnly = false;

  constructor(private readonly account: string) {
    this.location =
      process.platform === "darwin"
        ? "macOS login keychain (generic passwords, service skeletonkey:<alias>)"
        : "libsecret keyring via secret-tool (attributes service=skeletonkey:<alias>)";
  }

  async check(): Promise<void> {
    if (process.platform === "darwin") {
      const result = await run("security", ["list-keychains"]);
      if (result.code !== 0) {
        throw new Error(`\`security list-keychains\` failed: ${result.stderr.trim()}`);
      }
      return;
    }
    if (process.platform === "linux") {
      if (!(await commandExists("secret-tool"))) {
        throw new Error(
          "The keychain backend needs `secret-tool` on Linux (Debian/Ubuntu: " +
            "apt install libsecret-tools), plus a running Secret Service such as " +
            "gnome-keyring. Use `bitwarden` or `encrypted-file` instead if you have neither.",
        );
      }
      // A headless box has secret-tool but no unlocked collection; find that out now.
      const probe = await run("secret-tool", [
        "search",
        "--all",
        "service",
        `${SERVICE_PREFIX}__probe__`,
      ]);
      if (probe.code !== 0 && probe.stderr.trim() !== "") {
        throw new Error(
          `\`secret-tool search\` failed: ${probe.stderr.trim()}. ` +
            "Is a Secret Service (gnome-keyring) running and unlocked?",
        );
      }
      return;
    }
    throw new Error(
      `The keychain backend supports macOS and Linux (libsecret), not ${process.platform}. ` +
        "Use `bitwarden`, `1password`, or `encrypted-file`.",
    );
  }

  async set(alias: string, secret: string): Promise<void> {
    if (/[\r\n]/.test(secret)) {
      throw new Error("Secrets containing newlines are not supported by the keychain backend.");
    }
    if (process.platform === "darwin") {
      const command = [
        "add-generic-password",
        "-a",
        quote(this.account),
        "-s",
        quote(SERVICE_PREFIX + alias),
        "-U",
        "-w",
        quote(secret),
      ].join(" ");
      const result = await run("security", ["-i"], `${command}\n`);
      if (result.code !== 0) {
        throw new Error(`security add-generic-password failed: ${result.stderr.trim()}`);
      }
      return;
    }
    // secret-tool store reads the secret from stdin.
    const result = await run(
      "secret-tool",
      [
        "store",
        "--label",
        `skeletonkey: ${alias}`,
        "service",
        SERVICE_PREFIX + alias,
        "account",
        this.account,
      ],
      secret,
    );
    if (result.code !== 0) {
      throw new Error(`secret-tool store failed: ${result.stderr.trim()}`);
    }
  }

  async get(alias: string): Promise<string | null> {
    if (process.platform === "darwin") {
      const result = await run("security", [
        "find-generic-password",
        "-a",
        this.account,
        "-s",
        SERVICE_PREFIX + alias,
        "-w",
      ]);
      if (result.code !== 0) return null;
      return result.stdout.replace(/\n$/, "");
    }
    const result = await run("secret-tool", [
      "lookup",
      "service",
      SERVICE_PREFIX + alias,
      "account",
      this.account,
    ]);
    if (result.code !== 0) return null;
    const value = result.stdout.replace(/\n$/, "");
    return value === "" ? null : value;
  }

  async delete(alias: string): Promise<void> {
    if (process.platform === "darwin") {
      await run("security", [
        "delete-generic-password",
        "-a",
        this.account,
        "-s",
        SERVICE_PREFIX + alias,
      ]);
      return;
    }
    await run("secret-tool", [
      "clear",
      "service",
      SERVICE_PREFIX + alias,
      "account",
      this.account,
    ]);
  }
}
