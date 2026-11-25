/**
 * ND-2 HARD RULE, as a test: the key a human types into `skeletonkey signup
 * complete` never reaches any surface an agent (or a human reading a
 * terminal/log) can see other than a `vault://` reference.
 *
 * Mirrors test/accounts-canary.test.ts: one fake canary key, pushed through
 * `signup start` -> `signup complete` -> vault -> `run`, then swept off every
 * surface -- CLI stdout/stderr, signups.yaml, accounts.yaml, keys.yaml, every
 * file under SKELETONKEY_HOME (including the encrypted vault), and every MCP
 * tool response (list_accounts and the new signup_status).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callSkeletonKeyTool, SKELETONKEY_TOOLS, type McpContext } from "../src/mcp.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const CANARY_KEY = "sk-canary-ND2-SIGNUPKEY-0xDEC0DE11";
const PASSPHRASE = "canary-ND2-SIGNUP-PASSPHRASE-0xDEC0DE22";
const VENDOR = "apify";
const ACCOUNT = "apify-main";

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

describe("ND-2 HARD RULE: no signup key reaches any surface", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    home = makeHome();
    env = { SKELETONKEY_PASSPHRASE: PASSPHRASE };
    const init = await runCli(
      home,
      ["init", "--email", "dev@example.test", "--backend", "encrypted-file"],
      undefined,
      env,
    );
    expect(init.code, init.stderr).toBe(0);
  });

  afterEach(() => removeHome(home));

  it("sweeps CLI output, every file under home (incl. vault.enc.json), and every MCP tool", async () => {
    const surfaces: { name: string; text: string }[] = [];
    const record = (name: string, result: { stdout: string; stderr: string }): void => {
      surfaces.push({ name, text: `${result.stdout}\n${result.stderr}` });
    };

    const start = await runCli(home, ["signup", "start", VENDOR, "--no-open"], undefined, env);
    expect(start.code, start.stderr).toBe(0);
    record("cli:signup start", start);

    const complete = await runCli(
      home,
      ["signup", "complete", VENDOR, "--stdin"],
      CANARY_KEY,
      env,
    );
    expect(complete.code, complete.stderr).toBe(0);
    record("cli:signup complete", complete);
    expect(complete.stdout).toContain(`vault://${ACCOUNT}`);

    for (const argv of [
      ["signup", "list"],
      ["signup", "list", "--json"],
      ["signup", "status"],
      ["signup", "status", "--json"],
      ["signup", "status", VENDOR],
      ["signup", "status", VENDOR, "--json"],
      ["account", "list"],
      ["account", "list", "--json"],
      ["account", "show", ACCOUNT],
      ["account", "show", ACCOUNT, "--json"],
      ["list"],
      ["list", "--json"],
    ]) {
      const result = await runCli(home, argv, undefined, env);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
      record(`cli:${argv.join(" ")}`, result);
    }

    // --- run: redacted stdout, and proof the injection really happened -----
    const redacted = await runCli(
      home,
      ["run", "--env", `X=vault://${ACCOUNT}`, "--", "node", "-e", "console.log(process.env.X)"],
      undefined,
      env,
    );
    expect(redacted.code, redacted.stderr).toBe(0);
    expect(redacted.stdout).toContain("[redacted]");
    record("run (redacted stdout)", redacted);

    const hashProof = await runCli(
      home,
      [
        "run",
        "--env",
        `X=vault://${ACCOUNT}`,
        "--",
        "node",
        "-e",
        "process.stdout.write(require('crypto').createHash('sha256').update(process.env.X).digest('hex'))",
      ],
      undefined,
      env,
    );
    expect(hashProof.code, hashProof.stderr).toBe(0);
    const expectedHash = crypto.createHash("sha256").update(CANARY_KEY).digest("hex");
    expect(hashProof.stdout.trim()).toBe(expectedHash);
    record("run (hash proof)", hashProof);

    // --- a failing attempt must not echo the canary either ----------------
    const dup = await runCli(home, ["signup", "complete", VENDOR, "--stdin"], CANARY_KEY, env);
    expect(dup.code).not.toBe(0);
    record("cli:signup complete (duplicate, failing)", dup);

    // --- every MCP tool, including signup_status and list_accounts --------
    const ctx: McpContext = { home, allowTtyPrompt: false };
    const toolArgs: Record<string, Record<string, unknown>> = {
      find_api: { capability: "web scraping" },
      list_keys: {},
      list_accounts: {},
      signup_status: { vendor: VENDOR },
      monitor_status: {},
      key_status: { alias: ACCOUNT },
      request_access: { platform: "Apify", reason: "canary sweep", est_budget: 1 },
      access_status: { request_id: "req_0000000000000000" },
      cancel_request: { request_id: "req_0000000000000000", reason: "sweep" },
      spend_policy: {},
      discover_api: { capability: "canary sweep", vendor: "canary" },
      propose_entry: {
        name: "probe-vendor-canary",
        url: "https://probe.test/docs",
        access_mode: "own-account",
        source_urls: ["https://probe.test/docs"],
      },
      register_key: { alias: "new-key-canary", platform: "Canary", domain: "api.canary.test" },
      ledger: { limit: 10 },
      disable: { alias: ACCOUNT, reason: "sweep" },
    };
    expect(Object.keys(toolArgs).sort()).toEqual(SKELETONKEY_TOOLS.map((tool) => tool.name).sort());
    for (const tool of SKELETONKEY_TOOLS) {
      const result = await callSkeletonKeyTool(tool.name, toolArgs[tool.name] ?? {}, ctx);
      surfaces.push({ name: `tool:${tool.name}`, text: JSON.stringify(result) });
    }

    // signup_status specifically: sessions and vendor_info, never a secret.
    const signupStatusTool = await callSkeletonKeyTool("signup_status", { vendor: VENDOR }, ctx);
    const signupStatusText = JSON.stringify(signupStatusTool);
    expect(signupStatusText).toContain(VENDOR);
    expect(signupStatusText).toContain("bound");
    expect(signupStatusText).toContain("https://console.apify.com/sign-up");

    // list_accounts: the account and a vault:// ref, never the key.
    const accountsTool = await callSkeletonKeyTool("list_accounts", {}, ctx);
    const accountsText = JSON.stringify(accountsTool);
    expect(accountsText).toContain(ACCOUNT);
    expect(accountsText).toContain("vault://");

    // re-enable (the `disable` tool call above disabled the key)
    await runCli(home, ["account", "enable", ACCOUNT], undefined, env);

    // --- every file under SKELETONKEY_HOME, including the ciphertext ------
    for (const file of filesUnder(home)) {
      surfaces.push({
        name: `file:${path.relative(home, file)}`,
        text: fs.readFileSync(file).toString("latin1"),
      });
    }

    expect(surfaces.length).toBeGreaterThan(20);
    for (const surface of surfaces) {
      expect(surface.text, `${surface.name} leaked the key`).not.toContain(CANARY_KEY);
      expect(surface.text, `${surface.name} leaked the passphrase`).not.toContain(PASSPHRASE);
      expect(surface.text, `${surface.name} leaked a fragment`).not.toContain("0xDEC0DE11");
    }

    // --- metadata files hold no secret, ever -------------------------------
    const signupsYaml = fs.readFileSync(path.join(home, "signups.yaml"), "utf8");
    expect(signupsYaml).toContain("NO SECRET VALUES ARE STORED HERE");
    const accountsYaml = fs.readFileSync(path.join(home, "accounts.yaml"), "utf8");
    expect(accountsYaml).toContain("NO SECRET VALUES ARE STORED HERE");

    // The ciphertext vault really exists and really is the secret store.
    const encPath = path.join(home, "vault.enc.json");
    expect(fs.existsSync(encPath)).toBe(true);
    expect(fs.statSync(encPath).size).toBeGreaterThan(0);
  });
});
