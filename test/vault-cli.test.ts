/**
 * U7: the CLI wiring for `vault add|list|show|rm` and `run`.
 *
 * The contract these tests pin down is the *output*: a human (or an agent
 * reading a terminal) may see names, labels, references and lengths, and
 * nothing else. No value, not even a username.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entriesPath } from "../src/paths.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const USERNAME = "FAKE-canary-USER-0xC0FFEE55";
const PASSWORD = "FAKE-canary-LOGINPW-0xC0FFEE66";
const API_KEY = "sk-test-FAKE-canary-APIKEY-0xC0FFEE11";

describe("the vault CLI", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    expect(init.code, init.stderr).toBe(0);
  });
  afterEach(() => {
    removeHome(home);
  });

  it("stores a login and says only what is safe to say", async () => {
    const add = await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).toContain('Stored login "github-login"');
    expect(add.stdout).toContain("Fields stored: username, password");
    expect(add.stdout).toContain(`${USERNAME.length} and ${PASSWORD.length} chars`);
    expect(add.stdout).toContain(entriesPath(home));
    expect(add.stdout).toContain("vault://github-login.password");
    expect(add.stdout).toContain(
      "skeletonkey run --env GITHUB_LOGIN_PASSWORD=vault://github-login.password",
    );
    // Nothing that could be the secret itself.
    expect(add.stdout).not.toContain(PASSWORD);
    expect(add.stdout).not.toContain(USERNAME);
    expect(add.stderr).not.toContain(PASSWORD);
  });

  it("reads the username from the first line of stdin", async () => {
    const add = await runCli(home, ["vault", "add", "gh2", "--type", "login", "--stdin"], `${USERNAME}\n${PASSWORD}`);
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).not.toContain(USERNAME);

    const show = await runCli(home, ["vault", "show", "gh2", "--json"]);
    expect(show.code, show.stderr).toBe(0);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    // Not an address, so the hint keeps the first character only.
    expect(parsed["username_hint"]).toBe("F***");
    expect(show.stdout).not.toContain(USERNAME);
  });

  it("keeps the metadata file free of values", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const metadata = fs.readFileSync(entriesPath(home), "utf8");
    expect(metadata).not.toContain(PASSWORD);
    expect(metadata).not.toContain(USERNAME);
    expect(fs.statSync(entriesPath(home)).mode & 0o777).toBe(0o600);
  });

  it("refuses a --url that is not http(s), and stores nothing", async () => {
    const add = await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--url", "ftp://example.test", "--stdin"],
      `${USERNAME}\n${PASSWORD}`,
    );
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("error usage");
    // The secret must not be left behind in the vault.
    const vaultFile = path.join(home, "dev-vault.json");
    if (fs.existsSync(vaultFile)) {
      expect(fs.readFileSync(vaultFile, "utf8")).not.toContain(PASSWORD);
    }
    expect(fs.existsSync(entriesPath(home))).toBe(false);
  });

  it("refuses an empty password", async () => {
    const add = await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      "",
    );
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("empty password");
  });

  it("refuses a name that could not be addressed", async () => {
    const add = await runCli(
      home,
      ["vault", "add", "github.password", "--type", "login", "--stdin"],
      `${USERNAME}\n${PASSWORD}`,
    );
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("must not end in");
  });

  it("refuses a name that is already taken", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const again = await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    expect(again.code).toBe(75);
    expect(again.stderr).toContain("error name_taken");
  });

  it("overwrites with --yes", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const again = await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--yes", "--stdin", "--username", USERNAME],
      `${PASSWORD}-2`,
    );
    expect(again.code, again.stderr).toBe(0);
    const vault = fs.readFileSync(path.join(home, "dev-vault.json"), "utf8");
    expect(vault).toContain(`${PASSWORD}-2`);
    expect(vault).not.toContain(`"${PASSWORD}"`);
  });

  it("refuses to turn a login into an api_key, and the other way round", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const asKey = await runCli(
      home,
      [
        "vault",
        "add",
        "github-login",
        "--type",
        "api_key",
        "--yes",
        "--platform",
        "ExampleCo",
        "--domain",
        "api.example.test",
      ],
      API_KEY,
    );
    expect(asKey.code).toBe(75);
    expect(asKey.stderr).toContain("cannot become a api_key");
  });

  it("lists the entries, metadata only", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    await runCli(
      home,
      [
        "vault",
        "add",
        "voyage-personal",
        "--type",
        "api_key",
        "--platform",
        "Voyage AI",
        "--domain",
        "api.voyageai.com",
      ],
      API_KEY,
    );

    const list = await runCli(home, ["vault", "list"]);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain("NAME");
    expect(list.stdout).toContain("github-login");
    expect(list.stdout).toContain("voyage-personal");
    expect(list.stdout).toContain("login");
    expect(list.stdout).toContain("api_key");
    expect(list.stdout).not.toContain(PASSWORD);
    expect(list.stdout).not.toContain(USERNAME);
    expect(list.stdout).not.toContain(API_KEY);
  });

  it("lists the entries as JSON, with no field values in it", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const list = await runCli(home, ["vault", "list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    const entries = JSON.parse(list.stdout) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["name"]).toBe("github-login");
    expect(entries[0]?.["type"]).toBe("login");
    expect(entries[0]?.["fields"]).toEqual(["username", "password"]);
    // The JSON holds no key called `password` or `username` with a value in it.
    expect(list.stdout).not.toContain(PASSWORD);
    expect(list.stdout).not.toContain(USERNAME);
    expect(list.stdout).not.toMatch(/"(password|username)"\s*:\s*"(?!\[redacted\])/);
  });

  it("shows one entry with the references an agent may use", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const show = await runCli(home, ["vault", "show", "github-login"]);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toContain("vault://github-login.username");
    expect(show.stdout).toContain("vault://github-login.password");
    expect(show.stdout).toContain(
      "skeletonkey run --env GITHUB_LOGIN_PASSWORD=vault://github-login.password",
    );
    // The masked hint is a hint, not the username.
    expect(show.stdout).not.toContain(USERNAME);
    expect(show.stdout).not.toContain(PASSWORD);
  });

  it("shows one entry as JSON", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const show = await runCli(home, ["vault", "show", "github-login", "--json"]);
    expect(show.code, show.stderr).toBe(0);
    const parsed = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(parsed["refs"]).toEqual(["vault://github-login.username", "vault://github-login.password"]);
    expect(parsed["run_command"]).toContain("vault://github-login.password");
    expect(show.stdout).not.toContain(PASSWORD);
    expect(show.stdout).not.toContain(USERNAME);
  });

  it("reports an entry that does not exist", async () => {
    const show = await runCli(home, ["vault", "show", "nope"]);
    expect(show.code).toBe(66);
    expect(show.stderr).toContain("error entry_not_found");
  });

  it("removes an entry, the record and the row", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const rm = await runCli(home, ["vault", "rm", "github-login", "--yes"]);
    expect(rm.code, rm.stderr).toBe(0);
    const vault = fs.readFileSync(path.join(home, "dev-vault.json"), "utf8");
    expect(vault).not.toContain(PASSWORD);
    const list = await runCli(home, ["vault", "list"]);
    expect(list.stdout).not.toContain("github-login");
  });

  it("refuses to remove without confirmation when stdin is not a terminal", async () => {
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
    const rm = await runCli(home, ["vault", "rm", "github-login"]);
    expect(rm.code).toBe(64);
    expect(rm.stderr).toContain("Refusing to delete without confirmation");
  });

  it("reports an entry that does not exist when removing", async () => {
    const rm = await runCli(home, ["vault", "rm", "nope", "--yes"]);
    expect(rm.code).toBe(66);
  });

  it("refuses an api_key entry without a platform and a domain", async () => {
    const add = await runCli(home, ["vault", "add", "no-domain", "--type", "api_key"], API_KEY);
    expect(add.code).toBe(64);
    expect(add.stderr).toContain("--platform is required");
  });

  it("refuses the plaintext backend when the test switch is off", async () => {
    const add = await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
      { SKELETONKEY_ALLOW_TEST_BACKEND: "" },
    );
    expect(add.code).toBe(77);
    expect(add.stderr).toContain("error backend_refused");
  });
});

describe("the run CLI", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    expect(init.code, init.stderr).toBe(0);
    await runCli(
      home,
      ["vault", "add", "github-login", "--type", "login", "--stdin", "--username", USERNAME],
      PASSWORD,
    );
  });
  afterEach(() => {
    removeHome(home);
  });

  it("needs the -- separator", async () => {
    const result = await runCli(home, [
      "run",
      "--env",
      "P=vault://github-login.password",
      "node",
      "-e",
      "console.log(1)",
    ]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("run needs a command after --.");
  });

  it("needs a command after the --", async () => {
    const result = await runCli(home, ["run", "--env", "P=vault://github-login.password", "--"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("run needs a command after --.");
  });

  it("refuses a literal value without echoing it", async () => {
    const secret = "FAKE-canary-LITERAL-0xC0FFEEAA";
    const result = await runCli(home, ["run", "--env", `P=${secret}`, "--", "node", "-e", "0"]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("error usage");
    // The literal the user typed must not be repeated back to them.
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("0xC0FFEEAA");
    expect(result.stderr).toContain("[redacted]");
  });

  it("refuses a flag with no value without echoing it", async () => {
    const secret = "FAKE-canary-NOVALUE-0xC0FFEEAB";
    const result = await runCli(home, ["run", "--env", secret, "--", "node", "-e", "0"]);
    expect(result.code).toBe(64);
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("0xC0FFEEAB");
  });

  it("prints the plan and reads nothing on --dry-run", async () => {
    const result = await runCli(home, [
      "run",
      "--env",
      "GITHUB_PASSWORD=vault://github-login.password",
      "--dry-run",
      "--",
      "node",
      "-e",
      "0",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("GITHUB_PASSWORD -> vault://github-login.password");
    expect(result.stdout).not.toContain(PASSWORD);
    expect(result.stdout).not.toContain(USERNAME);
  });

  it("runs the command and passes its exit code on", async () => {
    const result = await runCli(home, [
      "run",
      "--env",
      "GITHUB_PASSWORD=vault://github-login.password",
      "--",
      process.execPath,
      "-e",
      "process.exit(7)",
    ]);
    expect(result.code).toBe(7);
  });
});
