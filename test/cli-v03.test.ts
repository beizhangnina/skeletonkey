/**
 * The v0.3 CLI surfaces, end to end through the built binary: agent
 * registration in `init`, the spend policy, the request list, and the kill
 * switch -- which has to stop the proxy, not just the runner.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killSwitchState } from "../src/killswitch.js";
import { readKeys } from "../src/keys.js";
import { readPolicy, vendorCap } from "../src/policy.js";
import { startProxy, type ProxyHandle } from "../src/proxy.js";
import { RequestStore } from "../src/requests.js";
import { initWithKey, makeHome, removeHome, runCli } from "./helpers/env.js";
import { startEchoServer, type EchoServer } from "./helpers/echo-server.js";

const SECRET = "sk-test-FAKE-cli-v03-5555";

describe("skeletonkey init registers the two supported agents", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  /** runCli points SKELETONKEY_USER_HOME here, so the real home is untouched. */
  const userHome = (): string => path.join(home, "fake-user-home");

  it("writes the Claude Code and Codex config under the configured home", async () => {
    const result = await runCli(home, [
      "init",
      "--email",
      "dev@example.test",
      "--backend",
      "file",
      "--yes",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Agent registration \(Claude Code and Codex only\)/);
    expect(result.stdout).toMatch(/wrote .*\.claude\.json/);

    const claude = JSON.parse(
      fs.readFileSync(path.join(userHome(), ".claude.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(claude.mcpServers["skeletonkey"]).toBeDefined();
    expect(
      fs.readFileSync(path.join(userHome(), ".codex", "config.toml"), "utf8"),
    ).toContain("[mcp_servers.skeletonkey]");
    expect(
      fs.existsSync(path.join(userHome(), ".claude", "skills", "skeletonkey", "SKILL.md")),
    ).toBe(true);

    // Nothing outside the configured home: `~` is never written by the suite.
    expect(result.stdout).not.toMatch(new RegExp(`${process.env["HOME"]}/\\.claude`));
  });

  it("skips registration with --no-register, and `register` can do it later", async () => {
    const init = await runCli(home, [
      "init",
      "--email",
      "dev@example.test",
      "--backend",
      "file",
      "--no-register",
    ]);
    expect(init.code).toBe(0);
    expect(init.stdout).toMatch(/Skipped agent registration/);
    expect(fs.existsSync(path.join(userHome(), ".claude.json"))).toBe(false);

    const dry = await runCli(home, ["register", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/--dry-run: nothing was written/);
    expect(fs.existsSync(path.join(userHome(), ".claude.json"))).toBe(false);

    const applied = await runCli(home, ["register"]);
    expect(applied.code).toBe(0);
    expect(fs.existsSync(path.join(userHome(), ".claude.json"))).toBe(true);

    // Re-running it is the documented fix for "the MCP server is not showing".
    const again = await runCli(home, ["register"]);
    expect(again.stdout).toMatch(/Nothing to do: both agents are already registered/);
  });

  it("refuses an unsupported agent by name (D8)", async () => {
    await runCli(home, ["init", "--email", "d@e.test", "--backend", "file", "--no-register"]);
    const result = await runCli(home, ["register", "--agent", "cursor"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/must be `claude-code` or `codex`/);
  });
});

describe("the spend policy from the CLI", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    await initWithKey(home, { secret: SECRET });
  });
  afterEach(() => {
    removeHome(home);
  });

  it("starts at $0 and says so", async () => {
    const result = await runCli(home, ["policy", "show"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/global monthly cap: \$0/);
    expect(result.stdout).toMatch(/Every cap is \$0/);
    expect(result.stdout).toMatch(/Agents can never raise these/);
  });

  it("sets caps as the human, and records that the CLI did it", async () => {
    const result = await runCli(home, [
      "policy",
      "set",
      "--global",
      "25",
      "--vendor",
      "TikHub",
      "--vendor-cap",
      "5",
    ]);
    expect(result.code).toBe(0);
    const policy = readPolicy(home);
    expect(policy.global_monthly_cap_usd).toBe(25);
    expect(vendorCap(policy, "TikHub")).toBe(5);
    expect(policy.last_change_by).toBe("cli");
  });

  it("insists on a cap to set", async () => {
    const result = await runCli(home, ["policy", "set"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--global <usd> and\/or --vendor/);
  });

  it("lists requests, and says there are none to start with", async () => {
    const empty = await runCli(home, ["requests"]);
    expect(empty.stdout).toMatch(/No requests yet/);

    RequestStore.open(home).create({
      kind: "access",
      vendor: "TikHub",
      purpose: "search posts",
      est_budget_usd: 2,
    });
    const listed = await runCli(home, ["requests"]);
    expect(listed.stdout).toMatch(/TikHub/);
    expect(listed.stdout).toMatch(/pending_approval/);
    expect(listed.stdout).toMatch(/1 pending/);
  });
});

describe("the kill switch reaches the proxy as well as the runner", () => {
  let home: string;
  let echo: EchoServer;
  let proxy: ProxyHandle;
  let logs: string[];

  beforeEach(async () => {
    home = makeHome();
    logs = [];
    echo = await startEchoServer();
    await initWithKey(home, { alias: "echo-key", secret: SECRET, domain: "127.0.0.1" });
    proxy = await startProxy({
      port: 0,
      home,
      upstreamScheme: "http",
      logger: (line) => logs.push(line),
    });
  });
  afterEach(async () => {
    await proxy.close();
    await echo.close();
    removeHome(home);
  });

  it("refuses every proxied call once engaged, and resumes only for a human", async () => {
    const before = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(before.status).toBe(200);

    // A pending approval exists, so the kill switch has something to void.
    RequestStore.open(home).create({ kind: "access", vendor: "TikHub", est_budget_usd: 1 });

    const kill = await runCli(home, ["disable", "--all"]);
    expect(kill.code).toBe(0);
    expect(kill.stdout).toMatch(/Kill switch engaged/);
    expect(killSwitchState(home).engaged).toBe(true);
    // Every key is disabled too, so clearing the switch alone does not resume spend.
    expect(readKeys(home).keys.every((key) => key.disabled)).toBe(true);
    expect(RequestStore.open(home).pending()).toHaveLength(0);
    expect(RequestStore.open(home).list()[0]?.status).toBe("voided");

    const during = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(during.status).toBe(403);
    const body = (await during.json()) as { error: string; hint: string };
    expect(body.error).toBe("kill_switch");
    expect(body.hint).toMatch(/skeletonkey resume/);
    // The request never left the machine.
    expect(echo.requests).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/kill switch engaged/);

    const resume = await runCli(home, ["resume"]);
    expect(resume.stdout).toMatch(/Kill switch cleared/);
    expect(killSwitchState(home).engaged).toBe(false);

    // Still refused, because the key itself is disabled: two separate switches.
    const after = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(after.status).toBe(403);
    expect(((await after.json()) as { error: string }).error).toBe("key_disabled");

    await runCli(home, ["enable", "echo-key"]);
    const restored = await fetch(`${proxy.url}/127.0.0.1:${echo.port}/v1/hello`);
    expect(restored.status).toBe(200);
  });

  it("needs an alias or --all", async () => {
    const result = await runCli(home, ["disable"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Pass an alias, or --all/);
  });
});
