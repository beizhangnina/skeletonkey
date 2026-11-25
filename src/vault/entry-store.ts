/**
 * The read/write layer for vault entries.
 *
 * The `Vault` interface is unchanged -- one alias to one string -- so none of
 * the five backends had to move. Everything entry-shaped (the login envelope,
 * the storage key, the metadata row) lives here instead.
 *
 * Two rules hold everywhere in this file:
 *
 *   - a value that was written is read back and compared before the metadata
 *     is recorded, so a silently failed write never leaves a row pointing at
 *     nothing;
 *   - no method returns a value to a caller that might print it. `getField` is
 *     the one exception, and its only callers are the ones that inject the
 *     value into a child process.
 */
import { readConfig } from "../config.js";
import { SkeletonKeyError } from "../exit-codes.js";
import { findKey, removeKey } from "../keys.js";
import { skeletonKeyHome } from "../paths.js";
import { createVault } from "./index.js";
import {
  decodeLogin,
  encodeLogin,
  entryTarget,
  findEntry,
  listVaultEntries,
  removeEntry,
  storageAlias,
  type VaultEntrySummary,
  type VaultEntryType,
} from "./entries.js";
import type { Vault } from "./types.js";

export interface ResolvedEntry {
  name: string;
  type: VaultEntryType;
  /** The secret fields this entry carries. */
  fields: string[];
  disabled: boolean;
  /** Where the entry points (a domain, or the host of a login url). */
  target: string | null;
  created: string;
  last_used: string | null;
}

/** Opens the configured vault, mapping the failures onto the exit-code table. */
export function openEntryStore(home = skeletonKeyHome()): VaultEntryStore {
  const config = readConfigOrFail(home);
  let vault: Vault;
  try {
    vault = createVault(config, home);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("stores secrets in plaintext")) {
      throw new SkeletonKeyError("backend_refused", message, "Pick a real backend and run `skeletonkey init`.");
    }
    throw new SkeletonKeyError("vault_locked", `The vault could not be opened: ${message}`);
  }
  return new VaultEntryStore(vault, home);
}

export function readConfigOrFail(home = skeletonKeyHome()): ReturnType<typeof readConfig> {
  try {
    return readConfig(home);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SkeletonKeyError("no_home", message, "Run `skeletonkey init` first.");
  }
}

export class VaultEntryStore {
  constructor(
    readonly vault: Vault,
    readonly home: string = skeletonKeyHome(),
  ) {}

  /** Where this vault keeps things, in words a human can read. */
  get location(): string {
    return this.vault.location;
  }

  /** Checks the backend can be used at all (installed, unlocked, right account). */
  async checkBackend(): Promise<void> {
    try {
      await this.vault.check();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SkeletonKeyError(
        "vault_locked",
        `The ${this.vault.id} vault is not usable: ${message}`,
        "Unlock it, then try again.",
      );
    }
  }

  /**
   * Looks an entry up by name.
   *
   * api_key entries live in `keys.yaml`, logins in `entries.yaml`; they share
   * one namespace, so a name resolves to exactly one of them.
   */
  resolve(name: string): ResolvedEntry | null {
    const key = findKey(name, this.home);
    if (key) {
      return {
        name: key.alias,
        type: "api_key",
        fields: ["api_key"],
        disabled: key.disabled === true,
        target: key.domain,
        created: key.created,
        last_used: key.last_used ?? null,
      };
    }
    const entry = findEntry(name, this.home);
    if (entry) {
      return {
        name: entry.name,
        type: entry.type,
        fields: [...entry.fields],
        disabled: entry.disabled === true,
        target: entryTarget(entry),
        created: entry.created,
        last_used: entry.last_used ?? null,
      };
    }
    return null;
  }

  /** Every entry, as the metadata list shows it. */
  list(): VaultEntrySummary[] {
    return listVaultEntries(this.home);
  }

  /**
   * Stores a login as one envelope record and returns the encoded value that
   * was written, so the caller can compare it with what it read back.
   */
  async putLogin(name: string, values: { username: string; password: string }): Promise<string> {
    const envelope = encodeLogin(values.username, values.password);
    await this.vault.set(storageAlias({ name, type: "login" }), envelope);
    const readBack = await this.vault.get(storageAlias({ name, type: "login" }));
    if (readBack !== envelope) {
      throw new SkeletonKeyError(
        "internal",
        `The vault read-back did not match what was written for "${name}"; no metadata was recorded.`,
        "This is a bug; nothing was recorded.",
      );
    }
    return envelope;
  }

  /** Stores an api_key under its plain alias, exactly as v0.3 did. */
  async putApiKey(name: string, secret: string): Promise<void> {
    await this.vault.set(name, secret);
    const readBack = await this.vault.get(name);
    if (readBack !== secret) {
      throw new SkeletonKeyError(
        "internal",
        `The vault read-back did not match what was written for "${name}"; no metadata was recorded.`,
        "This is a bug; nothing was recorded.",
      );
    }
  }

  /**
   * Reads one secret field of an entry.
   *
   * Returns null when the vault simply does not have the record; throws
   * `entry_corrupt` when a login envelope cannot be decoded.
   */
  async getField(entry: ResolvedEntry, field: string): Promise<string | null> {
    if (entry.type === "api_key") {
      return this.vault.get(storageAlias(entry));
    }
    const raw = await this.vault.get(storageAlias({ name: entry.name, type: "login" }));
    if (raw === null) return null;
    const envelope = decodeLogin(raw, entry.name);
    if (field === "username") return envelope.username;
    if (field === "password") return envelope.password;
    return null;
  }

  /** Removes the vault record and the metadata row of an entry. */
  async deleteEntry(name: string): Promise<boolean> {
    const entry = this.resolve(name);
    if (entry === null) return false;
    if (entry.type === "login") {
      await this.vault.delete(storageAlias({ name, type: "login" }));
      removeEntry(name, this.home);
      return true;
    }
    await this.vault.delete(name);
    removeKey(name, this.home);
    return true;
  }
}
