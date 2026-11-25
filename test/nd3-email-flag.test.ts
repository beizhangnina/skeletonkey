/**
 * ND-3: the removed plaintext `--email <value>` flag must be rejected
 * everywhere it could be typed, and its value must never be echoed back --
 * not on `account add` (which registers the flag only to produce a clear
 * rejection, see `rejectPlaintextEmailFlag` in src/accounts/cli.ts), and not
 * on `signup start`/`signup complete` (which never registered the flag at
 * all, so commander itself rejects it as unknown).
 *
 * `--email=<value>` on `signup start`/`signup complete` used to leak the value
 * through commander's "unknown option" error (ND-3-bug-email-equals-echo).
 * Fixed in nd-2-signup@5b80ae4; those cases are now plain `it`, plus a check
 * that no unknown `--flag=<value>` is ever echoed.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAccount } from "../src/accounts/store.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const CANARY_EMAIL = "nd3.canary.email@leak.example";
const FRAGMENT = "nd3.canary.email";

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function assertNoEcho(label: string, text: string): void {
  expect(text, `${label} echoed the email value`).not.toContain(CANARY_EMAIL);
  expect(text, `${label} echoed a fragment of the email`).not.toContain(FRAGMENT);
}

function assertNothingWritten(home: string): void {
  for (const file of filesUnder(home)) {
    const text = fs.readFileSync(file).toString("latin1");
    expect(text, `file:${path.relative(home, file)} contains the email`).not.toContain(CANARY_EMAIL);
    expect(text, `file:${path.relative(home, file)} contains a fragment`).not.toContain(FRAGMENT);
  }
}

describe("ND-3: plaintext --email is rejected, not echoed, and writes nothing", () => {
  let home: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    home = makeHome();
    globalThis.fetch = (() => {
      throw new Error("network disabled in tests");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    removeHome(home);
  });

  describe("account add", () => {
    beforeEach(async () => {
      const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
      expect(init.code, init.stderr).toBe(0);
    });

    it("--email <value> (space form)", async () => {
      const result = await runCli(home, [
        "account",
        "add",
        "flag-space",
        "--vendor",
        "apify",
        "--email",
        CANARY_EMAIL,
      ]);
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("no longer accepted");
      assertNoEcho("account add --email <value>", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("flag-space", home)).toBeUndefined();
      assertNothingWritten(home);
    });

    it("--email=<value> (equals form)", async () => {
      const result = await runCli(home, [
        "account",
        "add",
        "flag-equals",
        "--vendor",
        "apify",
        `--email=${CANARY_EMAIL}`,
      ]);
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("no longer accepted");
      assertNoEcho("account add --email=<value>", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("flag-equals", home)).toBeUndefined();
      assertNothingWritten(home);
    });

    it("--email alone (no value)", async () => {
      const result = await runCli(home, ["account", "add", "flag-alone", "--vendor", "apify", "--email"]);
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("no longer accepted");
      assertNoEcho("account add --email (alone)", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("flag-alone", home)).toBeUndefined();
      assertNothingWritten(home);
    });

    it("--email <value> placed before the positional name", async () => {
      const result = await runCli(home, [
        "account",
        "add",
        "--email",
        CANARY_EMAIL,
        "flag-before-name",
        "--vendor",
        "apify",
      ]);
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("no longer accepted");
      assertNoEcho("account add --email <value> (before name)", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("flag-before-name", home)).toBeUndefined();
      assertNothingWritten(home);
    });

    it("--email <value> combined with --store-key --stdin", async () => {
      const result = await runCli(
        home,
        [
          "account",
          "add",
          "flag-with-store-key",
          "--vendor",
          "apify",
          "--email",
          CANARY_EMAIL,
          "--store-key",
          "--domain",
          "api.apify.com",
          "--stdin",
        ],
        "sk-nd3-should-never-be-read",
      );
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("no longer accepted");
      assertNoEcho("account add --email + --store-key --stdin", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("flag-with-store-key", home)).toBeUndefined();
      assertNothingWritten(home);
    });
  });

  describe("signup complete / signup start", () => {
    beforeEach(async () => {
      const init = await runCli(
        home,
        ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
        undefined,
        { SKELETONKEY_PASSPHRASE: "nd3-email-flag-suite-passphrase" },
      );
      expect(init.code, init.stderr).toBe(0);
    });

    it("signup complete apify --email <value> --stdin", async () => {
      const result = await runCli(
        home,
        ["signup", "complete", "apify", "--email", CANARY_EMAIL, "--stdin"],
        "sk-nd3-should-never-be-read",
      );
      expect(result.code).not.toBe(0);
      assertNoEcho("signup complete --email <value>", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("apify-main", home)).toBeUndefined();
      assertNothingWritten(home);
    });

    // ND-3-bug-email-equals-echo, fixed in nd-2-signup@5b80ae4.
    it("signup complete apify --email=<value> --stdin", async () => {
      const result = await runCli(
        home,
        ["signup", "complete", "apify", `--email=${CANARY_EMAIL}`, "--stdin"],
        "sk-nd3-should-never-be-read",
      );
      expect(result.code).not.toBe(0);
      assertNoEcho("signup complete --email=<value>", `${result.stdout}\n${result.stderr}`);
      expect(findAccount("apify-main", home)).toBeUndefined();
      assertNothingWritten(home);
    });

    // ND-3-bug-email-equals-echo, fixed in nd-2-signup@5b80ae4.
    it("signup start apify --email=<value>", async () => {
      const result = await runCli(home, ["signup", "start", "apify", `--email=${CANARY_EMAIL}`]);
      expect(result.code).not.toBe(0);
      assertNoEcho("signup start --email=<value>", `${result.stdout}\n${result.stderr}`);
      assertNothingWritten(home);
    });

    it("an unknown --flag=<value> (e.g. a mistyped --key=sk-...) is never echoed", async () => {
      const secret = "sk-nd3-UNKNOWN-FLAG-VALUE-7c2e91";
      for (const argv of [
        ["signup", "complete", "apify", `--key=${secret}`, "--stdin"],
        ["account", "add", "u1", "--vendor", "apify", `--api-key=${secret}`],
      ]) {
        const result = await runCli(home, argv, "sk-nd3-should-never-be-read");
        expect(result.code).not.toBe(0);
        const out = `${result.stdout}\n${result.stderr}`;
        expect(out, argv.join(" ")).not.toContain(secret);
        expect(out, argv.join(" ")).not.toContain("7c2e91");
      }
      assertNothingWritten(home);
    });
  });
});
