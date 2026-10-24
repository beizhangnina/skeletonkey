import os from "node:os";
import path from "node:path";

/**
 * All state lives under a single directory so tests (and curious users) can
 * point the whole tool at a throwaway location via SKELETONKEY_HOME.
 *
 * `KEYRING_HOME` is still honoured as a fallback: it was the name this tool
 * used before it was called SkeletonKey.
 */
export function skeletonKeyHome(): string {
  for (const name of ["SKELETONKEY_HOME", "KEYRING_HOME"]) {
    const override = process.env[name];
    if (override !== undefined && override.trim() !== "") return path.resolve(override);
  }
  return path.join(os.homedir(), ".skeletonkey");
}

export function configPath(home = skeletonKeyHome()): string {
  return path.join(home, "config.yaml");
}

export function keysPath(home = skeletonKeyHome()): string {
  return path.join(home, "keys.yaml");
}

export function ledgerPath(home = skeletonKeyHome()): string {
  return path.join(home, "ledger.db");
}

/** Plaintext vault used by the test-only `file` backend. */
export function devVaultPath(home = skeletonKeyHome()): string {
  return path.join(home, "dev-vault.json");
}

/** AES-256-GCM blob used by the `encrypted-file` backend. */
export function encryptedVaultPath(home = skeletonKeyHome()): string {
  return path.join(home, "vault.enc.json");
}
