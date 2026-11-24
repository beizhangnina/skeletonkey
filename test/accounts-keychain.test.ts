/**
 * ND-1 backend coverage: the `keychain` backend via a fixture `secret-tool`.
 *
 * This box has no OS keychain, so `src/vault/keychain.ts`'s Linux branch is
 * exercised against a fake `secret-tool` executable (see
 * test/helpers/secret-tool-fixture.ts) placed first on PATH -- NOT a real OS
 * keyring. Every test below says so in its title.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSecretToolFixture } from "./helpers/secret-tool-fixture.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const API_KEY = "sk-canary-ND1-KEYCHAIN-0003";
const PASSWORD = "canary-ND1-KEYCHAIN-PW-0004";
const EMAIL = "canary-nd1-keychain@example.test";

describe("the keychain backend via fixture secret-tool (not a real OS keyring)", () => {
  let home: string;
  let fixtureDir: string;
  let storeFile: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    home = makeHome();
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-tool-fixture-"));
    const fixture = writeSecretToolFixture(fixtureDir);
    storeFile = fixture.storeFile;
    env = {
      PATH: `${fixtureDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SECRET_TOOL_FIXTURE_STORE: storeFile,
    };
    const init = await runCli(
      home,
      ["init", "--email", "dev@example.test", "--backend", "keychain"],
      undefined,
      env,
    );
    expect(init.code, init.stderr).toBe(0);
  });

  afterEach(() => {
    removeHome(home);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("account add --store-key writes through the fixture secret-tool, never to a repo file", async () => {
    const add = await runCli(
      home,
      [
        "account",
        "add",
        "apify-kc",
        "--vendor",
        "apify",
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      API_KEY,
      env,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).not.toContain(API_KEY);

    // The secret is in the fixture's backing store, not anywhere under home.
    const backing = fs.readFileSync(storeFile, "utf8");
    expect(backing).toContain(API_KEY);
    for (const file of walk(home)) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(API_KEY);
    }
  });

  it("run --env injects the key read back through the fixture secret-tool", async () => {
    await runCli(
      home,
      [
        "account",
        "add",
        "apify-kc",
        "--vendor",
        "apify",
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      API_KEY,
      env,
    );
    const result = await runCli(
      home,
      [
        "run",
        "--env",
        "X=vault://apify-kc",
        "--",
        "node",
        "-e",
        "require('crypto').createHash('sha256').update(process.env.X).digest('hex')",
      ],
      undefined,
      env,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("account disable flips the key off, so run refuses it", async () => {
    await runCli(
      home,
      [
        "account",
        "add",
        "apify-kc",
        "--vendor",
        "apify",
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      API_KEY,
      env,
    );
    const disable = await runCli(home, ["account", "disable", "apify-kc"], undefined, env);
    expect(disable.code, disable.stderr).toBe(0);

    const result = await runCli(
      home,
      ["run", "--env", "X=vault://apify-kc", "--", "node", "-e", "0"],
      undefined,
      env,
    );
    expect(result.code).toBe(71);

    const enable = await runCli(home, ["account", "enable", "apify-kc"], undefined, env);
    expect(enable.code, enable.stderr).toBe(0);
    const again = await runCli(
      home,
      ["run", "--env", "X=vault://apify-kc", "--", "node", "-e", "0"],
      undefined,
      env,
    );
    expect(again.code).toBe(0);
  });

  it("builds the login half (apify-kc-login) through the same fixture backend", async () => {
    const add = await runCli(
      home,
      ["account", "add", "login-kc", "--vendor", "apify", "--email", EMAIL, "--store-login", "--stdin"],
      PASSWORD,
      env,
    );
    expect(add.code, add.stderr).toBe(0);
    const backing = fs.readFileSync(storeFile, "utf8");
    expect(backing).toContain(PASSWORD);
    expect(backing).toContain(EMAIL);
    for (const file of walk(home)) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(PASSWORD);
      expect(fs.readFileSync(file, "utf8")).not.toContain(EMAIL);
    }
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
