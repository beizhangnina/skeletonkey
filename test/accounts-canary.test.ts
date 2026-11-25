/**
 * ND-1 HARD RULE, as a test: an account's key, password, and email never
 * reach any surface an agent (or a human reading a terminal/log) can see.
 *
 * Extends the style of test/canary.test.ts and test/run-canary.test.ts for
 * the new `account *` commands and the `list_accounts` MCP tool: every value
 * below is a fake canary, pushed through the real `account add` -> vault ->
 * `run` path, then swept off every surface -- CLI stdout/stderr,
 * accounts.yaml, keys.yaml, entries.yaml, every file under SKELETONKEY_HOME,
 * and every MCP tool response.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callSkeletonKeyTool, SKELETONKEY_TOOLS, type McpContext } from "../src/mcp.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const CANARIES = {
  api_key: "sk-canary-ND1-ACCTKEY-0xACC0FFEE11",
  password: "canary-ND1-ACCTPW-0xACC0FFEE22",
  email: "canary-nd1-0xacc0ffee33@example.test",
};

const FRAGMENTS = ["0xACC0FFEE11", "0xACC0FFEE22", "0xacc0ffee33", "sk-canary-ND1-ACCTKEY"];

const ACCOUNT = "apify-canary";
const DOMAIN = "api.apify.com";

interface Harness {
  home: string;
  ctx: McpContext;
  surfaces: { name: string; text: string }[];
}

async function setUp(): Promise<Harness> {
  const home = makeHome();
  const surfaces: { name: string; text: string }[] = [];
  const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  expect(init.code, init.stderr).toBe(0);

  const add = await runCli(
    home,
    [
      "account",
      "add",
      ACCOUNT,
      "--vendor",
      "apify",
      "--email-stdin",
      "--store-key",
      "--domain",
      DOMAIN,
      "--stdin",
      "--yes",
    ],
    `${CANARIES.email}\n${CANARIES.api_key}`,
  );
  if (add.code !== 0) throw new Error(`account add (key) failed: ${add.stderr}`);
  surfaces.push({ name: "cli:account add (key)", text: `${add.stdout}\n${add.stderr}` });

  // A second call attaches the login half: each call reads exactly one
  // secret off stdin, which is the rule `account add` enforces.
  const addLogin = await runCli(
    home,
    ["account", "add", ACCOUNT, "--vendor", "apify", "--email-stdin", "--store-login", "--stdin", "--yes"],
    `${CANARIES.email}\n${CANARIES.password}`,
  );
  if (addLogin.code !== 0) throw new Error(`account add (login) failed: ${addLogin.stderr}`);
  surfaces.push({ name: "cli:account add (login)", text: `${addLogin.stdout}\n${addLogin.stderr}` });

  const ctx: McpContext = { home, allowTtyPrompt: false };
  return { home, ctx, surfaces };
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

describe("ND-1 HARD RULE: no account secret reaches any surface", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setUp();
  });
  afterEach(() => {
    removeHome(h.home);
  });

  it("sweeps CLI output, every file under home, and every MCP tool for the canaries", async () => {
    const surfaces = h.surfaces;

    // --- sanity: the canaries are really in the vault --------------------
    expect(fs.readFileSync(path.join(h.home, "dev-vault.json"), "utf8")).toContain(CANARIES.api_key);
    expect(fs.readFileSync(path.join(h.home, "dev-vault.json"), "utf8")).toContain(CANARIES.password);
    expect(fs.readFileSync(path.join(h.home, "dev-vault.json"), "utf8")).toContain(CANARIES.email);

    // --- account list / list --json / show -------------------------------
    for (const argv of [
      ["account", "list"],
      ["account", "list", "--json"],
      ["account", "list", "--active"],
      ["account", "show", ACCOUNT],
      ["account", "show", ACCOUNT, "--json"],
    ]) {
      const result = await runCli(h.home, argv);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
      surfaces.push({ name: `cli:${argv.join(" ")}`, text: `${result.stdout}\n${result.stderr}` });
    }

    // --- disable / enable --------------------------------------------------
    for (const argv of [["account", "disable", ACCOUNT], ["account", "enable", ACCOUNT]]) {
      const result = await runCli(h.home, argv);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
      surfaces.push({ name: `cli:${argv.join(" ")}`, text: `${result.stdout}\n${result.stderr}` });
    }

    // --- failing variants: none of them may echo a canary ----------------
    const failing: { argv: string[]; stdin?: string }[] = [
      {
        argv: ["account", "add", "bad-vendor-canary", "--vendor", "NOT_VALID!", "--email-stdin"],
        stdin: CANARIES.email,
      },
      { argv: ["account", "add", ACCOUNT, "--vendor", "apify", "--email-stdin"], stdin: CANARIES.email }, // duplicate, no --yes
      {
        argv: [
          "account",
          "add",
          "missing-link-canary",
          "--vendor",
          "apify",
          "--key-alias",
          "does-not-exist-canary",
          "--email-stdin",
        ],
        stdin: CANARIES.email,
      },
      {
        argv: [
          "account",
          "add",
          "wrong-backend-canary",
          "--vendor",
          "apify",
          "--email-stdin",
          "--store-key",
          "--domain",
          DOMAIN,
          "--stdin",
        ],
        stdin: `${CANARIES.email}\n${CANARIES.api_key}`,
      },
      // The removed plaintext flag itself: rejected with a usage error, and
      // its value never reaches any surface either.
      {
        argv: ["account", "add", "plaintext-email-canary", "--vendor", "apify", "--email", CANARIES.email],
      },
    ];
    for (const { argv, stdin } of failing) {
      const env = argv.includes("wrong-backend-canary") ? { SKELETONKEY_ALLOW_TEST_BACKEND: "" } : {};
      const result = await runCli(h.home, argv, stdin, env);
      expect(result.code, `${argv.join(" ")} unexpectedly succeeded`).not.toBe(0);
      surfaces.push({ name: `cli:${argv.join(" ")} (failing)`, text: `${result.stdout}\n${result.stderr}` });
    }
    expect(
      surfaces.find((s) => s.name.includes("wrong-backend-canary"))?.text,
    ).toContain("error backend_refused");
    const plaintextRejection = surfaces.find((s) => s.name.includes("plaintext-email-canary"))?.text;
    expect(plaintextRejection).toContain("error usage");
    expect(plaintextRejection).toContain("no longer accepted");
    const plaintextResult = await runCli(h.home, [
      "account",
      "add",
      "plaintext-email-canary",
      "--vendor",
      "apify",
      "--email",
      CANARIES.email,
    ]);
    expect(plaintextResult.code).toBe(64);
    const plaintextShow = await runCli(h.home, ["account", "show", "plaintext-email-canary"]);
    expect(plaintextShow.code).toBe(66); // nothing was written

    // --- `run`: redacted stdout, and proof the injection really happened --
    const redacted = await runCli(h.home, [
      "run",
      "--env",
      `X=vault://${ACCOUNT}`,
      "--",
      "node",
      "-e",
      "console.log(process.env.X)",
    ]);
    expect(redacted.code, redacted.stderr).toBe(0);
    expect(redacted.stdout).toContain("[redacted]");
    surfaces.push({ name: "run (redacted stdout)", text: `${redacted.stdout}\n${redacted.stderr}` });

    const hashProof = await runCli(h.home, [
      "run",
      "--env",
      `X=vault://${ACCOUNT}`,
      "--",
      "node",
      "-e",
      "process.stdout.write(require('crypto').createHash('sha256').update(process.env.X).digest('hex'))",
    ]);
    expect(hashProof.code, hashProof.stderr).toBe(0);
    const expectedHash = crypto.createHash("sha256").update(CANARIES.api_key).digest("hex");
    expect(hashProof.stdout.trim()).toBe(expectedHash);
    surfaces.push({ name: "run (hash proof)", text: `${hashProof.stdout}\n${hashProof.stderr}` });

    const loginRun = await runCli(h.home, [
      "run",
      "--env",
      `P=vault://${ACCOUNT}-login.password`,
      "--",
      "node",
      "-e",
      "console.log(process.env.P)",
    ]);
    expect(loginRun.code, loginRun.stderr).toBe(0);
    expect(loginRun.stdout).toContain("[redacted]");
    surfaces.push({ name: "run (login, redacted stdout)", text: `${loginRun.stdout}\n${loginRun.stderr}` });

    // --- every MCP tool, including the new one, plus hostile arguments ---
    const toolArgs: Record<string, Record<string, unknown>> = {
      find_api: { capability: "web scraping" },
      list_keys: {},
      list_accounts: {},
      signup_status: {},
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
      monitor_status: {},
    };
    expect(Object.keys(toolArgs).sort()).toEqual(SKELETONKEY_TOOLS.map((tool) => tool.name).sort());
    for (const tool of SKELETONKEY_TOOLS) {
      const result = await callSkeletonKeyTool(tool.name, toolArgs[tool.name] ?? {}, h.ctx);
      surfaces.push({ name: `tool:${tool.name}`, text: JSON.stringify(result) });
      // Structural hostile args (a path, a wildcard, an empty object): none of
      // them can make a tool read or echo a stored value, since no handler in
      // this process ever registered a secret with the redactor to begin with
      // -- `list_accounts` is metadata-only by construction.
      for (const args of [{}, { alias: "../../etc/passwd", name: "*", platform: "*" }]) {
        const hostile = await callSkeletonKeyTool(tool.name, args, h.ctx);
        surfaces.push({ name: `tool:${tool.name} (hostile)`, text: JSON.stringify(hostile) });
      }
    }
    // list_accounts specifically: metadata and refs, never the email or the key.
    const accounts = await callSkeletonKeyTool("list_accounts", {}, h.ctx);
    const accountsText = JSON.stringify(accounts);
    expect(accountsText).toContain(ACCOUNT);
    expect(accountsText).toContain("vault://");

    // --- re-enable (the disable tool call above disabled it) -------------
    await runCli(h.home, ["account", "enable", ACCOUNT]);

    // --- every file under SKELETONKEY_HOME (skip the plaintext test vault,
    // which IS the secret store) -------------------------------------------
    for (const file of filesUnder(h.home)) {
      if (file.endsWith("dev-vault.json")) continue;
      surfaces.push({
        name: `file:${path.relative(h.home, file)}`,
        text: fs.readFileSync(file).toString("latin1"),
      });
    }

    // --- the sweep ---------------------------------------------------------
    expect(surfaces.length).toBeGreaterThan(20);
    for (const surface of surfaces) {
      for (const [name, value] of Object.entries(CANARIES)) {
        expect(surface.text, `${surface.name} leaked ${name}`).not.toContain(value);
      }
      for (const fragment of FRAGMENTS) {
        expect(surface.text, `${surface.name} leaked a fragment`).not.toContain(fragment);
      }
    }

    // --- accounts.yaml / keys.yaml / entries.yaml hold no value, ever ----
    const accountsYaml = fs.readFileSync(path.join(h.home, "accounts.yaml"), "utf8");
    expect(accountsYaml).not.toMatch(/email_hint:\s*["']?canary-nd1-0xacc0ffee33@example\.test/);
    expect(accountsYaml).toContain("NO SECRET VALUES ARE STORED HERE");
  });
});
