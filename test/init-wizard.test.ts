/**
 * The interactive `skeletonkey init` wizard (v0.3).
 *
 * Every step is driven here through injected fakes -- a scripted prompt, a
 * fake `bw`, a fake browser opener and a temp `SKELETONKEY_HOME` -- so the
 * suite never installs Bitwarden, never opens a browser, and never touches a
 * real vault.
 *
 * Three properties are asserted over and over, because they are the point:
 *
 *   - **no master password is ever requested or passed to `bw`**: the wizard
 *     prints the commands and the human runs them;
 *   - **the card number is never read**: step 5 looks at item names only;
 *   - **caps only move through the human-only policy writer**, recorded as
 *     `cli`, which is the same path `skeletonkey policy set` uses.
 *
 * Two more, added with the skippable steps:
 *
 *   - **only the email is mandatory.** Every other step can be deferred, and
 *     no deferral aborts the run -- step 2 in particular finishes `init`
 *     whether the human sets Bitwarden up, takes the `encrypted-file` vault
 *     instead, or leaves it for later. (The one path that still refuses is the
 *     explicit non-interactive one; that lives in `test/bw-cli.test.ts`.)
 *   - **every deferred item names a command that exists.** The summary's
 *     commands are resolved against the real `buildProgram()` command tree, so
 *     a renamed verb fails here rather than in a human's terminal.
 *
 * The `--yes` / non-TTY path is asserted to be the old straight-line setup
 * with no wizard output at all -- that is the CI contract.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import {
  BITWARDEN_FALLBACK_BACKEND,
  BITWARDEN_REGISTER_URL,
  CARD_ITEM_NAME,
  FINISH_COMMANDS,
  SKIPPED,
  TICK,
  TODO,
  ask,
  assertNotSecret,
  cardItemPresent,
  isEmail,
  printSummary,
  runInitWizard,
  stepBitwarden,
  stepCard,
  stepEmail,
  stepInbox,
  stepSpendCaps,
  summarySections,
  type WizardDeps,
  type WizardIo,
  type WizardPlan,
  type WizardResult,
} from "../src/init-wizard.js";
import { buildProgram } from "../src/cli.js";
import { defaultPolicy, policyPath, readPolicy, vendorCap } from "../src/policy.js";
import { noopOpener } from "../src/open-url.js";
import type { BwAccount, BwRunner } from "../src/vault/bw-account.js";
import { CLI, makeHome, removeHome, runCli } from "./helpers/env.js";
import { installFakeBw } from "./helpers/fake-bw.js";

const BOUND = "apis@example.test";
/** A card number that must never appear in any wizard output. */
const CARD_NUMBER = "4111111111111111";
const CARD_CVV = "123";
/** A master password, to prove nothing here ever asks for or forwards one. */
const MASTER_PASSWORD = "FAKE-master-password-never-asked";

type Answer = string | (() => string);

interface FakeIo {
  io: WizardIo;
  /** Every question put to the human, in order. */
  asked: string[];
  lines: string[];
  output(): string;
  remaining(): number;
}

/**
 * A prompt that answers from a script. `""` means "the human pressed Enter",
 * so the wizard's own fallback applies, exactly like `promptLine`.
 */
function fakeIo(answers: Answer[] = []): FakeIo {
  const queue = [...answers];
  const asked: string[] = [];
  const lines: string[] = [];
  const io: WizardIo = {
    prompt: async (question, fallback) => {
      asked.push(question);
      if (queue.length === 0) {
        throw new Error(`the wizard asked an unscripted question: ${JSON.stringify(question)}`);
      }
      const next = queue.shift() as Answer;
      const answer = typeof next === "function" ? next() : next;
      return answer === "" && fallback !== undefined ? fallback : answer;
    },
    print: (line) => lines.push(line),
  };
  return {
    io,
    asked,
    lines,
    output: () => lines.join("\n"),
    remaining: () => queue.length,
  };
}

interface FakeBw {
  runner: BwRunner;
  /** Every argv `bw` was handed, in order. */
  calls: string[][];
  /** Everything ever written to `bw` on stdin. */
  stdin: string[];
  state: { state: string; userEmail: string | null; items: unknown[]; missing: boolean };
}

function fakeBw(
  options: {
    state?: "unlocked" | "locked" | "unauthenticated";
    userEmail?: string | null;
    items?: unknown[];
    missing?: boolean;
  } = {},
): FakeBw {
  const calls: string[][] = [];
  const stdin: string[] = [];
  const state = {
    state: options.state ?? "unlocked",
    userEmail: options.userEmail ?? null,
    items: options.items ?? [],
    missing: options.missing === true,
  };
  const runner: BwRunner = async (args, input) => {
    calls.push([...args]);
    if (input !== undefined) stdin.push(input);
    if (state.missing) throw new Error("`bw` was not found on PATH.");
    if (args[0] === "status") {
      return {
        code: 0,
        stdout: JSON.stringify({
          serverUrl: null,
          userEmail: state.userEmail,
          status: state.state,
        }),
        stderr: "",
      };
    }
    if (args[0] === "list") return { code: 0, stdout: JSON.stringify(state.items), stderr: "" };
    return { code: 1, stdout: "", stderr: `fake bw: unexpected ${args.join(" ")}` };
  };
  return { runner, calls, stdin, state };
}

function deps(io: FakeIo, bw: FakeBw, opened: string[] = []): WizardDeps {
  return {
    io: io.io,
    bw: bw.runner,
    openUrl: async (url) => {
      opened.push(url);
      return true;
    },
  };
}

/** A locked `bw`, as `bwAccountStatus` reports it. */
const LOCKED_BW: BwAccount = {
  state: "locked",
  usable: false,
  account: null,
  bound: BOUND,
  matchesBound: null,
  summary: "the `bw` CLI is logged in but locked",
};

/** The card item a human made in Bitwarden's own app, number and all. */
const CARD_ITEM = {
  id: "item-card",
  name: CARD_ITEM_NAME,
  type: 3,
  card: { number: CARD_NUMBER, code: CARD_CVV, expMonth: "04", expYear: "2030" },
};

describe("step 1: the bound email", () => {
  it("recommends a dedicated address and takes the typed one", async () => {
    const io = fakeIo([BOUND]);
    const email = await stepEmail(deps(io, fakeBw()), {});
    expect(email).toBe(BOUND);
    expect(io.output()).toMatch(/Step 1\/6\s+Email/);
    expect(io.output()).toMatch(/Recommended: a brand-new address used only for API signups/);
    expect(io.output()).toContain(`${TICK} bound email ${BOUND}`);
  });

  it("says out loud that this is the one required answer", async () => {
    const io = fakeIo([BOUND]);
    await stepEmail(deps(io, fakeBw()), {});
    expect(io.output()).toContain("the one answer `init` cannot do without");
    expect(io.output()).toMatch(/every step after it can be\s*\n?\s*deferred/);
  });

  it("gives up rather than inventing an address when nothing usable is typed", async () => {
    // The only mandatory step: five bad answers end the run, because there is
    // nothing to file vendor accounts under.
    const io = fakeIo(["a", "b", "c", "d", "e"]);
    await expect(stepEmail(deps(io, fakeBw()), {})).rejects.toThrow(
      /nothing to bind accounts to/,
    );
  });

  it("re-asks on a malformed address instead of accepting it", async () => {
    const io = fakeIo(["not-an-email", BOUND]);
    const email = await stepEmail(deps(io, fakeBw()), {});
    expect(email).toBe(BOUND);
    expect(io.asked).toHaveLength(2);
    expect(io.output()).toContain(`${TODO} "not-an-email" does not look like an email address.`);
  });

  it("asks nothing when --email was given", async () => {
    const io = fakeIo();
    expect(await stepEmail(deps(io, fakeBw()), { email: BOUND })).toBe(BOUND);
    expect(io.asked).toEqual([]);
    expect(io.output()).toContain("(from --email)");
  });

  it("refuses a malformed --email rather than prompting past it", async () => {
    const io = fakeIo();
    await expect(stepEmail(deps(io, fakeBw()), { email: "nope" })).rejects.toThrow(
      /does not look like an email address/,
    );
  });

  it("knows an address from a non-address", () => {
    expect(isEmail(BOUND)).toBe(true);
    expect(isEmail("apis@example")).toBe(false);
  });
});

describe("step 2: Bitwarden", () => {
  it("prints the install commands when `bw` is missing, then ticks after a re-check", async () => {
    const bw = fakeBw({ missing: true });
    const opened: string[] = [];
    const io = fakeIo([
      "y", // yes, the account already exists
      () => {
        // The human installed, logged in and unlocked it in their own terminal.
        bw.state.missing = false;
        bw.state.state = "unlocked";
        bw.state.userEmail = BOUND;
        return "";
      },
    ]);
    const result = await stepBitwarden(deps(io, bw, opened), {
      email: BOUND,
      backend: "bitwarden",
    });

    expect(result.backend).toBe("bitwarden");
    expect(result.deferred).toBe(false);
    expect(result.bitwarden?.usable).toBe(true);
    expect(io.output()).toMatch(/Step 2\/6\s+Bitwarden/);
    expect(io.output()).toContain("npm install -g @bitwarden/cli");
    expect(io.output()).toContain("brew install bitwarden-cli");
    expect(io.output()).toContain("snap install bw");
    expect(io.output()).toContain(`bw login ${BOUND}`);
    expect(io.output()).toContain('export BW_SESSION="$(bw unlock --raw)"');
    expect(io.output()).toContain(`${TICK} bw installed, logged in and unlocked as ${BOUND}`);
    // Nothing was opened: the human said they already have an account.
    expect(opened).toEqual([]);
  });

  it("opens the Bitwarden signup page when the human has no account, and prints it too", async () => {
    const bw = fakeBw({ state: "unauthenticated" });
    const opened: string[] = [];
    const io = fakeIo([
      "n", // no account yet
      "", // Enter: the account now exists
      () => {
        bw.state.state = "unlocked";
        bw.state.userEmail = BOUND;
        return "";
      },
    ]);
    await stepBitwarden(deps(io, bw, opened), { email: BOUND, backend: "bitwarden" });

    expect(opened).toEqual([BITWARDEN_REGISTER_URL]);
    expect(io.output()).toContain(BITWARDEN_REGISTER_URL);
    expect(io.output()).toContain("Opened that page in your browser.");
    expect(io.output()).toMatch(/never asks for it, never stores it/);
  });

  it("still prints the signup URL when no browser can be opened", async () => {
    const bw = fakeBw({ state: "unauthenticated" });
    const io = fakeIo([
      "n",
      "",
      () => {
        bw.state.state = "unlocked";
        return "";
      },
    ]);
    await stepBitwarden(
      { io: io.io, bw: bw.runner, openUrl: noopOpener() },
      { email: BOUND, backend: "bitwarden" },
    );
    expect(io.output()).toContain(BITWARDEN_REGISTER_URL);
    expect(io.output()).toContain("Could not open a browser here");
  });

  it("lets the human skip, and says what will refuse until they come back", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["skip"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });
    expect(result.deferred).toBe(true);
    expect(result.switched).toBe(false);
    expect(result.bitwarden?.usable).toBe(false);
    expect(io.output()).toContain(`${SKIPPED} Bitwarden not ready.`);
    expect(io.output()).toContain("`init` finishes anyway");
    expect(io.output()).toContain(FINISH_COMMANDS.bitwarden);
  });

  it("offers three ways on -- set it up, encrypted-file instead, or later", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["3"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });

    expect(result.deferred).toBe(true);
    const output = io.output();
    expect(output).toMatch(/Step 2\/6\s+Bitwarden \(recommended, skippable\)/);
    expect(output).toContain("Only your email is required, so this step has three ways on:");
    expect(output).toContain("1) set Bitwarden up now");
    expect(output).toContain(`2) use the ${BITWARDEN_FALLBACK_BACKEND} vault instead`);
    expect(output).toContain("3) skip for now");
    // The recommended route is still the one Enter takes.
    expect(io.asked[0]).toContain("Press Enter once you have run those");
  });

  it("takes the encrypted-file vault instead, and does not abort the run", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["2"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });

    expect(result.backend).toBe(BITWARDEN_FALLBACK_BACKEND);
    expect(result.switched).toBe(true);
    expect(result.deferred).toBe(false);
    expect(result.bitwarden?.usable).toBe(false);
    expect(io.output()).toContain(`${TICK} vault switched to ${BITWARDEN_FALLBACK_BACKEND}`);
    expect(io.output()).toContain("nothing to install");
    expect(io.output()).toContain(FINISH_COMMANDS.bitwarden);
    // One read of `bw status`, and no re-check: the fork was taken, not retried.
    expect(bw.calls).toEqual([["status"]]);
  });

  it("says plainly when that choice overrides an explicit --backend bitwarden", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["encrypted-file"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });
    expect(result.backend).toBe(BITWARDEN_FALLBACK_BACKEND);
    expect(io.output()).toContain("instead of the `--backend bitwarden` you asked for");
  });

  it("has nothing to override when the backend came from the menu", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["1", "2"]); // menu: bitwarden; fork: encrypted-file
    const result = await stepBitwarden(deps(io, bw), { email: BOUND });
    expect(result.backend).toBe(BITWARDEN_FALLBACK_BACKEND);
    expect(io.output()).not.toContain("you asked for");
  });

  it("re-asks a fork answer that is not 1, 2 or 3, and prints the menu once", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["maybe", "3"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });
    expect(result.deferred).toBe(true);
    expect(io.output()).toContain(`${TODO} "maybe" is not 1, 2 or 3.`);
    expect(io.output().match(/3\) skip for now/g)).toHaveLength(1);
  });

  it("treats a human who answers nothing usable as `skip for now`, not as a failure", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["?", "?", "?", "?", "?"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });
    expect(result.deferred).toBe(true);
    expect(result.backend).toBe("bitwarden");
    expect(io.output()).toContain('Taking that as "skip for now"');
  });

  it("says a different account is NOT the bound email", async () => {
    const bw = fakeBw({ state: "unlocked", userEmail: "someone.else@corp.test" });
    const io = fakeIo();
    const result = await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });
    expect(result.bitwarden?.matchesBound).toBe(false);
    expect(io.output()).toContain("not the bound ");
  });

  it("skips the Bitwarden CLI entirely for another backend", async () => {
    const bw = fakeBw({ missing: true });
    const io = fakeIo();
    const result = await stepBitwarden(deps(io, bw), {
      email: BOUND,
      backend: "encrypted-file",
    });
    expect(result.backend).toBe("encrypted-file");
    expect(result.bitwarden).toBeNull();
    expect(bw.calls).toEqual([]);
    expect(io.output()).toContain(`${SKIPPED} backend encrypted-file`);
  });

  it("does not make backend selection mandatory after invalid answers", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo(["bad", "bad", "bad", "bad", "bad", "skip"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND });
    expect(result.backend).toBe("bitwarden");
    expect(result.deferred).toBe(true);
    expect(io.remaining()).toBe(0);
  });

  it("asks which backend when --backend was not given", async () => {
    const bw = fakeBw({ missing: true });
    const io = fakeIo(["4"]);
    const result = await stepBitwarden(deps(io, bw), { email: BOUND });
    expect(result.backend).toBe("encrypted-file");
    expect(io.output()).toContain("Where should secrets live?");
  });

  it("never asks for the master password, and never passes one to `bw`", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo([
      () => {
        bw.state.state = "unlocked";
        bw.state.userEmail = BOUND;
        return "";
      },
    ]);
    await stepBitwarden(deps(io, bw), { email: BOUND, backend: "bitwarden" });

    for (const question of io.asked) expect(question).not.toMatch(/pass(word|phrase)|cvv|secret/i);
    // `bw` is only ever *read*: no login, no unlock, no argv secret, no stdin.
    expect(bw.calls).toEqual([["status"], ["status"]]);
    expect(bw.stdin).toEqual([]);
    expect(bw.calls.flat().join(" ")).not.toContain(MASTER_PASSWORD);
    expect(io.output()).not.toContain(MASTER_PASSWORD);
  });
});

describe("step 3: inbox connect", () => {
  it("says it is coming soon and skips", () => {
    const io = fakeIo();
    const result = stepInbox(deps(io, fakeBw()));
    expect(result.skipped).toBe(true);
    expect(io.asked).toEqual([]);
    expect(io.output()).toMatch(/Step 3\/6\s+Inbox connect/);
    expect(io.output()).toContain("Coming soon (v0.5)");
    expect(io.output()).toContain(`${SKIPPED} inbox connect: coming soon, skipped`);
    expect(io.output()).toMatch(/no agent is ever asked to read your mail/);
  });
});

describe("step 4: spend caps", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("writes a global cap and per-vendor caps through the human-only path", async () => {
    const io = fakeIo(["25", "TikHub", "5", "Apollo", "10", ""]);
    const result = await stepSpendCaps(deps(io, fakeBw()), home);

    expect(result.wrote).toBe(true);
    expect(result.skipped).toBe(false);
    const policy = readPolicy(home);
    expect(policy.global_monthly_cap_usd).toBe(25);
    expect(vendorCap(policy, "TikHub")).toBe(5);
    expect(vendorCap(policy, "Apollo")).toBe(10);
    // The same authority `skeletonkey policy set` records: a human did this.
    expect(policy.last_change_by).toBe("cli");
    expect(io.output()).toContain(`${TICK} global $25/month; tikhub $5; apollo $10`);
    expect(io.output()).toMatch(/Agents can\s*\n?\s*never raise them/);
  });

  it("keeps $0 and writes nothing at all when every answer is blank", async () => {
    const io = fakeIo(["", ""]);
    const result = await stepSpendCaps(deps(io, fakeBw()), home);

    expect(result.wrote).toBe(false);
    expect(result.policy.global_monthly_cap_usd).toBe(0);
    expect(fs.existsSync(policyPath(home))).toBe(false);
    expect(io.output()).toContain(`${SKIPPED} spend caps left at $0`);
  });

  it("is skippable outright, and every cap stays at $0", async () => {
    const io = fakeIo(["skip"]);
    const result = await stepSpendCaps(deps(io, fakeBw()), home);
    expect(result.skipped).toBe(true);
    expect(result.wrote).toBe(false);
    expect(io.asked).toHaveLength(1);
    // Nothing written, and the read-back default is $0 everywhere: skipping
    // cannot leave money spendable (D11).
    expect(fs.existsSync(policyPath(home))).toBe(false);
    expect(readPolicy(home).global_monthly_cap_usd).toBe(0);
    expect(readPolicy(home).vendor_caps_usd).toEqual({});
  });

  it("re-asks on an answer that is not a number of dollars", async () => {
    const io = fakeIo(["lots", "$30", ""]);
    const result = await stepSpendCaps(deps(io, fakeBw()), home);
    expect(result.policy.global_monthly_cap_usd).toBe(30);
    expect(io.output()).toContain(`${TODO} "lots" is not a number of dollars.`);
  });

  it("accepts a vendor whose own name reads like a secret", async () => {
    // The guard checks the question *template*, not the vendor name the human
    // typed, so "Password Manager Co" is a vendor like any other.
    const io = fakeIo(["50", "Password Manager Co", "7", ""]);
    const result = await stepSpendCaps(deps(io, fakeBw()), home);
    expect(result.wrote).toBe(true);
    expect(vendorCap(readPolicy(home), "Password Manager Co")).toBe(7);
    expect(io.asked.some((question) => question.includes("Password Manager Co"))).toBe(true);
  });

  it("takes a global cap with no vendor caps", async () => {
    const io = fakeIo(["40", ""]);
    const result = await stepSpendCaps(deps(io, fakeBw()), home);
    expect(result.wrote).toBe(true);
    expect(readPolicy(home).global_monthly_cap_usd).toBe(40);
    expect(readPolicy(home).vendor_caps_usd).toEqual({});
  });
});

describe("step 5: the payment card", () => {
  it("checks only that the item exists, and never reads the number", async () => {
    const bw = fakeBw({ items: [CARD_ITEM] });
    const io = fakeIo([""]);
    const result = await stepCard(deps(io, bw), { bitwarden: null });

    expect(result.present).toBe(true);
    expect(result.skipped).toBe(false);
    expect(io.output()).toMatch(/Step 5\/6\s+Payment card \(optional\)/);
    expect(io.output()).toContain(`${TICK} Bitwarden item "${CARD_ITEM_NAME}" exists`);
    expect(io.output()).toContain("no value was read");
    // The item JSON carried the number and the CVV. Neither may surface.
    expect(io.output()).not.toContain(CARD_NUMBER);
    expect(io.output()).not.toContain(CARD_CVV);
    expect(JSON.stringify(result)).not.toContain(CARD_NUMBER);
    // Existence only: one read-only search, nothing written to `bw`.
    expect(bw.calls).toEqual([["list", "items", "--search", CARD_ITEM_NAME]]);
    expect(bw.stdin).toEqual([]);
  });

  it("explains how to create the item in Bitwarden's own app", async () => {
    const io = fakeIo(["n"]);
    await stepCard(deps(io, fakeBw()), { bitwarden: null });
    expect(io.output()).toContain("Create it yourself, in the Bitwarden app or web vault");
    expect(io.output()).toContain(CARD_ITEM_NAME);
    expect(io.output()).toContain("v0.3 pays for nothing");
  });

  it("says so, without failing, when the item is not there yet", async () => {
    const io = fakeIo([""]);
    const result = await stepCard(deps(io, fakeBw({ items: [] })), { bitwarden: null });
    expect(result.present).toBe(false);
    expect(result.skipped).toBe(false);
    expect(io.output()).toContain(`${TODO} no Bitwarden item named "${CARD_ITEM_NAME}" yet`);
  });

  it("is skippable", async () => {
    const bw = fakeBw({ items: [CARD_ITEM] });
    const io = fakeIo(["n"]);
    const result = await stepCard(deps(io, bw), { bitwarden: null });
    expect(result.skipped).toBe(true);
    expect(bw.calls).toEqual([]);
    expect(io.output()).toContain(`${SKIPPED} card check skipped`);
  });

  it("does not look when Bitwarden is not readable", async () => {
    const bw = fakeBw({ state: "locked", items: [CARD_ITEM] });
    const io = fakeIo([""]);
    const result = await stepCard(deps(io, bw), {
      bitwarden: {
        state: "locked",
        usable: false,
        account: null,
        bound: BOUND,
        matchesBound: null,
        summary: "the `bw` CLI is logged in but locked",
      },
    });
    expect(result.skipped).toBe(true);
    expect(bw.calls).toEqual([]);
    expect(io.output()).toContain("locked");
  });

  it("matches the item by exact name only", async () => {
    const bw = fakeBw({
      items: [{ id: "x", name: "skeletonkey: card (old)", card: { number: CARD_NUMBER } }],
    });
    expect(await cardItemPresent(bw.runner)).toBe(false);
  });

  it("returns false rather than throwing when `bw` cannot answer", async () => {
    const bw = fakeBw({ missing: true });
    expect(await cardItemPresent(bw.runner)).toBe(false);
  });
});

describe("the wizard never asks for a secret", () => {
  const forbidden = [
    "Bitwarden master password: ",
    "Passphrase: ",
    "Card number: ",
    "CVV: ",
    "API key: ",
    "Paste the secret: ",
  ];

  for (const question of forbidden) {
    it(`refuses to ask ${JSON.stringify(question)}`, async () => {
      const io = fakeIo(["anything"]);
      await expect(ask(deps(io, fakeBw()), question)).rejects.toThrow(
        /must never ask for a secret/,
      );
      expect(io.asked).toEqual([]);
    });
  }

  it("still asks an ordinary question", async () => {
    const io = fakeIo(["yes"]);
    expect(await ask(deps(io, fakeBw()), "Do you have a Bitwarden account? ")).toBe("yes");
  });

  it("names the questions it refuses, without a guard on every caller", () => {
    expect(() => assertNotSecret("Master password: ")).toThrow(/must never ask for a secret/);
    expect(() => assertNotSecret("Vendor name: ")).not.toThrow();
  });
});

describe("the closing summary", () => {
  function wizardResult(overrides: Partial<WizardResult> = {}): WizardResult {
    return {
      email: BOUND,
      backend: "bitwarden",
      location: 'Bitwarden vault (items named "skeletonkey: <alias>")',
      bitwarden: null,
      switchedVault: false,
      caps: {
        policy: defaultPolicy(),
        wrote: false,
        skipped: true,
        summary: "spend caps left at $0 (skipped)",
      },
      card: {
        present: false,
        skipped: true,
        itemName: CARD_ITEM_NAME,
        summary: "card check skipped",
      },
      agents: "registered with Claude Code and Codex (4 file(s) written)",
      agentsDeferred: false,
      ...overrides,
    };
  }

  /**
   * Does the real CLI know this command? Walks `buildProgram()`'s command tree
   * one word at a time: sub-commands by name or alias, `--flags` against the
   * options of whatever command they follow, `<placeholders>` skipped because
   * they are the human's to fill in.
   */
  function cliKnows(command: string): boolean {
    const words = command.split(/\s+/);
    if (words.shift() !== "skeletonkey") return false;
    let node: Command = buildProgram();
    for (const word of words) {
      if (word.startsWith("<") || word.startsWith("[")) continue;
      if (word.startsWith("-")) {
        const known = node.options.some(
          (option) => option.long === word || option.short === word,
        );
        if (!known) return false;
        continue;
      }
      const next = node.commands.find(
        (child) => child.name() === word || child.aliases().includes(word),
      );
      if (next === undefined) return false;
      node = next;
    }
    return true;
  }

  it("splits what is set up from what is deferred", () => {
    const sections = summarySections(
      wizardResult({
        bitwarden: LOCKED_BW,
        caps: {
          policy: defaultPolicy(),
          wrote: true,
          skipped: false,
          summary: "global $25/month",
        },
      }),
    );
    expect(sections.set.map((row) => row.label)).toEqual([
      "email",
      "vault",
      "spend caps",
      "agents",
    ]);
    expect(sections.deferred.map((row) => row.label)).toEqual(["bitwarden", "card"]);
  });

  it("prints both headings, and the command under every deferred item", () => {
    const io = fakeIo();
    printSummary(io.io, wizardResult({ bitwarden: LOCKED_BW }));
    const lines = io.lines;
    expect(lines).toContain("Summary");
    expect(lines).toContain("  Set up");
    expect(io.output()).toContain("Deferred -- not required now; under each line is the command");

    // Each deferred line that has a command is followed by exactly that command.
    for (const row of summarySections(wizardResult({ bitwarden: LOCKED_BW })).deferred) {
      const index = lines.findIndex((line) => line.includes(`${row.label} `) && line.includes(row.detail));
      expect(index, `no summary line for ${row.label}`).toBeGreaterThan(-1);
      expect(row.command).not.toBeNull();
      expect(cliKnows(row.command!)).toBe(true);
      expect(lines[index + 1]?.trim()).toBe(row.command);
    }
    expect(io.output()).toContain(FINISH_COMMANDS.bitwarden);
    expect(io.output()).toContain(FINISH_COMMANDS.caps);
    expect(io.output()).toContain(FINISH_COMMANDS.card);
  });

  it("hands out only commands the CLI actually has", () => {
    // The point of the check: every finish-it-later command is resolved against
    // the real command tree, so renaming a verb fails here.
    for (const command of Object.values(FINISH_COMMANDS)) {
      expect(cliKnows(command), `${command} is not a command`).toBe(true);
    }
    // And the walker is not simply saying yes.
    expect(cliKnows("skeletonkey card status")).toBe(false);
    expect(cliKnows("skeletonkey policy set --raise <usd>")).toBe(false);
  });

  it("has no command to offer for inbox connect, and does not invent one", () => {
    expect(summarySections(wizardResult()).deferred.map((row) => row.label)).not.toContain("inbox");
    const io = fakeIo();
    printSummary(io.io, wizardResult());
    expect(io.output()).toContain("Coming soon: inbox connect (v0.5) -- nothing to run yet");
  });

  it("calls Bitwarden deferred, not broken, when the vault was switched", () => {
    const sections = summarySections(
      wizardResult({
        backend: BITWARDEN_FALLBACK_BACKEND,
        location: "encrypted file",
        bitwarden: LOCKED_BW,
        switchedVault: true,
      }),
    );
    const row = sections.deferred.find((entry) => entry.label === "bitwarden");
    expect(row?.glyph).toBe(SKIPPED);
    expect(row?.detail).toContain(`not needed by the ${BITWARDEN_FALLBACK_BACKEND} vault`);
    expect(row?.command).toBe(FINISH_COMMANDS.bitwarden);
  });

  it("leaves Bitwarden out of the summary entirely for a backend that never used it", () => {
    const sections = summarySections(wizardResult({ backend: "keychain", location: "keychain" }));
    expect([...sections.set, ...sections.deferred].map((row) => row.label)).not.toContain(
      "bitwarden",
    );
  });

  it("defers agent registration with the command that does it later", () => {
    const sections = summarySections(
      wizardResult({ agents: "agent registration skipped (--no-register)", agentsDeferred: true }),
    );
    const row = sections.deferred.find((entry) => entry.label === "agents");
    expect(row?.command).toBe(FINISH_COMMANDS.agents);
  });
});

describe("the whole wizard, end to end", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  function plan(overrides: Partial<WizardPlan> = {}): WizardPlan {
    return {
      home,
      answers: { email: BOUND, backend: "bitwarden" },
      commit: async () => "Bitwarden vault (items named \"skeletonkey: <alias>\")",
      register: async () => "registered with Claude Code and Codex (4 file(s) written)",
      ...overrides,
    };
  }

  it("ticks all six steps and prints a summary", async () => {
    const bw = fakeBw({ state: "unlocked", userEmail: BOUND, items: [CARD_ITEM] });
    const io = fakeIo(["25", "TikHub", "5", "", ""]);
    const committed: unknown[] = [];

    const result = await runInitWizard(
      deps(io, bw),
      plan({
        commit: async (input) => {
          committed.push(input);
          return "Bitwarden vault";
        },
      }),
    );

    expect(io.remaining()).toBe(0);
    expect(committed).toEqual([{ email: BOUND, backend: "bitwarden" }]);
    expect(result.email).toBe(BOUND);
    expect(result.backend).toBe("bitwarden");
    expect(result.caps.wrote).toBe(true);
    expect(result.card.present).toBe(true);

    const output = io.output();
    for (const step of [
      "Step 1/6  Email",
      "Step 2/6  Bitwarden",
      "Step 3/6  Inbox connect",
      "Step 4/6  Spend caps",
      "Step 5/6  Payment card (optional)",
      "Step 6/6  Register with Claude Code / Codex",
    ]) {
      expect(output).toContain(step);
    }
    expect(output).toMatch(/^SkeletonKey init -- 6 steps\./);
    expect(output).toContain("Summary");
    expect(output).toContain(`${TICK} email`);
    expect(output).toContain(`${TICK} bitwarden`);
    expect(output).toContain(`${SKIPPED} inbox`);
    expect(output).toContain(`${TICK} spend caps`);
    expect(output).toContain(`${TICK} card`);
    expect(output).toContain(`${TICK} agents`);
    expect(output).toContain("skeletonkey runner");
    expect(output).toContain("Restart Claude Code / Codex");
    // No value from the vault, ever.
    expect(output).not.toContain(CARD_NUMBER);
    expect(output).not.toContain(MASTER_PASSWORD);
    // And the caps really were written, by a human authority.
    expect(readPolicy(home).last_change_by).toBe("cli");
  });

  it.each(["locked", "unauthenticated", "not-installed"] as const)("finishes with every optional step skipped when bw is %s", async (state) => {
    const bw = fakeBw(state === "not-installed" ? { missing: true } : { state });
    const io = fakeIo([
      ...(state === "locked" ? [] : ["y"]),
      "3", // step 2: leave Bitwarden for later
      "skip", // step 4: no caps
      "n", // step 5: no card check
    ]);
    const result = await runInitWizard(deps(io, bw), plan({ registerSkipped: true }));

    expect(result.agentsDeferred).toBe(true);
    expect(io.output()).toContain(FINISH_COMMANDS.agents);
    expect(io.remaining()).toBe(0);
    expect(result.bitwarden?.usable).toBe(false);
    expect(result.backend).toBe("bitwarden");
    expect(result.caps.wrote).toBe(false);
    expect(result.card.skipped).toBe(true);
    // Caps stay at $0, which is what makes skipping them safe.
    expect(fs.existsSync(policyPath(home))).toBe(false);
    expect(readPolicy(home).global_monthly_cap_usd).toBe(0);
    const output = io.output();
    expect(output).toContain("Summary");
    expect(output).toContain(`${TODO} bitwarden`);
    expect(output).toContain(`${SKIPPED} spend caps`);
    expect(output).toContain(`${SKIPPED} card`);
    // Nothing refused, and every deferred item came with its command.
    expect(output).toContain("Only step 1 (your email) is required.");
    expect(output).toContain(FINISH_COMMANDS.bitwarden);
    expect(output).toContain(FINISH_COMMANDS.caps);
    expect(output).toContain(FINISH_COMMANDS.card);
  });

  it("finishes with the encrypted-file vault when step 2 is answered that way", async () => {
    const bw = fakeBw({ state: "locked" });
    const io = fakeIo([
      "2", // step 2: encrypted-file instead of Bitwarden
      "", // step 4: blank global cap
      "", // step 4: no vendor caps
      "n", // step 5: no card check
    ]);
    const committed: unknown[] = [];
    const result = await runInitWizard(
      deps(io, bw),
      plan({
        commit: async (input) => {
          committed.push(input);
          return "encrypted file at ~/.skeletonkey/secrets.enc";
        },
      }),
    );

    expect(io.remaining()).toBe(0);
    // The vault the wizard commits is the one the human picked at step 2, not
    // the `--backend bitwarden` they started with.
    expect(committed).toEqual([{ email: BOUND, backend: BITWARDEN_FALLBACK_BACKEND }]);
    expect(result.backend).toBe(BITWARDEN_FALLBACK_BACKEND);
    expect(result.switchedVault).toBe(true);
    const output = io.output();
    expect(output).toContain(`${TICK} vault`);
    expect(output).toContain(`${BITWARDEN_FALLBACK_BACKEND} -- encrypted file`);
    expect(output).toContain(`${SKIPPED} bitwarden`);
    expect(output).toContain(FINISH_COMMANDS.bitwarden);
  });

  it("defers declined registration with its follow-up command", async () => {
    const io = fakeIo(["skip", "n"]);
    const result = await runInitWizard(deps(io, fakeBw({ state: "unlocked", userEmail: BOUND })), plan({
      register: async () => ({ summary: "declined registration", deferred: true }),
    }));
    expect(result.agentsDeferred).toBe(true);
    expect(summarySections(result).set.map((row) => row.label)).not.toContain("agents");
    expect(summarySections(result).deferred.find((row) => row.label === "agents")?.command)
      .toBe(FINISH_COMMANDS.agents);
    expect(io.output()).toContain(FINISH_COMMANDS.agents);
  });

  it("announces step 6 as skipped for --no-register", async () => {
    const bw = fakeBw({ state: "unlocked", userEmail: BOUND });
    const io = fakeIo(["skip", "n"]);
    let registered = false;
    const result = await runInitWizard(
      deps(io, bw),
      plan({
        registerSkipped: true,
        register: async () => {
          registered = true;
          return "should not happen";
        },
      }),
    );
    expect(registered).toBe(false);
    expect(result.agents).toMatch(/skipped \(--no-register\)/);
    expect(result.agentsDeferred).toBe(true);
    expect(io.output()).toContain(`${SKIPPED} agent registration skipped`);
    // Deferred, with the command that does it later.
    expect(io.output()).toContain(`${SKIPPED} agents`);
    expect(io.output()).toContain(FINISH_COMMANDS.agents);
  });

  it("asks nothing it was already told on the command line", async () => {
    const bw = fakeBw({ state: "unlocked", userEmail: BOUND });
    const io = fakeIo(["skip", "n"]);
    await runInitWizard(deps(io, bw), plan());
    // Only the two optional steps asked anything: email, backend and
    // Bitwarden were all settled by flags and by `bw status`.
    expect(io.asked).toHaveLength(2);
  });
});

describe("the wizard is what a real TTY gets", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  /**
   * `vitest` gives a child a pipe, not a terminal, so the TTY branch of
   * `cmdInit` can only be reached through a real pty. `script(1)` allocates
   * one; where it is not available (macOS takes different flags, Windows has
   * no equivalent) the check is skipped rather than faked.
   */
  const ptyRunner = "/usr/bin/script";
  const hasPty = process.platform === "linux" && fs.existsSync(ptyRunner);

  it.skipIf(!hasPty)("starts the wizard when stdin is a terminal", () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND });
    // One EOT aborts at the first question, which is all this needs: the
    // point is *which* branch of `init` ran. (Closing the pipe does not reach
    // the pty as EOF, so it has to be an actual Ctrl-D.)
    let output: string;
    try {
      output = execFileSync(
        ptyRunner,
        [
          "-qefc",
          `${process.execPath} --no-warnings ${CLI} init --email ${BOUND} --backend bitwarden`,
          "/dev/null",
        ],
        {
          encoding: "utf8",
          input: "\u0004",
          timeout: 30_000,
          env: {
            ...fake.env,
            SKELETONKEY_HOME: path.join(home, "sk"),
            SKELETONKEY_USER_HOME: path.join(home, "user"),
            NO_COLOR: "1",
          },
        },
      );
    } catch (error) {
      // The run aborts at EOF, so a non-zero exit is expected; keep its output.
      output = String((error as { stdout?: string }).stdout ?? "");
    }

    expect(output).toContain("SkeletonKey init -- 6 steps");
    expect(output).toContain("Step 1/6  Email");
    expect(output).toContain(`${TICK} bound email ${BOUND}`);
    expect(output).toContain("Step 2/6  Bitwarden");
    expect(output).toContain(`${TICK} bw installed, logged in and unlocked as ${BOUND}`);
    expect(output).toContain("Step 3/6  Inbox connect");
    expect(output).toContain("Step 4/6  Spend caps");
    // Still no master password, through the real CLI and a real terminal.
    expect(output).not.toMatch(/master password: /i);
    expect(fake.calls().every((line) => line.startsWith("status"))).toBe(true);
  }, 60_000);
});

describe("--yes and a non-TTY stdin keep the old straight-line setup", () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  /** `runCli` pipes stdin, so these runs are exactly what CI does. */
  it("prints no wizard output and writes the config from flags", async () => {
    const result = await runCli(home, [
      "init",
      "--email",
      BOUND,
      "--backend",
      "file",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`SkeletonKey initialised at ${home}`);
    expect(result.stdout).not.toContain("Step 1/6");
    expect(result.stdout).not.toContain("Summary");
    expect(result.stdout).toMatch(/Agent registration \(Claude Code and Codex only\)/);
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(true);
    // The wizard's optional steps never ran, so nothing set a cap.
    expect(fs.existsSync(policyPath(home))).toBe(false);
  });

  it("takes the same path without --yes when stdin is not a TTY", async () => {
    const result = await runCli(home, ["init", "--email", BOUND, "--backend", "file"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Step 1/6");
    expect(result.stdout).toContain(`SkeletonKey initialised at ${home}`);
  });

  it("still insists on --email and --backend in non-interactive mode", async () => {
    const noEmail = await runCli(home, ["init", "--backend", "file", "--yes"]);
    expect(noEmail.code).toBe(1);
    expect(noEmail.stderr).toMatch(/--email is required in non-interactive mode/);

    const noBackend = await runCli(home, ["init", "--email", BOUND, "--yes"]);
    expect(noBackend.code).toBe(1);
    expect(noBackend.stderr).toMatch(/--backend is required in non-interactive mode/);
  });

  it("documents the wizard in `init --help`", async () => {
    const help = await runCli(home, ["init", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/interactive step-by-step wizard/);
    expect(help.stdout).toMatch(/--yes\s+skip the interactive wizard/);
  });
});
