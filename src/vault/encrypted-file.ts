import crypto from "node:crypto";
import fs from "node:fs";
import { ensureHome } from "../config.js";
import { encryptedVaultPath, skeletonKeyHome } from "../paths.js";
import { promptHidden } from "../prompt.js";
import type { Vault } from "./types.js";

/**
 * On-disk format. Everything except `secrets` is public: the KDF parameters and
 * the salt have to survive so the passphrase can be re-derived, and the nonce
 * must never repeat for a given key.
 */
interface EncryptedVaultFile {
  version: 1;
  kdf: "scrypt";
  /** scrypt cost parameters, stored so an old file still opens after a bump. */
  scrypt: { N: number; r: number; p: number; keylen: number };
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  /** base64 AES-256-GCM ciphertext of the JSON secret map. */
  secrets: string;
}

/** ~100ms on a modern laptop; raise N, never lower it. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** scrypt needs enough memory to be worth anything: 128 * N * r bytes. */
function scryptMaxmem(params: { N: number; r: number }): number {
  return Math.max(32 * 1024 * 1024, 256 * params.N * params.r);
}

export function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keylen: number } = SCRYPT,
): Buffer {
  return crypto.scryptSync(passphrase, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: scryptMaxmem(params),
  });
}

export function encryptSecrets(
  secrets: Record<string, string>,
  passphrase: string,
): EncryptedVaultFile {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  plaintext.fill(0);
  return {
    version: 1,
    kdf: "scrypt",
    scrypt: { ...SCRYPT },
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    secrets: ciphertext.toString("base64"),
  };
}

export function decryptSecrets(
  file: EncryptedVaultFile,
  passphrase: string,
): Record<string, string> {
  const key = deriveKey(passphrase, Buffer.from(file.salt, "base64"), file.scrypt);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(file.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.secrets, "base64")),
      decipher.final(),
    ]);
  } catch {
    // GCM authentication covers both a wrong passphrase and a tampered file.
    throw new Error(
      "Could not decrypt the vault: wrong SKELETONKEY_PASSPHRASE, or the file was modified.",
    );
  } finally {
    key.fill(0);
  }
  const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  plaintext.fill(0);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[alias] = value;
  }
  return out;
}

/**
 * Zero-install vault: an AES-256-GCM blob under SKELETONKEY_HOME, unlocked by a
 * passphrase from `SKELETONKEY_PASSPHRASE` or a hidden prompt. No external CLI, no
 * account, no sync -- the option for someone who wants to try the tool in one
 * command.
 */
export class EncryptedFileVault implements Vault {
  readonly id = "encrypted-file" as const;
  readonly location: string;
  readonly testOnly = false;
  private passphrase: string | null = null;

  constructor(private readonly home: string = skeletonKeyHome()) {
    this.location = `${encryptedVaultPath(home)} (AES-256-GCM, scrypt-derived key)`;
  }

  async check(): Promise<void> {
    ensureHome(this.home);
    const passphrase = await this.unlock();
    if (fs.existsSync(encryptedVaultPath(this.home))) {
      // Fail now with a clear message rather than at the first get().
      decryptSecrets(this.readFile(), passphrase);
    }
  }

  async set(alias: string, secret: string): Promise<void> {
    const secrets = await this.readSecrets();
    secrets[alias] = secret;
    await this.writeSecrets(secrets);
  }

  async get(alias: string): Promise<string | null> {
    const secrets = await this.readSecrets();
    const value = secrets[alias];
    return value === undefined ? null : value;
  }

  async delete(alias: string): Promise<void> {
    const secrets = await this.readSecrets();
    delete secrets[alias];
    await this.writeSecrets(secrets);
  }

  /** Reads the passphrase from the environment, else prompts without echoing. */
  private async unlock(): Promise<string> {
    if (this.passphrase !== null) return this.passphrase;
    const fromEnv = process.env.SKELETONKEY_PASSPHRASE;
    if (typeof fromEnv === "string" && fromEnv !== "") {
      this.passphrase = fromEnv;
      return fromEnv;
    }
    const exists = fs.existsSync(encryptedVaultPath(this.home));
    if (!process.stdin.isTTY) {
      throw new Error(
        "The encrypted-file backend needs a passphrase. Set SKELETONKEY_PASSPHRASE, " +
          "or run this command from a terminal so it can prompt.",
      );
    }
    const entered = await promptHidden(
      exists ? "Vault passphrase: " : "New vault passphrase (nothing can recover it): ",
    );
    if (entered === "") throw new Error("Empty passphrase; refusing to create a vault.");
    if (!exists) {
      const again = await promptHidden("Repeat passphrase: ");
      if (again !== entered) throw new Error("Passphrases did not match.");
    }
    this.passphrase = entered;
    return entered;
  }

  private readFile(): EncryptedVaultFile {
    const parsed = JSON.parse(
      fs.readFileSync(encryptedVaultPath(this.home), "utf8"),
    ) as EncryptedVaultFile;
    if (parsed.cipher !== "aes-256-gcm" || parsed.kdf !== "scrypt") {
      throw new Error(
        `${encryptedVaultPath(this.home)}: unsupported cipher/kdf combination.`,
      );
    }
    return { ...parsed, scrypt: { ...SCRYPT, ...parsed.scrypt } };
  }

  private async readSecrets(): Promise<Record<string, string>> {
    const passphrase = await this.unlock();
    if (!fs.existsSync(encryptedVaultPath(this.home))) return {};
    return decryptSecrets(this.readFile(), passphrase);
  }

  private async writeSecrets(secrets: Record<string, string>): Promise<void> {
    const passphrase = await this.unlock();
    ensureHome(this.home);
    const file = encryptedVaultPath(this.home);
    // Re-encrypt from scratch so the nonce is fresh on every write.
    const body = JSON.stringify(encryptSecrets(secrets, passphrase), null, 2);
    fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
}
