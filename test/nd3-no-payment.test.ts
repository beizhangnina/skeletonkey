/**
 * ND-3: SkeletonKey never handles a payment instrument itself.
 *
 * Static check that no card/billing field exists anywhere in the signup or
 * account code or in any MCP tool's input schema; a `payment` driver step
 * always lands on needs_human with run() called exactly once and nothing
 * written; `HumanHandoffPaymentSubmitter` always hands off to the human; and
 * a card-number-shaped string offered as an API key or signup secret is
 * refused with exit 76 (card_number_rejected), never stored, never echoed
 * (ND-3-bug-card-number-accepted-as-key, fixed in nd-2-signup@5b80ae4).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SKELETONKEY_TOOLS } from "../src/mcp.js";
import { findAccount } from "../src/accounts/store.js";
import { cmdSignupStart } from "../src/signup/cli.js";
import type { Nd2SignupDriver } from "../src/signup/drive.js";
import { readSignups } from "../src/signup/sessions.js";
import { HumanHandoffPaymentSubmitter, type PaymentSubmitContext } from "../src/payments.js";
import { decryptSecrets } from "../src/vault/encrypted-file.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const FORBIDDEN_IDENTIFIER = /card[_-]?number|cardNumber|\bcvv\b|\bcvc\b|expiry|billing[_-]?address|payment[_-]?method/i;
// Strict: field names that could only be a payment-instrument input.
const FORBIDDEN_SCHEMA_FIELD = /card[_-]?number|\bcvv\b|\bcvc\b|\bpan\b|expiry|payment[_-]?method|billing[_-]?(address|info|details)/i;
// Broad: the brief's literal pattern. Only two known vendor-metadata fields may match it
// (propose_entry.requires_card = boolean fact about the vendor; propose_entry.billing =
// the vendor's pricing model). Pinned by the "c-broad" test.
const BROAD_BILLING_PATTERN = /card|cvv|cvc|pan|expiry|payment_method|billing/i;

/** Strips block and line comments (but not "://") so a mention inside prose doesn't false-positive. */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*/g, "$1"))
    .join("\n");
}

function listTsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(dir, entry.name));
}

describe("ND-3: no payment instrument handling anywhere in signup/account code or MCP schemas", () => {
  it("a) no card/billing identifier appears outside comments in src/signup/*.ts or src/accounts/*.ts", () => {
    const files = [
      ...listTsFiles(path.join("src", "signup")),
      ...listTsFiles(path.join("src", "accounts")),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      expect(code, `${file} mentions a card/billing field outside comments`).not.toMatch(
        FORBIDDEN_IDENTIFIER,
      );
    }
  });

  it("a) Nd2SignupDriver declares exactly one method: run", () => {
    const source = fs.readFileSync(path.join("src", "signup", "drive.ts"), "utf8");
    const match = /export interface Nd2SignupDriver\s*{([^}]*)}/.exec(source);
    expect(match).not.toBeNull();
    const body = match![1]!;
    const methodLines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("/*"));
    expect(methodLines).toEqual(["run(): Promise<Nd2SignupStep>;"]);
  });

  describe("b) a payment driver step, run through cmdSignupStart", () => {
    it("lands on needs_human/payment, calls run() exactly once, and writes nothing", async () => {
      const home = makeHome();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error("network disabled in tests");
      }) as typeof fetch;
      try {
        const init = await runCli(
          home,
          ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
          undefined,
          { SKELETONKEY_PASSPHRASE: "nd3-no-payment-suite-passphrase" },
        );
        expect(init.code, init.stderr).toBe(0);

        const run = vi.fn(async () => ({ kind: "payment" as const }));
        const driver: Nd2SignupDriver = { run };

        await cmdSignupStart(
          "apify",
          { account: "payment-acct", noOpen: true, json: false, driverFor: () => driver },
          home,
        );

        expect(run).toHaveBeenCalledTimes(1);
        expect(findAccount("payment-acct", home)).toBeUndefined();
        const session = readSignups(home).sessions.find((s) => s.account === "payment-acct");
        expect(session?.state).toBe("needs_human");
        expect(session?.reason).toBe("payment");
        expect(session?.state).not.toBe("bound");
        expect(fs.existsSync(path.join(home, "vault.enc.json"))).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
        removeHome(home);
      }
    });
  });

  it("c) no MCP tool's input schema has a card/billing-shaped field; signup_status is read-only and takes no secret", () => {
    for (const tool of SKELETONKEY_TOOLS) {
      for (const field of Object.keys(tool.inputSchema)) {
        expect(field, `${tool.name}.inputSchema has a card/billing-shaped field "${field}"`).not.toMatch(
          FORBIDDEN_SCHEMA_FIELD,
        );
      }
    }
    const signupStatus = SKELETONKEY_TOOLS.find((tool) => tool.name === "signup_status");
    expect(signupStatus).toBeDefined();
    expect(signupStatus!.readOnly).toBe(true);
    const fields = Object.keys(signupStatus!.inputSchema);
    expect(fields).toEqual(["vendor"]);
    for (const field of fields) {
      expect(field).not.toMatch(/key|secret|password|token/i);
    }
  });

  it("c-broad) only known vendor-metadata fields match the broad card|...|billing pattern", () => {
    const hits: string[] = [];
    for (const tool of SKELETONKEY_TOOLS) {
      for (const field of Object.keys(tool.inputSchema)) {
        if (BROAD_BILLING_PATTERN.test(field)) hits.push(`${tool.name}.${field}`);
      }
    }
    expect(hits.sort()).toEqual(["propose_entry.billing", "propose_entry.requires_card"]);
  });

  it("d) HumanHandoffPaymentSubmitter always hands off: needs_human, charged_usd null", async () => {
    const submitter = new HumanHandoffPaymentSubmitter();
    const logs: string[] = [];
    const context: PaymentSubmitContext = {
      request_id: "req_nd3_payment_test",
      vendor: "TestVendor",
      domain: "api.test.example",
      amount_usd: 42,
      log: (line: string) => logs.push(line),
    };
    const outcome = await submitter.submit(context);
    expect(outcome.status).toBe("needs_human");
    expect(outcome.charged_usd).toBeNull();
    expect(outcome.reason).toBe("no_card_automation");
    expect(logs.length).toBeGreaterThan(0);
  });

  describe("e) a card-number-shaped string used as a signup/account 'key'", () => {
    let home: string;
    let env: Record<string, string>;
    const originalFetch = globalThis.fetch;

    async function setUp(): Promise<void> {
      home = makeHome();
      env = { SKELETONKEY_PASSPHRASE: "nd3-no-payment-cc-suite-passphrase" };
      globalThis.fetch = (() => {
        throw new Error("network disabled in tests");
      }) as typeof fetch;
      const init = await runCli(
        home,
        ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
        undefined,
        env,
      );
      expect(init.code, init.stderr).toBe(0);
    }

    function tearDown(): void {
      globalThis.fetch = originalFetch;
      removeHome(home);
    }

    // ND-3-bug-card-number-accepted-as-key, fixed in nd-2-signup@5b80ae4:
    // a card-number-shaped secret is refused with exit 76 (card_number_rejected),
    // never written to the vault, and never echoed.
    const DECOY_KEY = "sk-nd3-decoy-key-0a1b2c3d4e5f";

    /** Decrypts vault.enc.json in-process (never printed) and returns alias -> secret. */
    function vaultSecrets(): Record<string, string> {
      const file = JSON.parse(fs.readFileSync(path.join(home, "vault.enc.json"), "utf8"));
      return decryptSecrets(file, env.SKELETONKEY_PASSPHRASE!);
    }

    async function expectCardRejected(argv: string[], stdin: string, account: string): Promise<void> {
      // A decoy key first, so the encrypted vault really exists and can be inspected.
      const decoy = await runCli(home, ["signup", "complete", "exa", "--stdin"], DECOY_KEY, env);
      expect(decoy.code, decoy.stderr).toBe(0);

      const result = await runCli(home, argv, stdin, env);
      expect(result.code, result.stderr).toBe(76);
      const out = `${result.stdout}\n${result.stderr}`;
      expect(out).not.toContain(stdin.trim());
      expect(out).not.toContain(CARD_DIGITS);

      expect(findAccount(account, home)).toBeUndefined();
      const secrets = vaultSecrets();
      expect(Object.values(secrets)).toContain(DECOY_KEY); // the vault was readable
      for (const [alias, value] of Object.entries(secrets)) {
        expect(alias.startsWith(account), `vault has an entry for ${account}`).toBe(false);
        expect(value.replace(/[ -]/g, ""), `vault entry ${alias} holds the card number`).not.toBe(CARD_DIGITS);
      }
    }

    const CARD_DIGITS = "4242424242424242";

    it("signup complete apify --stdin with a bare 16-digit card number -> exit 76, nothing stored, not echoed", async () => {
      await setUp();
      try {
        await expectCardRejected(["signup", "complete", "apify", "--stdin"], "4242424242424242", "apify-main");
      } finally {
        tearDown();
      }
    });

    it("signup complete apify --stdin with a spaced 16-digit card number -> exit 76, nothing stored, not echoed", async () => {
      await setUp();
      try {
        await expectCardRejected(["signup", "complete", "apify", "--stdin"], "4242 4242 4242 4242", "apify-main");
      } finally {
        tearDown();
      }
    });

    it("account add --store-key --stdin with a bare 16-digit card number -> exit 76, nothing stored, not echoed", async () => {
      await setUp();
      try {
        await expectCardRejected(
          ["account", "add", "c1", "--vendor", "apify", "--store-key", "--domain", "api.apify.com", "--stdin"],
          "4242424242424242",
          "c1",
        );
      } finally {
        tearDown();
      }
    });

    it("whatever happens, the card number itself never appears in stdout/stderr or any plaintext file under home", async () => {
      await setUp();
      try {
        const CARD = "4242424242424242";
        const result = await runCli(home, ["signup", "complete", "apify", "--stdin"], CARD, env);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(CARD);

        const walk = (dir: string): string[] => {
          const out: string[] = [];
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...walk(full));
            else out.push(full);
          }
          return out;
        };
        for (const file of walk(home)) {
          if (file.endsWith("vault.enc.json")) continue; // ciphertext; the card is encrypted, not plaintext
          const text = fs.readFileSync(file).toString("latin1");
          expect(text, `file:${path.relative(home, file)} contains the card number in plaintext`).not.toContain(
            CARD,
          );
        }
      } finally {
        tearDown();
      }
    });
  });
});
