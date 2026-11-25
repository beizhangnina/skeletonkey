/**
 * ND-3: failure paths must leak nothing and must not half-write state.
 *
 * Every success path for a signup/account secret is already covered by
 * test/signup-canary.test.ts and test/accounts-canary.test.ts. This file
 * covers the *failure* paths for the same canaries: a wrong vault
 * passphrase, a corrupted vault/metadata file, missing stdin input, and a
 * driver that throws -- none of which may echo a secret, print a JS stack
 * trace, or leave a partial row behind.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callSkeletonKeyTool, SKELETONKEY_TOOLS, type McpContext } from "../src/mcp.js";
import { cmdSignupStart } from "../src/signup/cli.js";
import type { Nd2SignupDriver } from "../src/signup/drive.js";
import { findAccount } from "../src/accounts/store.js";
import { readSignups } from "../src/signup/sessions.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const CANARY_KEY = "sk-nd3-CANARY-KEY-9f3a1c7e5b";
const CANARY_PW = "nd3-CANARY-PASSWORD-77d1e0";
const CANARY_PASS = "nd3-CANARY-PASSPHRASE-4b8e";
const CANARY_EMAIL = "nd3.canary.email@leak.example";
const WRONG_PASS = "nd3-WRONGPASS-c0ffee";

const SENTINELS = [CANARY_KEY, CANARY_PW, CANARY_PASS, CANARY_EMAIL, WRONG_PASS];
const FRAGMENTS = ["9f3a1c7e5b", "PASSWORD-77d1e0", "PASSPHRASE-4b8e", "nd3.canary.email", "WRONGPASS-c0ffee"];

const STACK_TRACE_RE = /\n\s+at\s+\S+.*\(.*:\d+:\d+\)/;

function assertClean(label: string, text: string): void {
  for (const value of SENTINELS) {
    expect(text, `${label} leaked a sentinel value`).not.toContain(value);
  }
  for (const fragment of FRAGMENTS) {
    expect(text, `${label} leaked a sentinel fragment`).not.toContain(fragment);
  }
  expect(text, `${label} contains a JS stack trace`).not.toMatch(STACK_TRACE_RE);
  expect(text.includes("    at "), `${label} contains a JS stack trace ("    at ")`).toBe(false);
}

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

function sweepHome(home: string): void {
  for (const file of filesUnder(home)) {
    assertClean(`file:${path.relative(home, file)}`, fs.readFileSync(file).toString("latin1"));
  }
}

/** Captures console.log/console.error/process.stdout.write/process.stderr.write. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const origLog = console.log;
  const origErr = console.error;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]): void => {
    out += `${args.map((a) => String(a)).join(" ")}\n`;
  };
  console.error = (...args: unknown[]): void => {
    out += `${args.map((a) => String(a)).join(" ")}\n`;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
  return out;
}

const VENDOR = "apify";
const ACCOUNT = "apify-main";
const LOGIN_ACCOUNT = "x-login-acct";

describe("ND-3: failure paths leak nothing and leave no half-written state", () => {
  let home: string;
  let env: Record<string, string>;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    home = makeHome();
    env = { SKELETONKEY_PASSPHRASE: CANARY_PASS };
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
    delete process.env.SKELETONKEY_PASSPHRASE;
    removeHome(home);
  });

  it("a) wrong vault passphrase: non-zero for writes/run, metadata reads still work, no leak, no half-written state", async () => {
    const surfaces: { name: string; text: string }[] = [];
    const record = (name: string, result: { stdout: string; stderr: string }): void => {
      surfaces.push({ name, text: `${result.stdout}\n${result.stderr}` });
    };
    const exitCodes: Record<string, number> = {};

    const complete = await runCli(
      home,
      ["signup", "complete", VENDOR, "--stdin"],
      CANARY_KEY,
      env,
    );
    expect(complete.code, complete.stderr).toBe(0);
    record("setup:signup complete", complete);

    const addLogin = await runCli(
      home,
      ["account", "add", LOGIN_ACCOUNT, "--vendor", VENDOR, "--email-stdin", "--store-login", "--stdin"],
      `${CANARY_EMAIL}\n${CANARY_PW}`,
      env,
    );
    expect(addLogin.code, addLogin.stderr).toBe(0);
    record("setup:account add login", addLogin);

    const wrongEnv = { SKELETONKEY_PASSPHRASE: WRONG_PASS };

    const wrongComplete = await runCli(
      home,
      ["signup", "complete", "firecrawl", "--stdin"],
      CANARY_KEY,
      wrongEnv,
    );
    exitCodes["signup complete (wrong pass)"] = wrongComplete.code;
    expect(wrongComplete.code).not.toBe(0);
    record("wrong-pass:signup complete firecrawl", wrongComplete);

    const wrongAdd = await runCli(
      home,
      [
        "account",
        "add",
        "wrongpass-acct",
        "--vendor",
        VENDOR,
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      CANARY_KEY,
      wrongEnv,
    );
    exitCodes["account add --store-key (wrong pass)"] = wrongAdd.code;
    expect(wrongAdd.code).not.toBe(0);
    record("wrong-pass:account add --store-key", wrongAdd);

    const wrongShow = await runCli(home, ["account", "show", ACCOUNT], undefined, wrongEnv);
    exitCodes["account show (wrong pass)"] = wrongShow.code;
    expect(wrongShow.code, wrongShow.stderr).toBe(0); // metadata only, no vault touch
    record("wrong-pass:account show", wrongShow);

    const wrongList = await runCli(home, ["account", "list", "--json"], undefined, wrongEnv);
    exitCodes["account list --json (wrong pass)"] = wrongList.code;
    expect(wrongList.code, wrongList.stderr).toBe(0);
    record("wrong-pass:account list --json", wrongList);

    const wrongRun = await runCli(
      home,
      ["run", "--env", `X=vault://${ACCOUNT}`, "--", "node", "-e", "0"],
      undefined,
      wrongEnv,
    );
    exitCodes["run (wrong pass)"] = wrongRun.code;
    expect(wrongRun.code).not.toBe(0);
    record("wrong-pass:run", wrongRun);

    const wrongStatus = await runCli(home, ["signup", "status", "--json"], undefined, wrongEnv);
    exitCodes["signup status --json (wrong pass)"] = wrongStatus.code;
    expect(wrongStatus.code, wrongStatus.stderr).toBe(0);
    record("wrong-pass:signup status --json", wrongStatus);

    // --- MCP tools with the wrong passphrase set as process.env -----------
    const prevPassphrase = process.env.SKELETONKEY_PASSPHRASE;
    process.env.SKELETONKEY_PASSPHRASE = WRONG_PASS;
    try {
      const ctx: McpContext = { home, allowTtyPrompt: false };
      const listAccountsResult = await callSkeletonKeyTool("list_accounts", {}, ctx);
      surfaces.push({ name: "tool:list_accounts (wrong pass)", text: JSON.stringify(listAccountsResult) });
      const signupStatusResult = await callSkeletonKeyTool("signup_status", { vendor: VENDOR }, ctx);
      surfaces.push({ name: "tool:signup_status (wrong pass)", text: JSON.stringify(signupStatusResult) });
      const keyStatusResult = await callSkeletonKeyTool("key_status", { alias: ACCOUNT }, ctx);
      surfaces.push({ name: "tool:key_status (wrong pass)", text: JSON.stringify(keyStatusResult) });
    } finally {
      if (prevPassphrase === undefined) delete process.env.SKELETONKEY_PASSPHRASE;
      else process.env.SKELETONKEY_PASSPHRASE = prevPassphrase;
    }

    console.log("nd3 wrong-passphrase exit codes:", JSON.stringify(exitCodes));

    // --- no half-written state ----------------------------------------------
    expect(findAccount("firecrawl-main", home)).toBeUndefined();
    expect(findAccount("wrongpass-acct", home)).toBeUndefined();
    const signupsAfter = readSignups(home);
    expect(signupsAfter.sessions.some((s) => s.vendor === "firecrawl")).toBe(false);

    // --- the sweep -----------------------------------------------------------
    for (const surface of surfaces) assertClean(surface.name, surface.text);
    sweepHome(home);
  });

  it("b) corrupted data: no leak, no stack trace, metadata-only commands stay tolerant", async () => {
    const accountAdd = await runCli(
      home,
      [
        "account",
        "add",
        "corrupt-acct",
        "--vendor",
        VENDOR,
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      CANARY_KEY,
      env,
    );
    expect(accountAdd.code, accountAdd.stderr).toBe(0);

    const signupStart = await runCli(home, ["signup", "start", VENDOR, "--no-open"], undefined, env);
    expect(signupStart.code, signupStart.stderr).toBe(0);

    const vaultPath = path.join(home, "vault.enc.json");
    const accountsPath = path.join(home, "accounts.yaml");
    const signupsPath = path.join(home, "signups.yaml");
    const keysPath = path.join(home, "keys.yaml");

    const pristine = {
      vault: fs.readFileSync(vaultPath, "utf8"),
      accounts: fs.readFileSync(accountsPath, "utf8"),
      signups: fs.readFileSync(signupsPath, "utf8"),
      keys: fs.readFileSync(keysPath, "utf8"),
    };

    const surfaces: { name: string; text: string }[] = [];
    const record = async (label: string, argv: string[], opts?: { stdin?: string }): Promise<void> => {
      const result = await runCli(home, argv, opts?.stdin, env);
      surfaces.push({ name: `${label}:${argv.join(" ")}`, text: `${result.stdout}\n${result.stderr}` });
    };

    async function runCorruptionChecks(label: string): Promise<void> {
      await record(label, ["account", "list"]);
      await record(label, ["account", "show", "corrupt-acct"]);
      await record(label, ["signup", "status"]);
      await record(label, ["run", "--env", "X=vault://corrupt-acct", "--", "node", "-e", "0"]);
      await record(label, ["signup", "complete", "exa", "--stdin"], { stdin: "sk-nd3-exa-dummy" });
    }

    // (i) truncated vault.enc.json
    fs.writeFileSync(vaultPath, pristine.vault.slice(0, Math.floor(pristine.vault.length / 2)));
    await runCorruptionChecks("vault-truncated");
    fs.writeFileSync(vaultPath, pristine.vault);

    // (ii) vault.enc.json with "tag" flipped
    {
      const parsed = JSON.parse(pristine.vault) as { tag: string };
      const chars = parsed.tag.split("");
      const flipIndex = chars.findIndex((c) => c !== "=");
      if (flipIndex >= 0) chars[flipIndex] = chars[flipIndex] === "A" ? "B" : "A";
      parsed.tag = chars.join("");
      fs.writeFileSync(vaultPath, JSON.stringify(parsed, null, 2));
    }
    await runCorruptionChecks("vault-tag-flipped");
    fs.writeFileSync(vaultPath, pristine.vault);

    // (iii) vault.enc.json missing the "secrets" field
    {
      const parsed = JSON.parse(pristine.vault) as Record<string, unknown>;
      delete parsed["secrets"];
      fs.writeFileSync(vaultPath, JSON.stringify(parsed, null, 2));
    }
    await runCorruptionChecks("vault-missing-secrets");
    fs.writeFileSync(vaultPath, pristine.vault);

    // (iv) invalid JSON
    fs.writeFileSync(vaultPath, "{ this is not valid json ::: ");
    await runCorruptionChecks("vault-invalid-json");
    fs.writeFileSync(vaultPath, pristine.vault);

    // (v) accounts.yaml with garbage rows/missing required fields
    fs.writeFileSync(
      accountsPath,
      "version: 1\naccounts:\n  - just_a_string_field: true\n  - name: ok-but-no-vendor\n",
    );
    await runCorruptionChecks("accounts-garbage");
    fs.writeFileSync(accountsPath, pristine.accounts);

    // (vi) signups.yaml with garbage rows/missing fields
    fs.writeFileSync(signupsPath, "version: 1\nsessions:\n  - vendor: apify\n  - state: bound\n");
    await runCorruptionChecks("signups-garbage");
    fs.writeFileSync(signupsPath, pristine.signups);

    // (vii) keys.yaml entry missing domain
    fs.writeFileSync(
      keysPath,
      [
        "version: 1",
        "keys:",
        "  - alias: corrupt-acct",
        "    platform: apify",
        "    header: Authorization",
        "    format: 'Bearer {key}'",
        "    created: '2024-01-01T00:00:00.000Z'",
        "    disabled: false",
        "",
      ].join("\n"),
    );
    await runCorruptionChecks("keys-missing-domain");
    fs.writeFileSync(keysPath, pristine.keys);

    for (const surface of surfaces) assertClean(surface.name, surface.text);
    sweepHome(home);
  });

  it("c) missing input fields: empty/whitespace stdin never echo the canaries", async () => {
    const surfaces: { name: string; text: string }[] = [];
    const record = (name: string, result: { stdout: string; stderr: string }): void => {
      surfaces.push({ name, text: `${result.stdout}\n${result.stderr}` });
    };

    const emptyStdin = await runCli(home, ["signup", "complete", VENDOR, "--stdin"], "", env);
    expect(emptyStdin.code).not.toBe(0);
    record("signup complete (empty stdin)", emptyStdin);

    const whitespaceStdin = await runCli(home, ["signup", "complete", VENDOR, "--stdin"], "   \n", env);
    expect(whitespaceStdin.code).not.toBe(0);
    record("signup complete (whitespace stdin)", whitespaceStdin);

    const oneLineEmailStdin = await runCli(
      home,
      ["account", "add", "oneline-acct", "--vendor", VENDOR, "--email-stdin", "--store-login", "--stdin"],
      CANARY_EMAIL,
      env,
    );
    expect(oneLineEmailStdin.code).not.toBe(0);
    record("account add (email-stdin+stdin, one line)", oneLineEmailStdin);

    const emptyPassword = await runCli(
      home,
      ["account", "add", "emptypw-acct", "--vendor", VENDOR, "--email-stdin", "--store-login", "--stdin"],
      `${CANARY_EMAIL}\n`,
      env,
    );
    expect(emptyPassword.code).not.toBe(0);
    record("account add --store-login (empty password line)", emptyPassword);

    expect(findAccount("oneline-acct", home)).toBeUndefined();
    expect(findAccount("emptypw-acct", home)).toBeUndefined();

    for (const surface of surfaces) assertClean(surface.name, surface.text);
    sweepHome(home);
  });

  it("d) driver throws / rejects / completes: nothing leaks, failures land as needs_human/signup_failed, a real completion is bound and never printed", async () => {
    const throwingDriver: Nd2SignupDriver = {
      run: async () => {
        throw new Error(`vendor said ${CANARY_KEY} ${CANARY_PW}`);
      },
    };
    const rejectingDriver: Nd2SignupDriver = {
      run: () => Promise.reject({ message: `oops ${CANARY_KEY}`, canary: CANARY_PW }),
    };

    const throwOutput = await captureOutput(async () => {
      await cmdSignupStart(
        VENDOR,
        { account: "throw-acct", noOpen: true, json: false, driverFor: () => throwingDriver },
        home,
      );
    });
    assertClean("in-process:driver throws (text)", throwOutput);
    const throwSession = readSignups(home).sessions.find((s) => s.account === "throw-acct");
    expect(throwSession?.state).toBe("needs_human");
    expect(throwSession?.reason).toBe("signup_failed");
    assertClean("signups.yaml:after driver throws", fs.readFileSync(path.join(home, "signups.yaml"), "utf8"));

    const rejectOutput = await captureOutput(async () => {
      await cmdSignupStart(
        VENDOR,
        { account: "reject-acct", noOpen: true, json: true, driverFor: () => rejectingDriver },
        home,
      );
    });
    assertClean("in-process:driver rejects (json)", rejectOutput);
    const rejectSession = readSignups(home).sessions.find((s) => s.account === "reject-acct");
    expect(rejectSession?.state).toBe("needs_human");
    expect(rejectSession?.reason).toBe("signup_failed");

    // --- a real completion: text mode ---------------------------------------
    // In-process binding opens the encrypted-file vault, so it needs this home's passphrase.
    process.env.SKELETONKEY_PASSPHRASE = CANARY_PASS;
    const completeDriver: Nd2SignupDriver = {
      run: async () => ({ kind: "complete", apiKey: CANARY_KEY }),
    };
    const textOutput = await captureOutput(async () => {
      await cmdSignupStart(
        VENDOR,
        { account: "complete-text-acct", noOpen: true, json: false, driverFor: () => completeDriver },
        home,
      );
    });
    assertClean("in-process:driver completes (text)", textOutput);
    expect(textOutput).toContain("vault://complete-text-acct");

    // --- a real completion: json mode ---------------------------------------
    const jsonOutput = await captureOutput(async () => {
      await cmdSignupStart(
        VENDOR,
        { account: "complete-json-acct", noOpen: true, json: true, driverFor: () => completeDriver },
        home,
      );
    });
    assertClean("in-process:driver completes (json)", jsonOutput);
    expect(jsonOutput).toContain("vault://complete-json-acct");
    const parsedJson = JSON.parse(jsonOutput) as { refs: string[] };
    expect(parsedJson.refs).toContain("vault://complete-json-acct");

    // --- the key really landed in the vault, proven only via a hash --------
    try {
      const store = openEntryStore(home);
      const resolved = store.resolve("complete-text-acct");
      expect(resolved).not.toBeNull();
      const value = await store.getField(resolved!, "api_key");
      expect(value).not.toBeNull();
      const hash = crypto.createHash("sha256").update(value as string).digest("hex");
      expect(hash).toBe(crypto.createHash("sha256").update(CANARY_KEY).digest("hex"));
    } finally {
      delete process.env.SKELETONKEY_PASSPHRASE;
    }

    sweepHome(home);
  });
});
