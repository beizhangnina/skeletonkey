/**
 * ND-3 extras: the legacy AutoSignupExecutor (still the runner's default
 * signup runner) must also stop at payment and never echo driver errors; and
 * every MCP tool stays clean while the vault is locked (wrong passphrase) or
 * corrupted. Fake values only; no network.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callSkeletonKeyTool, SKELETONKEY_TOOLS, type McpContext } from "../src/mcp.js";
import { AutoSignupExecutor, type SignupDriver } from "../src/signup/executor.js";
import type { SignupContext } from "../src/signup/types.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const CANARY_KEY = "sk-nd3x-CANARY-KEY-5e1d9a2b77";
const CANARY_PASS = "nd3x-CANARY-PASSPHRASE-a91c";
const WRONG_PASS = "nd3x-WRONGPASS-b3d7";
const CANARY_CARD = "4242424242424242";
const SENTINELS = [CANARY_KEY, CANARY_PASS, WRONG_PASS, CANARY_CARD, "5e1d9a2b77"];

function assertClean(label: string, text: string): void {
  for (const s of SENTINELS) expect(text, `${label} leaked ${s.slice(0, 6)}…`).not.toContain(s);
  expect(text.includes("    at "), `${label} has a stack trace`).toBe(false);
}

function fakeContext(log: string[]): SignupContext {
  return {
    vendor: "apify",
    domain: "console.apify.com",
    signupUrl: "https://console.apify.com/sign-up",
    email: "dev@example.test",
    resolveSecret: async () => null,
    log: (line) => log.push(line),
  };
}

function fakeVault() {
  const set = vi.fn(async () => undefined);
  // Only `set` is used by the executor.
  return { vault: { set } as never, set };
}

describe("ND-3 extra: legacy AutoSignupExecutor", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error("network disabled in tests");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("no driver -> needs_human (live_driver_unavailable), handle null", async () => {
    const log: string[] = [];
    const out = await new AutoSignupExecutor().run(fakeContext(log));
    expect(out.status).toBe("needs_human");
    expect(out.handle).toBeNull();
    expect(out.reason).toBe("live_driver_unavailable");
  });

  it("payment step -> needs_human/payment, no further driver call, nothing stored", async () => {
    const { vault, set } = fakeVault();
    const driver: SignupDriver = {
      open: vi.fn(async () => ({ kind: "payment" as const })),
      oauth: vi.fn(),
      password: vi.fn(),
      otp: vi.fn(),
    } as unknown as SignupDriver;
    const log: string[] = [];
    const out = await new AutoSignupExecutor({ driverFor: () => driver, vault }).run(fakeContext(log));
    expect(out.status).toBe("needs_human");
    expect(out.reason).toBe("payment");
    expect(out.handle).toBeNull();
    expect(driver.oauth).not.toHaveBeenCalled();
    expect(driver.password).not.toHaveBeenCalled();
    expect(driver.otp).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("driver throws with a canary/card in the message -> signup_failed, nothing echoed", async () => {
    const { vault } = fakeVault();
    const driver = {
      open: async () => {
        throw new Error(`vendor body ${CANARY_KEY} card=${CANARY_CARD}`);
      },
    } as unknown as SignupDriver;
    const log: string[] = [];
    const out = await new AutoSignupExecutor({ driverFor: () => driver, vault }).run(fakeContext(log));
    expect(out.status).toBe("needs_human");
    expect(out.reason).toBe("signup_failed");
    assertClean("executor outcome", JSON.stringify(out));
    assertClean("executor log", log.join("\n"));
  });

  it("complete never claims ready: key stored, outcome is needs_human/key_binding_required, key not in log", async () => {
    const { vault, set } = fakeVault();
    const driver = {
      open: async () => ({ kind: "complete" as const, apiKey: CANARY_KEY }),
    } as unknown as SignupDriver;
    const log: string[] = [];
    const out = await new AutoSignupExecutor({ driverFor: () => driver, vault }).run(fakeContext(log));
    expect(out.status).toBe("needs_human");
    expect(out.reason).toBe("key_binding_required");
    expect(out.handle).toBeNull();
    expect(set).toHaveBeenCalledTimes(1);
    assertClean("executor outcome", JSON.stringify(out));
    assertClean("executor log", log.join("\n"));
  });
});

describe("ND-3 extra: every MCP tool with a locked or corrupted vault", () => {
  let home: string;
  const env = { SKELETONKEY_PASSPHRASE: CANARY_PASS };
  const knownToolArgs = (alias: string): Record<string, Record<string, unknown>> => ({
    find_api: { capability: "web scraping" },
    list_keys: {},
    list_accounts: {},
    signup_status: { vendor: "apify" },
    key_status: { alias },
    request_access: { platform: "Apify", reason: "nd3 sweep", est_budget: 1 },
    access_status: { request_id: "req_0000000000000000" },
    cancel_request: { request_id: "req_0000000000000000", reason: "sweep" },
    spend_policy: {},
    discover_api: { capability: "nd3 sweep", vendor: "canary" },
    propose_entry: {
      name: "probe-vendor-nd3x",
      url: "https://probe.test/docs",
      access_mode: "own-account",
      source_urls: ["https://probe.test/docs"],
    },
    register_key: { alias: "new-key-nd3x", platform: "Canary", domain: "api.canary.test" },
    ledger: { limit: 10 },
    disable: { alias, reason: "sweep" },
    monitor_status: {},
  });

  beforeEach(async () => {
    home = makeHome();
    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "encrypted-file"], undefined, env);
    expect(init.code, init.stderr).toBe(0);
    const complete = await runCli(home, ["signup", "complete", "apify", "--stdin"], CANARY_KEY, env);
    expect(complete.code, complete.stderr).toBe(0);
  });
  afterEach(() => {
    delete process.env.SKELETONKEY_PASSPHRASE;
    removeHome(home);
  });

  async function sweepAllTools(label: string): Promise<void> {
    const ctx: McpContext = { home, allowTtyPrompt: false };
    // Driven by the registered tool list, not by the known-args map: a tool
    // with no mapping is still called (with {}), never skipped.
    const known = knownToolArgs("apify-main");
    const covered: string[] = [];
    expect(SKELETONKEY_TOOLS.length).toBeGreaterThan(0);
    for (const tool of SKELETONKEY_TOOLS) {
      covered.push(tool.name);
      let text: string;
      try {
        text = JSON.stringify(await callSkeletonKeyTool(tool.name, known[tool.name] ?? {}, ctx));
      } catch (error) {
        // A thrown error reaching the MCP layer is itself a finding; record it in the label.
        assertClean(`${label}:tool:${tool.name} (threw)`, String(error));
        continue;
      }
      assertClean(`${label}:tool:${tool.name}`, text);
    }
    expect(covered.sort()).toEqual(SKELETONKEY_TOOLS.map((t) => t.name).sort());
    expect(covered.length).toBe(SKELETONKEY_TOOLS.length);
    console.log(`nd3-extra ${label}: covered ${covered.length} tools: ${covered.join(", ")}`);
  }

  it("wrong passphrase: every registered MCP tool leaks nothing", async () => {
    process.env.SKELETONKEY_PASSPHRASE = WRONG_PASS;
    await sweepAllTools("wrong-pass");
  });

  it("corrupted vault.enc.json: every registered MCP tool leaks nothing", async () => {
    const p = path.join(home, "vault.enc.json");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").slice(0, 80));
    process.env.SKELETONKEY_PASSPHRASE = CANARY_PASS;
    await sweepAllTools("corrupt-vault");
  });
});
