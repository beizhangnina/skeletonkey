import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecrets, encryptSecrets, EncryptedFileVault } from "../src/vault/encrypted-file.js";
import { encryptedVaultPath } from "../src/paths.js";
import { createVault } from "../src/vault/index.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const SECRET = "sk-test-FAKE-encrypted-abcdef0123456789";
const OTHER = "sk-test-FAKE-second-key-9876543210";
const PASSPHRASE = "correct horse battery staple";

describe("encrypted-file vault", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    process.env.SKELETONKEY_PASSPHRASE = PASSPHRASE;
  });
  afterEach(() => {
    delete process.env.SKELETONKEY_PASSPHRASE;
    removeHome(home);
  });

  it("round-trips a secret through set/get/delete", async () => {
    const vault = new EncryptedFileVault(home);
    await vault.check();

    expect(await vault.get("missing")).toBeNull();

    await vault.set("alpha", SECRET);
    expect(await vault.get("alpha")).toBe(SECRET);

    await vault.set("beta", OTHER);
    expect(await vault.get("alpha")).toBe(SECRET);
    expect(await vault.get("beta")).toBe(OTHER);

    await vault.delete("alpha");
    expect(await vault.get("alpha")).toBeNull();
    expect(await vault.get("beta")).toBe(OTHER);
  });

  it("survives a reopen by a fresh vault instance with the same passphrase", async () => {
    const first = new EncryptedFileVault(home);
    await first.set("alpha", SECRET);

    const second = new EncryptedFileVault(home);
    await second.check();
    expect(await second.get("alpha")).toBe(SECRET);
  });

  it("writes no plaintext secret to disk anywhere under SKELETONKEY_HOME", async () => {
    const vault = new EncryptedFileVault(home);
    await vault.set("alpha", SECRET);
    await vault.set("beta", OTHER);

    const file = encryptedVaultPath(home);
    const raw = fs.readFileSync(file);
    expect(raw.includes(SECRET)).toBe(false);
    expect(raw.includes(OTHER)).toBe(false);
    // Not even a recognisable fragment of the key.
    expect(raw.toString("utf8")).not.toContain("sk-test-FAKE");
    // The alias is not a secret, but it must not be readable either: the whole
    // secret map is inside the ciphertext.
    expect(raw.toString("utf8")).not.toContain('"alpha"');

    const leaked = fs
      .readdirSync(home)
      .filter((name) => fs.statSync(path.join(home, name)).isFile())
      .filter((name) => fs.readFileSync(path.join(home, name)).includes(SECRET));
    expect(leaked).toEqual([]);
  });

  it("stores the vault 0600 and records its KDF parameters", async () => {
    const vault = new EncryptedFileVault(home);
    await vault.set("alpha", SECRET);
    const file = encryptedVaultPath(home);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(parsed["cipher"]).toBe("aes-256-gcm");
    expect(parsed["kdf"]).toBe("scrypt");
    expect(parsed["scrypt"]).toMatchObject({ r: 8, p: 1, keylen: 32 });
    expect(typeof parsed["salt"]).toBe("string");
    expect(typeof parsed["iv"]).toBe("string");
    expect(typeof parsed["tag"]).toBe("string");
  });

  it("uses a fresh nonce and salt on every write", async () => {
    const vault = new EncryptedFileVault(home);
    await vault.set("alpha", SECRET);
    const first = JSON.parse(fs.readFileSync(encryptedVaultPath(home), "utf8")) as {
      iv: string;
      salt: string;
      secrets: string;
    };
    await vault.set("alpha", SECRET);
    const second = JSON.parse(fs.readFileSync(encryptedVaultPath(home), "utf8")) as {
      iv: string;
      salt: string;
      secrets: string;
    };
    expect(second.iv).not.toBe(first.iv);
    expect(second.salt).not.toBe(first.salt);
    // Same plaintext, different ciphertext.
    expect(second.secrets).not.toBe(first.secrets);
  });

  it("refuses a wrong passphrase instead of returning garbage", async () => {
    const vault = new EncryptedFileVault(home);
    await vault.set("alpha", SECRET);

    process.env.SKELETONKEY_PASSPHRASE = "not the passphrase";
    const wrong = new EncryptedFileVault(home);
    await expect(wrong.check()).rejects.toThrow(/Could not decrypt/i);
  });

  it("detects a tampered ciphertext through the GCM tag", () => {
    const file = encryptSecrets({ alpha: SECRET }, PASSPHRASE);
    const bytes = Buffer.from(file.secrets, "base64");
    bytes[0] = bytes[0] === undefined ? 0 : bytes[0] ^ 0xff;
    const tampered = { ...file, secrets: bytes.toString("base64") };
    expect(() => decryptSecrets(tampered, PASSPHRASE)).toThrow(/Could not decrypt/i);
  });

  it("is reachable through `skeletonkey init --backend encrypted-file` end to end", async () => {
    const init = await runCli(home, [
      "init",
      "--email",
      "dev@example.test",
      "--backend",
      "encrypted-file",
    ]);
    expect(init.stderr).toBe("");
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("AES-256-GCM");

    const add = await runCli(
      home,
      ["add", "enc-key", "--platform", "ExampleCo", "--domain", "api.example.com"],
      SECRET,
    );
    expect(add.code).toBe(0);
    expect(add.stdout).not.toContain(SECRET);

    // The CLI ran in a child process; read the vault back here.
    const vault = new EncryptedFileVault(home);
    expect(await vault.get("enc-key")).toBe(SECRET);

    const keysYaml = fs.readFileSync(path.join(home, "keys.yaml"), "utf8");
    expect(keysYaml).not.toContain(SECRET);
    expect(fs.readFileSync(encryptedVaultPath(home)).includes(SECRET)).toBe(false);
  });

  it("explains itself rather than prompting when no passphrase is available", async () => {
    delete process.env.SKELETONKEY_PASSPHRASE;
    const vault = new EncryptedFileVault(home);
    // stdin in the test runner is not a TTY, so there is nowhere to prompt.
    await expect(vault.check()).rejects.toThrow(/SKELETONKEY_PASSPHRASE/);
  });
});

describe("backend selection", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("builds an encrypted-file vault from config and marks it not test-only", () => {
    const vault = createVault(
      { email: "dev@example.test", backend: "encrypted-file", created: "" },
      home,
    );
    expect(vault.id).toBe("encrypted-file");
    expect(vault.testOnly).toBe(false);
  });

  it("marks the plaintext file backend test-only", () => {
    const vault = createVault({ email: "dev@example.test", backend: "file", created: "" }, home);
    expect(vault.id).toBe("file");
    expect(vault.testOnly).toBe(true);
  });

  it("refuses the plaintext file backend without the opt-in env var", async () => {
    const previous = process.env.SKELETONKEY_ALLOW_TEST_BACKEND;
    delete process.env.SKELETONKEY_ALLOW_TEST_BACKEND;
    try {
      expect(() =>
        createVault({ email: "dev@example.test", backend: "file", created: "" }, home),
      ).toThrow(/plaintext/i);
    } finally {
      process.env.SKELETONKEY_ALLOW_TEST_BACKEND = previous;
    }
  });

  it("hides the test-only backend from `skeletonkey init`'s error message", async () => {
    const result = await runCli(home, ["init", "--email", "dev@example.test"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("bitwarden, 1password, keychain, encrypted-file");
    // The plaintext `file` backend is never offered as a choice.
    expect(result.stderr).not.toMatch(/(^|[\s,(])file([\s,.)]|$)/);
  });
});
