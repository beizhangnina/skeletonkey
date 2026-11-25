/**
 * ND-1 backend coverage: the v1 `encrypted-file` backend (AES-256-GCM, see
 * src/vault/encrypted-file.ts) driven end to end through `skeletonkey account
 * *` and `skeletonkey run`, in the style of test/accounts-keychain.test.ts
 * (one feature per test) and test/accounts-canary.test.ts (a final sweep).
 *
 * The passphrase and every secret below are fake canaries, passed only
 * through `env` on each `runCli` call -- never through `process.env` -- so a
 * leak into stdout, stderr, or any file under SKELETONKEY_HOME (including the
 * ciphertext vault.enc.json) fails the suite.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const API_KEY = "sk-canary-ND1-ENCFILE-KEY-0005";
const PASSWORD = "canary-ND1-ENCFILE-PW-0006";
const EMAIL = "canary-nd1-encfile-0007@example.test";
const PASSPHRASE = "canary-ND1-ENCFILE-PASSPHRASE-0008";

const ACCOUNT = "apify-enc";
const LOGIN_ACCOUNT = "apify-enc-login-acct";
const DOMAIN = "api.apify.com";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** A tiny child script that prints only "OK" or "MISMATCH", never the value. */
function compareScript(envVar: string, expectedHash: string): string {
  return (
    `const crypto=require('crypto');` +
    `const h=crypto.createHash('sha256').update(process.env.${envVar}).digest('hex');` +
    `process.stdout.write(h===${JSON.stringify(expectedHash)}?'OK':'MISMATCH');`
  );
}

describe("the encrypted-file backend end to end", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    home = makeHome();
    env = { SKELETONKEY_PASSPHRASE: PASSPHRASE };
    const init = await runCli(
      home,
      ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
      undefined,
      env,
    );
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("AES-256-GCM");
  });

  afterEach(() => {
    removeHome(home);
  });

  it("account add --store-key writes through the encrypted vault, never to a plaintext file", async () => {
    const add = await runCli(
      home,
      ["account", "add", ACCOUNT, "--vendor", "apify", "--store-key", "--domain", DOMAIN, "--stdin"],
      API_KEY,
      env,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).not.toContain(API_KEY);

    const encPath = path.join(home, "vault.enc.json");
    expect(fs.existsSync(encPath)).toBe(true);
    const ciphertext = fs.readFileSync(encPath, "utf8");
    expect(ciphertext).not.toContain(API_KEY);
    // The alias is not a secret, but it lives inside the encrypted map, not
    // in the cleartext envelope around it.
    expect(ciphertext).not.toContain(`"${ACCOUNT}"`);
    const parsed = JSON.parse(ciphertext) as Record<string, unknown>;
    expect(parsed["cipher"]).toBe("aes-256-gcm");

    for (const file of walk(home)) {
      expect(fs.readFileSync(file).toString("latin1")).not.toContain(API_KEY);
    }
  });

  it("run --env injects the key read back through the encrypted vault", async () => {
    const add = await runCli(
      home,
      ["account", "add", ACCOUNT, "--vendor", "apify", "--store-key", "--domain", DOMAIN, "--stdin"],
      API_KEY,
      env,
    );
    expect(add.code, add.stderr).toBe(0);

    const result = await runCli(
      home,
      [
        "run",
        "--env",
        `X=vault://${ACCOUNT}`,
        "--",
        "node",
        "-e",
        compareScript("X", sha256(API_KEY)),
      ],
      undefined,
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("OK");
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("account add --store-login stores the login half, read back via <name>-login.password", async () => {
    const add = await runCli(
      home,
      ["account", "add", LOGIN_ACCOUNT, "--vendor", "apify", "--email-stdin", "--store-login", "--stdin"],
      `${EMAIL}\n${PASSWORD}`,
      env,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).not.toContain(PASSWORD);
    expect(add.stdout).not.toContain(EMAIL);

    const result = await runCli(
      home,
      [
        "run",
        "--env",
        `P=vault://${LOGIN_ACCOUNT}-login.password`,
        "--",
        "node",
        "-e",
        compareScript("P", sha256(PASSWORD)),
      ],
      undefined,
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("OK");

    for (const file of walk(home)) {
      const text = fs.readFileSync(file).toString("latin1");
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(EMAIL);
    }
  });

  it("account list / list --json / show / show --json report metadata only", async () => {
    const add = await runCli(
      home,
      [
        "account",
        "add",
        ACCOUNT,
        "--vendor",
        "apify",
        "--email-stdin",
        "--store-key",
        "--domain",
        DOMAIN,
        "--stdin",
      ],
      `${EMAIL}\n${API_KEY}`,
      env,
    );
    expect(add.code, add.stderr).toBe(0);

    for (const argv of [
      ["account", "list"],
      ["account", "list", "--json"],
      ["account", "show", ACCOUNT],
      ["account", "show", ACCOUNT, "--json"],
    ]) {
      const result = await runCli(home, argv, undefined, env);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
      expect(result.stdout).not.toContain(API_KEY);
      expect(result.stdout).not.toContain(EMAIL);
    }

    const list = await runCli(home, ["account", "list", "--json"], undefined, env);
    const parsed = JSON.parse(list.stdout) as { name: string; refs: string[] }[];
    const row = parsed.find((entry) => entry.name === ACCOUNT);
    expect(row?.refs).toContain(`vault://${ACCOUNT}`);

    const show = await runCli(home, ["account", "show", ACCOUNT, "--json"], undefined, env);
    const shown = JSON.parse(show.stdout) as { refs: string[] };
    expect(shown.refs).toContain(`vault://${ACCOUNT}`);
  });

  it("account disable then run fails with entry_disabled (exit 71); enable restores it", async () => {
    const add = await runCli(
      home,
      ["account", "add", ACCOUNT, "--vendor", "apify", "--store-key", "--domain", DOMAIN, "--stdin"],
      API_KEY,
      env,
    );
    expect(add.code, add.stderr).toBe(0);

    const disable = await runCli(home, ["account", "disable", ACCOUNT], undefined, env);
    expect(disable.code, disable.stderr).toBe(0);

    const blocked = await runCli(
      home,
      ["run", "--env", `X=vault://${ACCOUNT}`, "--", "node", "-e", "0"],
      undefined,
      env,
    );
    expect(blocked.code).toBe(71);
    expect(blocked.stderr).toContain("entry_disabled");
    expect(blocked.stdout).not.toContain(API_KEY);
    expect(blocked.stderr).not.toContain(API_KEY);

    const enable = await runCli(home, ["account", "enable", ACCOUNT], undefined, env);
    expect(enable.code, enable.stderr).toBe(0);

    const restored = await runCli(
      home,
      [
        "run",
        "--env",
        `X=vault://${ACCOUNT}`,
        "--",
        "node",
        "-e",
        compareScript("X", sha256(API_KEY)),
      ],
      undefined,
      env,
    );
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.stdout.trim()).toBe("OK");
  });

  it("a wrong passphrase fails run with the vault's own error, never the value", async () => {
    const add = await runCli(
      home,
      ["account", "add", ACCOUNT, "--vendor", "apify", "--store-key", "--domain", DOMAIN, "--stdin"],
      API_KEY,
      env,
    );
    expect(add.code, add.stderr).toBe(0);

    const wrongEnv = { SKELETONKEY_PASSPHRASE: "canary-ND1-ENCFILE-WRONG-PASSPHRASE-0009" };
    const result = await runCli(
      home,
      ["run", "--env", `X=vault://${ACCOUNT}`, "--", "node", "-e", "0"],
      undefined,
      wrongEnv,
    );
    expect(result.code).toBe(68);
    expect(result.stderr).toMatch(/Could not decrypt/i);
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(PASSPHRASE);
  });

  it("sweeps CLI output and every file under SKELETONKEY_HOME, including vault.enc.json, for the canaries", async () => {
    const surfaces: { name: string; text: string }[] = [];
    const record = (name: string, result: { stdout: string; stderr: string }): void => {
      surfaces.push({ name, text: `${result.stdout}\n${result.stderr}` });
    };

    const addKey = await runCli(
      home,
      [
        "account",
        "add",
        ACCOUNT,
        "--vendor",
        "apify",
        "--email-stdin",
        "--store-key",
        "--domain",
        DOMAIN,
        "--stdin",
      ],
      `${EMAIL}\n${API_KEY}`,
      env,
    );
    expect(addKey.code, addKey.stderr).toBe(0);
    record("cli:account add (key)", addKey);

    const addLogin = await runCli(
      home,
      ["account", "add", LOGIN_ACCOUNT, "--vendor", "apify", "--email-stdin", "--store-login", "--stdin"],
      `${EMAIL}\n${PASSWORD}`,
      env,
    );
    expect(addLogin.code, addLogin.stderr).toBe(0);
    record("cli:account add (login)", addLogin);

    for (const argv of [
      ["account", "list"],
      ["account", "list", "--json"],
      ["account", "show", ACCOUNT],
      ["account", "show", ACCOUNT, "--json"],
      ["account", "show", LOGIN_ACCOUNT, "--json"],
      ["account", "disable", ACCOUNT],
      ["account", "enable", ACCOUNT],
    ]) {
      const result = await runCli(home, argv, undefined, env);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
      record(`cli:${argv.join(" ")}`, result);
    }

    const keyRun = await runCli(
      home,
      [
        "run",
        "--env",
        `X=vault://${ACCOUNT}`,
        "--",
        "node",
        "-e",
        compareScript("X", sha256(API_KEY)),
      ],
      undefined,
      env,
    );
    expect(keyRun.code, keyRun.stderr).toBe(0);
    expect(keyRun.stdout.trim()).toBe("OK");
    record("run (key)", keyRun);

    const loginRun = await runCli(
      home,
      [
        "run",
        "--env",
        `P=vault://${LOGIN_ACCOUNT}-login.password`,
        "--",
        "node",
        "-e",
        compareScript("P", sha256(PASSWORD)),
      ],
      undefined,
      env,
    );
    expect(loginRun.code, loginRun.stderr).toBe(0);
    expect(loginRun.stdout.trim()).toBe("OK");
    record("run (login)", loginRun);

    const redacted = await runCli(
      home,
      ["run", "--env", `X=vault://${ACCOUNT}`, "--", "node", "-e", "console.log(process.env.X)"],
      undefined,
      env,
    );
    expect(redacted.code, redacted.stderr).toBe(0);
    expect(redacted.stdout).toContain("[redacted]");
    record("run (redacted stdout)", redacted);

    // --- every file under SKELETONKEY_HOME, including the ciphertext ------
    for (const file of walk(home)) {
      surfaces.push({
        name: `file:${path.relative(home, file)}`,
        text: fs.readFileSync(file).toString("latin1"),
      });
    }

    expect(surfaces.length).toBeGreaterThan(15);
    const canaries = { api_key: API_KEY, password: PASSWORD, email: EMAIL, passphrase: PASSPHRASE };
    for (const surface of surfaces) {
      for (const [name, value] of Object.entries(canaries)) {
        expect(surface.text, `${surface.name} leaked ${name}`).not.toContain(value);
      }
    }

    // The ciphertext vault really exists and really is the secret store.
    const encPath = path.join(home, "vault.enc.json");
    expect(fs.existsSync(encPath)).toBe(true);
    expect(fs.statSync(encPath).size).toBeGreaterThan(0);

    const accountsYaml = fs.readFileSync(path.join(home, "accounts.yaml"), "utf8");
    expect(accountsYaml).toContain("NO SECRET VALUES ARE STORED HERE");
  });
});
