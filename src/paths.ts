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

/**
 * Metadata index for the newer entry kinds (`login`). Like `keys.yaml` it holds
 * no secret values -- only names, labels, and a masked username hint.
 */
export function entriesPath(home = skeletonKeyHome()): string {
  return path.join(home, "entries.yaml");
}

/**
 * Vendor account metadata (ND-1): one row per registered account, pointing at
 * the vault entries that hold its secrets. Like `keys.yaml` and `entries.yaml`
 * it holds no secret values -- only a masked email hint.
 */
export function accountsPath(home = skeletonKeyHome()): string {
  return path.join(home, "accounts.yaml");
}

/**
 * ND-2 signup session metadata: one row per `skeletonkey signup start`, tracking
 * state through to `complete` or `abandon`. Like `accounts.yaml` it holds no
 * secret values -- no email, no key, nothing but ids, vendor, state, and dates.
 */
export function signupsPath(home = skeletonKeyHome()): string {
  return path.join(home, "signups.yaml");
}

/** Plaintext vault used by the test-only `file` backend. */
export function devVaultPath(home = skeletonKeyHome()): string {
  return path.join(home, "dev-vault.json");
}

/** AES-256-GCM blob used by the `encrypted-file` backend. */
export function encryptedVaultPath(home = skeletonKeyHome()): string {
  return path.join(home, "vault.enc.json");
}

/** Everything the weekly monitor (ND-5) writes: state plus generated reports. */
export function monitorDir(home = skeletonKeyHome()): string {
  return path.join(home, "monitor");
}

/** Per-account last-known status, last normalized usage, and last run time. No secrets. */
export function monitorStatePath(home = skeletonKeyHome()): string {
  return path.join(monitorDir(home), "state.json");
}

export function monitorReportsDir(home = skeletonKeyHome()): string {
  return path.join(monitorDir(home), "reports");
}

/** `weekly-YYYY-MM-DD.md` under the reports dir (or an explicit `--report-dir`). */
export function monitorReportPath(date: string, dir = monitorReportsDir()): string {
  return path.join(dir, `weekly-${date}.md`);
}
