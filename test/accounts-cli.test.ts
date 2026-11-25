/**
 * ND-1: `skeletonkey account add|list|show|disable|enable`.
 *
 * Mirrors the contract test/vault-cli.test.ts pins down for `vault *`: the
 * output may show names, hints and references, and nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountsPath, entriesPath, keysPath } from "../src/paths.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const API_KEY = "sk-canary-ND1-TESTKEY-0001";
const PASSWORD = "canary-ND1-PASSWORD-0002";
const EMAIL = "canary-nd1-tester@example.test";

describe("the account CLI", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    expect(init.code, init.stderr).toBe(0);
  });
  afterEach(() => {
    removeHome(home);
  });

  it("registers an account with a freshly stored key", async () => {
    const add = await runCli(
      home,
      [
        "account",
        "add",
        "apify-main",
        "--vendor",
        "apify",
        "--registered",
        "2026-01-15",
        "--email-stdin",
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      `${EMAIL}\n${API_KEY}`,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).toContain('Registered account "apify-main"');
    expect(add.stdout).toContain("vault://apify-main (api key)");
    expect(add.stdout).not.toContain(API_KEY);
    expect(add.stdout).not.toContain(EMAIL);

    const show = await runCli(home, ["account", "show", "apify-main", "--json"]);
    expect(show.code, show.stderr).toBe(0);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(parsed["vendor"]).toBe("apify");
    expect(parsed["registered"]).toBe("2026-01-15");
    expect(parsed["key_alias"]).toBe("apify-main");
    expect(parsed["email_hint"]).toMatch(/^c\*+@example\.test$/);
    expect(parsed["refs"]).toEqual(["vault://apify-main"]);
    expect(show.stdout).not.toContain(EMAIL);
    expect(show.stdout).not.toContain(API_KEY);

    // The secret really was stored, through the normal api_key path.
    const list = await runCli(home, ["list"]);
    expect(list.stdout).toContain("apify-main");
  });

  it("registers an account with a freshly stored login (email becomes the username)", async () => {
    const add = await runCli(
      home,
      ["account", "add", "github-acct", "--vendor", "treg", "--email-stdin", "--store-login", "--stdin"],
      `${EMAIL}\n${PASSWORD}`,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).toContain("vault://github-acct-login.password");
    expect(add.stdout).not.toContain(PASSWORD);
    expect(add.stdout).not.toContain(EMAIL);

    const show = await runCli(home, ["account", "show", "github-acct", "--json"]);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(parsed["login_entry"]).toBe("github-acct-login");
    expect(parsed["refs"]).toEqual([
      "vault://github-acct-login.username",
      "vault://github-acct-login.password",
    ]);

    // Neither accounts.yaml nor entries.yaml ever holds the plaintext email.
    expect(fs.readFileSync(accountsPath(home), "utf8")).not.toContain(EMAIL);
    expect(fs.readFileSync(entriesPath(home), "utf8")).not.toContain(EMAIL);
    expect(fs.readFileSync(entriesPath(home), "utf8")).not.toContain(PASSWORD);
  });

  it("links an existing api_key entry with --key-alias", async () => {
    await runCli(
      home,
      ["add", "existing-key", "--platform", "ExampleCo", "--domain", "api.example.test"],
      API_KEY,
    );
    const add = await runCli(home, [
      "account",
      "add",
      "linked-acct",
      "--vendor",
      "apify",
      "--key-alias",
      "existing-key",
    ]);
    expect(add.code, add.stderr).toBe(0);
    const show = await runCli(home, ["account", "show", "linked-acct", "--json"]);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(parsed["key_alias"]).toBe("existing-key");
  });

  it("refuses --key-alias pointing at an entry that does not exist", async () => {
    const add = await runCli(home, [
      "account",
      "add",
      "linked-acct",
      "--vendor",
      "apify",
      "--key-alias",
      "does-not-exist",
    ]);
    expect(add.code).toBe(66);
    expect(add.stderr).toContain("error entry_not_found");
  });

  it("warns, but still accepts, a vendor id that is not in the bundled index", async () => {
    const add = await runCli(home, [
      "account",
      "add",
      "mystery-acct",
      "--vendor",
      "totally-unknown-vendor-xyz",
    ]);
    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain("not in the bundled API index");
    const show = await runCli(home, ["account", "show", "mystery-acct"]);
    expect(show.code).toBe(0);
  });

  it("rejects a malformed vendor id", async () => {
    const add = await runCli(home, ["account", "add", "bad-vendor-acct", "--vendor", "Not_Valid!"]);
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("error usage");
  });

  it("rejects a malformed --registered date", async () => {
    const add = await runCli(home, [
      "account",
      "add",
      "bad-date-acct",
      "--vendor",
      "apify",
      "--registered",
      "2026-02-30",
    ]);
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("error usage");
  });

  it("refuses a name that is already taken without --yes", async () => {
    await runCli(home, ["account", "add", "dup-acct", "--vendor", "apify"]);
    const again = await runCli(home, ["account", "add", "dup-acct", "--vendor", "apify"]);
    expect(again.code).toBe(75);
    expect(again.stderr).toContain("error name_taken");
  });

  it("refuses --store-key and --store-login together with --stdin (one secret only)", async () => {
    const add = await runCli(
      home,
      [
        "account",
        "add",
        "both-secrets",
        "--vendor",
        "apify",
        "--store-key",
        "--domain",
        "api.example.test",
        "--store-login",
        "--stdin",
      ],
      API_KEY,
    );
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("error usage");
  });

  it("rolls back a freshly stored key when a later step in the same add fails", async () => {
    const add = await runCli(
      home,
      [
        "account",
        "add",
        "rollback-acct",
        "--vendor",
        "apify",
        "--store-key",
        "--domain",
        "api.example.test",
        "--stdin",
        "--store-login",
        "--url",
        "ftp://not-http",
        "--email-stdin",
      ],
      `${EMAIL}\n${API_KEY}`,
    );
    expect(add.code).toBe(64);
    // Nothing was left behind: no account row, no orphaned key.
    const show = await runCli(home, ["account", "show", "rollback-acct"]);
    expect(show.code).toBe(66);
    const vaultShow = await runCli(home, ["vault", "show", "rollback-acct"]);
    expect(vaultShow.code).toBe(66);
    expect(fs.readFileSync(keysPath(home), "utf8")).not.toContain("rollback-acct");
  });

  it("lists accounts as a table and as JSON, metadata only", async () => {
    await runCli(home, ["account", "add", "acct-one", "--vendor", "apify", "--email-stdin"], EMAIL);
    await runCli(home, ["account", "add", "acct-two", "--vendor", "treg"]);
    await runCli(home, ["account", "disable", "acct-two"]);

    const list = await runCli(home, ["account", "list"]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain("acct-one");
    expect(list.stdout).toContain("acct-two");
    expect(list.stdout).toContain("active");
    expect(list.stdout).toContain("disabled");
    expect(list.stdout).not.toContain(EMAIL);

    const active = await runCli(home, ["account", "list", "--active"]);
    expect(active.stdout).toContain("acct-one");
    expect(active.stdout).not.toContain("acct-two");

    const json = await runCli(home, ["account", "list", "--json"]);
    const rows = JSON.parse(json.stdout) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(json.stdout).not.toContain(EMAIL);
  });

  it("reports an account that does not exist", async () => {
    const show = await runCli(home, ["account", "show", "nope"]);
    expect(show.code).toBe(66);
    expect(show.stderr).toContain("error entry_not_found");

    const disable = await runCli(home, ["account", "disable", "nope"]);
    expect(disable.code).toBe(66);
  });

  it("disable/enable flips the account and its linked key, and is idempotent", async () => {
    await runCli(
      home,
      ["account", "add", "flip-acct", "--vendor", "apify", "--store-key", "--domain", "api.example.test", "--stdin"],
      API_KEY,
    );

    const disable1 = await runCli(home, ["account", "disable", "flip-acct"]);
    expect(disable1.code, disable1.stderr).toBe(0);
    let show = await runCli(home, ["account", "show", "flip-acct", "--json"]);
    expect((JSON.parse(show.stdout) as Record<string, unknown>)["disabled"]).toBe(true);
    let list = await runCli(home, ["list", "--json"]);
    expect((JSON.parse(list.stdout) as Record<string, unknown>[])[0]?.["disabled"]).toBe(true);

    // Idempotent: disabling again does not error and leaves the same state.
    const disable2 = await runCli(home, ["account", "disable", "flip-acct"]);
    expect(disable2.code, disable2.stderr).toBe(0);

    const enable1 = await runCli(home, ["account", "enable", "flip-acct"]);
    expect(enable1.code, enable1.stderr).toBe(0);
    show = await runCli(home, ["account", "show", "flip-acct", "--json"]);
    expect((JSON.parse(show.stdout) as Record<string, unknown>)["disabled"]).toBe(false);
    list = await runCli(home, ["list", "--json"]);
    expect((JSON.parse(list.stdout) as Record<string, unknown>[])[0]?.["disabled"]).toBe(false);

    const enable2 = await runCli(home, ["account", "enable", "flip-acct"]);
    expect(enable2.code, enable2.stderr).toBe(0);
  });

  it("refuses a plaintext --email value, with or without an argument, and writes nothing", async () => {
    const withValue = await runCli(home, ["account", "add", "email-flag-acct", "--vendor", "apify", "--email", EMAIL]);
    expect(withValue.code).toBe(64);
    expect(withValue.stderr).toContain(
      "skeletonkey account add: error usage: --email <value> is no longer accepted: " +
        "it would stay in shell history and the process list.",
    );
    expect(withValue.stderr).toContain(
      "hint: Type it at the hidden prompt, or pipe it with --email-stdin.",
    );
    expect(withValue.stdout).not.toContain(EMAIL);
    expect(withValue.stderr).not.toContain(EMAIL);

    const bareFlag = await runCli(home, ["account", "add", "email-flag-acct", "--vendor", "apify", "--email"]);
    expect(bareFlag.code).toBe(64);
    expect(bareFlag.stderr).toContain("--email <value> is no longer accepted");

    const show = await runCli(home, ["account", "show", "email-flag-acct"]);
    expect(show.code).toBe(66); // nothing was ever written
  });

  it("reads the account email from a single line on stdin with --email-stdin, never from argv", async () => {
    const argv = ["account", "add", "stdin-email-acct", "--vendor", "apify", "--email-stdin"];
    expect(argv.join(" ")).not.toContain(EMAIL);

    const add = await runCli(home, argv, EMAIL);
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).not.toContain(EMAIL);

    const show = await runCli(home, ["account", "show", "stdin-email-acct", "--json"]);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(parsed["email_hint"]).toMatch(/^c\*+@example\.test$/);
    expect(show.stdout).not.toContain(EMAIL);
    expect(fs.readFileSync(accountsPath(home), "utf8")).not.toContain(EMAIL);
  });

  it("reads email (line 1) and secret (line 2) on stdin with --email-stdin --stdin", async () => {
    const add = await runCli(
      home,
      [
        "account",
        "add",
        "two-line-acct",
        "--vendor",
        "apify",
        "--email-stdin",
        "--store-key",
        "--domain",
        "api.example.test",
        "--stdin",
      ],
      `${EMAIL}\n${API_KEY}`,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).not.toContain(EMAIL);
    expect(add.stdout).not.toContain(API_KEY);

    const show = await runCli(home, ["account", "show", "two-line-acct", "--json"]);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(parsed["email_hint"]).toMatch(/^c\*+@example\.test$/);
    expect(parsed["key_alias"]).toBe("two-line-acct");
  });

  it("rejects an empty line on stdin with --email-stdin", async () => {
    const add = await runCli(home, ["account", "add", "empty-email-acct", "--vendor", "apify", "--email-stdin"], "");
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("error usage");
    expect(add.stderr).toContain("An empty email is not a value");
  });

  it("rejects more than one line on stdin with --email-stdin alone", async () => {
    const add = await runCli(
      home,
      ["account", "add", "multiline-email-acct", "--vendor", "apify", "--email-stdin"],
      `${EMAIL}\nextra-line`,
    );
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("error usage");
    expect(add.stderr).toContain("--email-stdin expects a single line on stdin");
  });

  it("rejects anything other than exactly two lines with --email-stdin --stdin", async () => {
    const oneLine = await runCli(
      home,
      [
        "account",
        "add",
        "two-line-short-acct",
        "--vendor",
        "apify",
        "--email-stdin",
        "--store-key",
        "--domain",
        "api.example.test",
        "--stdin",
      ],
      EMAIL,
    );
    expect(oneLine.code).toBe(64);
    expect(oneLine.stderr).toContain("expects exactly two lines on stdin");

    const threeLines = await runCli(
      home,
      [
        "account",
        "add",
        "two-line-long-acct",
        "--vendor",
        "apify",
        "--email-stdin",
        "--store-key",
        "--domain",
        "api.example.test",
        "--stdin",
      ],
      `${EMAIL}\n${API_KEY}\nextra`,
    );
    expect(threeLines.code).toBe(64);
    expect(threeLines.stderr).toContain("expects exactly two lines on stdin");
  });

  it("disabled key via an account makes `run` refuse it", async () => {
    await runCli(
      home,
      ["account", "add", "run-acct", "--vendor", "apify", "--store-key", "--domain", "api.example.test", "--stdin"],
      API_KEY,
    );
    await runCli(home, ["account", "disable", "run-acct"]);
    const result = await runCli(home, [
      "run",
      "--env",
      "X=vault://run-acct",
      "--",
      "node",
      "-e",
      "0",
    ]);
    expect(result.code).toBe(71);
    expect(result.stderr).toContain("error entry_disabled");
  });
});
