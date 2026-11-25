/**
 * Regression tests for the three ND-3 bugs fixed on top of ND-2:
 *
 *   1. `--email=<value>` on `signup start`/`signup complete` echoed the
 *      value via commander's "unknown option" error; a top-level unknown
 *      `--foo=<value>` had the same problem.
 *   2. A card-number-shaped secret was accepted as an ordinary API key by
 *      `account add --store-key` and `signup complete`.
 *   3. A wrong `SKELETONKEY_PASSPHRASE` surfaced as exit code 1 with a bare
 *      `Error` for `signup complete`/`account add --store-key`, instead of
 *      68 (`vault_locked`) like `run` already produced.
 *
 * See tasks/ND-3-bug-*.md for the bug reports.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAccount } from "../src/accounts/store.js";
import { findKey } from "../src/keys.js";
import { sessionsForVendor } from "../src/signup/sessions.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const CANARY_EMAIL = "nd2fix.canary.email@leak.example";
const CANARY_PASS = "nd2fix-CANARY-PASSPHRASE";
const WRONG_PASS = "nd2fix-WRONG-PASSPHRASE";
const CANARY_CARD_BARE = "4242424242424242";
const CANARY_CARD_SPACED = "4242 4242 4242 4242";
const CANARY_CARD_DASHED = "4242-4242-4242-4242";
// 16 digits, same shape as a card, but fails the Luhn check -- must still be
// accepted as an ordinary key.
const NON_LUHN_16_DIGIT = "1234567890123459";

describe("ND-2 fixes: wrong passphrase -> vault_locked (68)", () => {
  let home: string;
  const env = { SKELETONKEY_PASSPHRASE: CANARY_PASS };

  beforeEach(async () => {
    home = makeHome();
    const init = await runCli(
      home,
      ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
      undefined,
      env,
    );
    expect(init.code, init.stderr).toBe(0);
    // Create the vault file so a decrypt is actually attempted below.
    const seed = await runCli(home, ["signup", "complete", "apify", "--stdin"], "sk-nd2fix-seed", env);
    expect(seed.code, seed.stderr).toBe(0);
  });

  afterEach(() => {
    removeHome(home);
  });

  it("signup complete with the wrong passphrase: exit 68, vault_locked, no stack, no passphrase echo", async () => {
    const result = await runCli(
      home,
      ["signup", "complete", "firecrawl", "--stdin"],
      "sk-nd2fix-wrong",
      { SKELETONKEY_PASSPHRASE: WRONG_PASS },
    );
    expect(result.code).toBe(68);
    expect(result.stderr).toMatch(/^skeletonkey signup complete: error vault_locked: /);
    expect(result.stderr).not.toContain(WRONG_PASS);
    expect(result.stderr).not.toContain("    at ");
    expect(findAccount("firecrawl-main", home)).toBeUndefined();
  });

  it("account add --store-key with the wrong passphrase: exit 68, vault_locked, no stack, no passphrase echo", async () => {
    const result = await runCli(
      home,
      ["account", "add", "wrongpass-acct", "--vendor", "apify", "--store-key", "--domain", "api.apify.com", "--stdin"],
      "sk-nd2fix-wrong",
      { SKELETONKEY_PASSPHRASE: WRONG_PASS },
    );
    expect(result.code).toBe(68);
    expect(result.stderr).toMatch(/^skeletonkey account add: error vault_locked: /);
    expect(result.stderr).not.toContain(WRONG_PASS);
    expect(result.stderr).not.toContain("    at ");
    expect(findAccount("wrongpass-acct", home)).toBeUndefined();
  });
});

describe("ND-2 fixes: a card-number-shaped secret is rejected, not bound", () => {
  let home: string;
  const env = { SKELETONKEY_PASSPHRASE: CANARY_PASS };

  beforeEach(async () => {
    home = makeHome();
    const init = await runCli(
      home,
      ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
      undefined,
      env,
    );
    expect(init.code, init.stderr).toBe(0);
  });

  afterEach(() => {
    removeHome(home);
  });

  for (const [label, card] of [
    ["bare", CANARY_CARD_BARE],
    ["spaced", CANARY_CARD_SPACED],
    ["dashed", CANARY_CARD_DASHED],
  ] as const) {
    it(`signup complete apify --stdin with a ${label} card number: exit 76, nothing bound, no digit echo`, async () => {
      const result = await runCli(home, ["signup", "complete", "apify", "--stdin"], card, env);
      expect(result.code).toBe(76);
      expect(result.stderr).toMatch(/^skeletonkey signup complete: error card_number_rejected: /);
      expect(result.stderr).not.toMatch(/\d{4}/);
      expect(findAccount("apify-main", home)).toBeUndefined();
      expect(findKey("apify-main", home)).toBeUndefined();
    });

    it(`account add --store-key --stdin with a ${label} card number: exit 76, nothing stored, no digit echo`, async () => {
      const result = await runCli(
        home,
        ["account", "add", "c1", "--vendor", "apify", "--store-key", "--domain", "api.apify.com", "--stdin"],
        card,
        env,
      );
      expect(result.code).toBe(76);
      expect(result.stderr).toMatch(/^skeletonkey account add: error card_number_rejected: /);
      expect(result.stderr).not.toMatch(/\d{4}/);
      expect(findAccount("c1", home)).toBeUndefined();
    });
  }

  it("signup complete with a card number leaves the signup session in needs_human, with no digits in it", async () => {
    const result = await runCli(home, ["signup", "complete", "apify", "--stdin"], CANARY_CARD_BARE, env);
    expect(result.code).toBe(76);
    const sessions = sessionsForVendor("apify", home);
    expect(sessions[0]?.state).toBe("needs_human");
    expect(sessions[0]?.reason).toBe("card_number_rejected");
    expect(JSON.stringify(sessions)).not.toContain("4242");
  });

  it("a 16-digit value that fails Luhn is accepted as an ordinary key (not every long digit string is a card)", async () => {
    const result = await runCli(home, ["signup", "complete", "apify", "--stdin"], NON_LUHN_16_DIGIT, env);
    expect(result.code, result.stderr).toBe(0);
    expect(findAccount("apify-main", home)).toBeDefined();
  });

  it("the vault is untouched after a rejected card-shaped secret", async () => {
    const before = await runCli(home, ["account", "list", "--json"], undefined, env);
    expect(before.code, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout)).toEqual([]);

    const rejected = await runCli(
      home,
      ["account", "add", "c2", "--vendor", "apify", "--store-key", "--domain", "api.apify.com", "--stdin"],
      CANARY_CARD_BARE,
      env,
    );
    expect(rejected.code).toBe(76);

    const after = await runCli(home, ["account", "list", "--json"], undefined, env);
    expect(after.code, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual([]);
  });
});

describe("ND-2 fixes: --email=<value> is rejected and never echoed", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });

  afterEach(() => {
    removeHome(home);
  });

  it("signup start apify --email=<value>: non-zero, email not echoed, nothing written", async () => {
    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    expect(init.code, init.stderr).toBe(0);

    const result = await runCli(home, ["signup", "start", "apify", `--email=${CANARY_EMAIL}`]);
    expect(result.code).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain(CANARY_EMAIL);
    expect(combined).not.toContain("nd2fix.canary.email");
  });

  it("signup complete apify --email=<value> --stdin: non-zero, email not echoed, nothing bound", async () => {
    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    expect(init.code, init.stderr).toBe(0);

    const result = await runCli(
      home,
      ["signup", "complete", "apify", `--email=${CANARY_EMAIL}`, "--stdin"],
      "sk-nd2fix-should-never-be-read",
    );
    expect(result.code).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain(CANARY_EMAIL);
    expect(combined).not.toContain("nd2fix.canary.email");
    expect(findAccount("apify-main", home)).toBeUndefined();
  });

  it("a totally unknown top-level --foo=<secret> is not echoed either", async () => {
    const result = await runCli(home, ["--foo=super-secret-value-xyz"]);
    expect(result.code).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain("super-secret-value-xyz");
    expect(combined).toContain("--foo=<redacted>");
  });

  it("an unknown --key=sk-... style flag is not echoed", async () => {
    const result = await runCli(home, ["account", "list", "--key=sk-should-not-be-echoed-anywhere"]);
    expect(result.code).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain("sk-should-not-be-echoed-anywhere");
    expect(combined).toContain("--key=<redacted>");
  });
});
