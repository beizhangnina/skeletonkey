/**
 * ND-3: with no driver injected -- the only path reachable from the CLI or an
 * agent -- `skeletonkey signup start` must always land on `needs_human`, and
 * every stop reason a trusted-host driver could report (captcha, phone,
 * oauth_consent, payment, key_pending, an unrecognized step, or an empty key)
 * must land there too, writing nothing to the vault and claiming no success.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callSkeletonKeyTool, type McpContext } from "../src/mcp.js";
import { findAccount } from "../src/accounts/store.js";
import { findKey } from "../src/keys.js";
import { cmdSignupStart } from "../src/signup/cli.js";
import { driveSignup, type Nd2SignupDriver, type Nd2SignupStep } from "../src/signup/drive.js";
import { readSignups } from "../src/signup/sessions.js";
import { SIGNUP_VENDORS } from "../src/signup/playbooks.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const FORBIDDEN_WORDS = ["success", "succeeded", "bound", "vault://"];

function assertNeverClaimsSuccess(label: string, text: string): void {
  const lowered = text.toLowerCase();
  for (const word of FORBIDDEN_WORDS) {
    expect(lowered, `${label} claimed success via "${word}"`).not.toContain(word.toLowerCase());
  }
}

describe("ND-3: no driver exists for any first-wave vendor -> always needs_human", () => {
  let home: string;
  let env: Record<string, string>;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    home = makeHome();
    env = { SKELETONKEY_PASSPHRASE: "nd3-no-driver-suite-passphrase" };
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    removeHome(home);
  });

  it("every first-wave vendor: signup start (text and --json) stops at needs_human/no_driver, writes nothing", async () => {
    expect(SIGNUP_VENDORS.length).toBe(6);
    for (const vendor of SIGNUP_VENDORS) {
      const text = await runCli(home, ["signup", "start", vendor, "--no-open"], undefined, env);
      expect(text.code, text.stderr).toBe(0);
      assertNeverClaimsSuccess(`signup start ${vendor} (text)`, `${text.stdout}\n${text.stderr}`);
      expect(text.stdout).toContain("needs_human");
      expect(text.stdout.toLowerCase()).toContain("no_driver");

      const json = await runCli(
        home,
        ["signup", "start", vendor, "--no-open", "--json"],
        undefined,
        env,
      );
      expect(json.code, json.stderr).toBe(0);
      assertNeverClaimsSuccess(`signup start ${vendor} (json)`, `${json.stdout}\n${json.stderr}`);
      const parsed = JSON.parse(json.stdout) as { status: string; reason: string | null; refs: string[] };
      expect(parsed.status).toBe("needs_human");
      expect(parsed.reason).toBe("no_driver");
      expect(parsed.refs).toEqual([]);

      expect(findAccount(`${vendor}-main`, home)).toBeUndefined();
      expect(findKey(`${vendor}-main`, home)).toBeUndefined();

      const statusResult = await runCli(home, ["signup", "status", vendor, "--json"], undefined, env);
      expect(statusResult.code, statusResult.stderr).toBe(0);
      const rows = JSON.parse(statusResult.stdout) as { state: string; reason: string | null }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.state).toBe("needs_human");
        expect(row.state).not.toBe("bound");
      }
    }

    // Nothing was ever stored: no vault file was ever created.
    expect(fs.existsSync(path.join(home, "vault.enc.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, "accounts.yaml"))).toBe(false);
    const keysPath = path.join(home, "keys.yaml");
    if (fs.existsSync(keysPath)) {
      for (const vendor of SIGNUP_VENDORS) {
        expect(findKey(`${vendor}-main`, home)).toBeUndefined();
      }
    }
  });

  it("in-process: driveSignup() with no driver is an honest needs_human/no_driver, nothing else", async () => {
    const outcome = await driveSignup(undefined);
    expect(outcome.status).toBe("needs_human");
    expect(outcome.handle).toBeNull();
    expect(outcome.reason).toBe("no_driver");
  });

  it.each([
    { kind: "captcha" as const, expectedReason: "captcha" },
    { kind: "phone" as const, expectedReason: "phone" },
    { kind: "oauth_consent" as const, expectedReason: "oauth_consent" },
    { kind: "payment" as const, expectedReason: "payment" },
    { kind: "key_pending" as const, expectedReason: "key_pending" },
  ])("driver stop step $kind -> needs_human/$expectedReason, nothing written", async ({ kind, expectedReason }) => {
    const driver: Nd2SignupDriver = { run: async () => ({ kind }) };
    const outcome = await driveSignup(driver);
    expect(outcome.status).toBe("needs_human");
    expect(outcome.handle).toBeNull();
    expect(outcome.reason).toBe(expectedReason);
  });

  it("driver returns an unrecognized step kind -> needs_human/unexpected_step", async () => {
    const driver: Nd2SignupDriver = {
      run: async () => ({ kind: "something_new" } as unknown as Nd2SignupStep),
    };
    const outcome = await driveSignup(driver);
    expect(outcome.status).toBe("needs_human");
    expect(outcome.handle).toBeNull();
    expect(outcome.reason).toBe("unexpected_step");
  });

  it.each(["", "   "])("driver completes with an empty/whitespace apiKey (%j) -> needs_human/key_unavailable", async (apiKey) => {
    const driver: Nd2SignupDriver = { run: async () => ({ kind: "complete", apiKey }) };
    const outcome = await driveSignup(driver);
    expect(outcome.status).toBe("needs_human");
    expect(outcome.handle).toBeNull();
    expect(outcome.reason).toBe("key_unavailable");
  });

  it("every stop-step driver, run through cmdSignupStart, stays needs_human and writes nothing to the vault", async () => {
    const steps: Nd2SignupStep[] = [
      { kind: "captcha" },
      { kind: "phone" },
      { kind: "oauth_consent" },
      { kind: "payment" },
      { kind: "key_pending" },
      { kind: "complete", apiKey: "" },
      { kind: "complete", apiKey: "   " },
    ];
    for (const [index, step] of steps.entries()) {
      const driver: Nd2SignupDriver = { run: async () => step };
      const account = `stop-step-${index}`;
      await cmdSignupStart("apify", { account, noOpen: true, json: false, driverFor: () => driver }, home);
      expect(findAccount(account, home)).toBeUndefined();
      const session = readSignups(home).sessions.find((s) => s.account === account);
      expect(session?.state).toBe("needs_human");
      expect(session?.state).not.toBe("bound");
    }
    expect(fs.existsSync(path.join(home, "vault.enc.json"))).toBe(false);
  });

  it("MCP signup_status for a vendor that was never started reports nothing bound", async () => {
    const ctx: McpContext = { home, allowTtyPrompt: false };
    const result = await callSkeletonKeyTool("signup_status", { vendor: "exa" }, ctx);
    const text = JSON.stringify(result);
    expect(text).not.toContain('"bound"');
    const body = JSON.parse(result.content[0]!.text) as { sessions: unknown[]; vendor_info: unknown };
    expect(body.sessions).toEqual([]);
    expect(body.vendor_info).not.toBeNull();
  });
});
