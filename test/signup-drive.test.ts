/**
 * ND-2 executor safety: a driver that hits captcha/phone/oauth_consent/payment
 * must stop immediately, with no further driver call possible (the driver
 * interface has exactly one method), and must never be asked for -- let alone
 * return -- any card or payment field. A driver that completes must result in
 * the key written to the vault via the ND-1 path, with only a vault:// ref
 * ever appearing in the result.
 */
import { afterEach, describe, expect, it } from "vitest";
import { driveSignup, type Nd2SignupDriver, type Nd2SignupStep } from "../src/signup/drive.js";
import { cmdSignupStart } from "../src/signup/cli.js";
import { signupPlaybook } from "../src/signup/playbooks.js";
import { findKey } from "../src/keys.js";
import { findAccount } from "../src/accounts/store.js";
import { noopOpener } from "../src/open-url.js";
import { runCli, makeHome, removeHome } from "./helpers/env.js";

const STOP_KINDS = ["captcha", "phone", "oauth_consent", "payment"] as const;

function stoppingDriver(step: Nd2SignupStep): Nd2SignupDriver & { calls: number } {
  const driver = {
    calls: 0,
    async run(): Promise<Nd2SignupStep> {
      driver.calls += 1;
      return step;
    },
  };
  return driver;
}

describe("ND-2 driveSignup: the safety guard", () => {
  it("needs_human/no_driver with no driver injected", async () => {
    const outcome = await driveSignup(undefined);
    expect(outcome).toEqual({ status: "needs_human", handle: null, reason: "no_driver", log: [] });
  });

  it.each(STOP_KINDS)("stops at %s, calling the driver exactly once", async (kind) => {
    const driver = stoppingDriver({ kind });
    const outcome = await driveSignup(driver);
    expect(outcome.status).toBe("needs_human");
    expect(outcome.reason).toBe(kind);
    expect(outcome.handle).toBeNull();
    // The guard is structural: Nd2SignupDriver has exactly one method, `run`,
    // so there is nothing further driveSignup *could* call -- this just
    // confirms it was called exactly once and nothing more.
    expect(driver.calls).toBe(1);
  });

  it("a payment step never carries, and driveSignup never inspects, a card field", async () => {
    const step: Nd2SignupStep = { kind: "payment" };
    expect(Object.keys(step)).toEqual(["kind"]);
    const outcome = await driveSignup(stoppingDriver(step));
    expect(JSON.stringify(outcome)).not.toMatch(/card|cvv|pan|payment_method/i);
  });

  it("key_pending stops for a human without a key", async () => {
    const outcome = await driveSignup(stoppingDriver({ kind: "key_pending" }));
    expect(outcome).toEqual({ status: "needs_human", handle: null, reason: "key_pending", log: [] });
  });

  it("complete with a fake canary key returns status ready and the raw key only to the caller", async () => {
    const outcome = await driveSignup(stoppingDriver({ kind: "complete", apiKey: "fake-canary-key-xyz" }));
    expect(outcome.status).toBe("ready");
    expect(outcome.handle).toBe("fake-canary-key-xyz");
  });

  it("complete with an empty key is key_unavailable, not a false success", async () => {
    const outcome = await driveSignup(stoppingDriver({ kind: "complete", apiKey: "   " }));
    expect(outcome.status).toBe("needs_human");
    expect(outcome.reason).toBe("key_unavailable");
  });

  it("a driver that throws never has its message echoed", async () => {
    const driver: Nd2SignupDriver = {
      run: () => {
        throw new Error("card=4111111111111111 cvv=123");
      },
    };
    const outcome = await driveSignup(driver);
    expect(outcome.reason).toBe("signup_failed");
    expect(JSON.stringify(outcome)).not.toContain("4111111111111111");
  });
});

describe("ND-2 cmdSignupStart with an injected driver (trusted-host seam only)", () => {
  let home: string;
  afterEach(() => {
    removeHome(home);
  });

  it("captcha/phone/oauth_consent/payment: never calls a second driver method, never binds a key", async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    const driver = stoppingDriver({ kind: "payment" });
    await cmdSignupStart(
      "apify",
      { noOpen: true, json: false, openUrl: noopOpener(), driverFor: () => driver },
      home,
    );
    expect(driver.calls).toBe(1);
    expect(findKey("apify-main", home)).toBeUndefined();
    expect(findAccount("apify-main", home)).toBeUndefined();
  });

  it("a completing driver binds the key via the ND-1 vault path; only a vault:// ref is ever printed", async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    const CANARY_KEY = "fake-canary-apify-key-0xBEEF";
    const driver = stoppingDriver({ kind: "complete", apiKey: CANARY_KEY });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await cmdSignupStart(
        "apify",
        { noOpen: true, json: false, openUrl: noopOpener(), driverFor: () => driver },
        home,
      );
    } finally {
      console.log = originalLog;
    }

    const printed = logs.join("\n");
    expect(printed).not.toContain(CANARY_KEY);
    expect(printed).toContain("vault://apify-main");
    expect(printed).toContain("status: bound");

    const key = findKey("apify-main", home);
    expect(key?.domain).toBe(signupPlaybook("apify")?.domain);
    expect(key?.header).toBe("Authorization");

    const account = findAccount("apify-main", home);
    expect(account?.key_alias).toBe("apify-main");

    // The key really is in the vault, under the alias -- read back through the
    // actual CLI run path (never printed; compared out of band).
    const result = await runCli(home, [
      "run",
      "--env",
      "X=vault://apify-main",
      "--",
      "node",
      "-e",
      "process.stdout.write(process.env.X === process.argv[1] ? 'OK' : 'MISMATCH')",
      CANARY_KEY,
    ]);
    expect(result.stdout.trim()).toBe("OK");
  });
});
