import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENTS,
  applyRegistration,
  DEFAULT_ARGS,
  DEFAULT_COMMAND,
  packagedSkillPath,
  planRegistration,
  renderDiff,
  TOML_BEGIN,
} from "../src/agents/register.js";
import { makeHome, removeHome, REPO_ROOT } from "./helpers/env.js";

const SKILL = path.join(REPO_ROOT, "skills", "skeletonkey", "SKILL.md");

describe("auto-registration for Claude Code and Codex (D8)", () => {
  let userHome: string;

  beforeEach(() => {
    userHome = makeHome();
  });
  afterEach(() => {
    removeHome(userHome);
  });

  const options = (): { userHome: string; skillFile: string } => ({
    userHome,
    skillFile: SKILL,
  });

  it("supports exactly the two agents the PRD allows", () => {
    expect([...AGENTS]).toEqual(["claude-code", "codex"]);
    const targets = planRegistration(options()).map((action) => action.agent);
    expect(new Set(targets)).toEqual(new Set(["claude-code", "codex"]));
  });

  it("plans without writing anything", () => {
    const planned = planRegistration(options());
    expect(planned.every((action) => action.change === "create")).toBe(true);
    expect(fs.existsSync(path.join(userHome, ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(userHome, ".codex", "config.toml"))).toBe(false);
    // The diff is for a human to read before anything happens.
    expect(renderDiff(planned[0]!)).toMatch(/\+ create/);
  });

  it("registers the MCP server and the skill for Claude Code", () => {
    applyRegistration(options());
    const config = JSON.parse(
      fs.readFileSync(path.join(userHome, ".claude.json"), "utf8"),
    ) as { mcpServers: Record<string, { command: string; args: string[]; type: string }> };
    expect(config.mcpServers["skeletonkey"]).toEqual({
      command: DEFAULT_COMMAND,
      args: [...DEFAULT_ARGS],
      type: "stdio",
    });
    const skill = path.join(userHome, ".claude", "skills", "skeletonkey", "SKILL.md");
    expect(fs.readFileSync(skill, "utf8")).toBe(fs.readFileSync(SKILL, "utf8"));
  });

  it("registers the MCP server, the skill, and an AGENTS.md pointer for Codex", () => {
    applyRegistration(options());
    const toml = fs.readFileSync(path.join(userHome, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.skeletonkey]");
    expect(toml).toContain(`command = "${DEFAULT_COMMAND}"`);
    expect(toml).toContain('args = ["-y", "@dormy/skeletonkey", "mcp"]');
    expect(fs.existsSync(path.join(userHome, ".codex", "skills", "skeletonkey", "SKILL.md"))).toBe(
      true,
    );
    const agents = fs.readFileSync(path.join(userHome, ".codex", "AGENTS.md"), "utf8");
    expect(agents).toMatch(/## SkeletonKey/);
    expect(agents).toMatch(/request_access/);
  });

  it("is idempotent: a second run changes nothing", () => {
    applyRegistration(options());
    const before = snapshot(userHome);
    const second = applyRegistration(options());
    expect(second.every((action) => action.change === "unchanged")).toBe(true);
    expect(snapshot(userHome)).toEqual(before);
  });

  it("keeps the user's own settings in ~/.claude.json", () => {
    fs.writeFileSync(
      path.join(userHome, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }, null, 2),
    );
    applyRegistration(options());
    const config = JSON.parse(
      fs.readFileSync(path.join(userHome, ".claude.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config["theme"]).toBe("dark");
    expect((config["mcpServers"] as Record<string, unknown>)["other"]).toEqual({
      command: "other",
    });
    expect((config["mcpServers"] as Record<string, unknown>)["skeletonkey"]).toBeDefined();
  });

  it("refuses to rewrite a ~/.claude.json it cannot parse", () => {
    const file = path.join(userHome, ".claude.json");
    fs.writeFileSync(file, "{ this is not json");
    const actions = applyRegistration(options());
    expect(fs.readFileSync(file, "utf8")).toBe("{ this is not json");
    const claude = actions.find((action) => action.target === file);
    expect(claude?.change).toBe("unchanged");
    expect(claude?.what).toMatch(/not valid JSON/);
  });

  it("appends to an existing Codex config without disturbing it", () => {
    const file = path.join(userHome, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    applyRegistration(options());
    const toml = fs.readFileSync(file, "utf8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain(TOML_BEGIN);
    expect(toml).toContain("[mcp_servers.skeletonkey]");
  });

  it("leaves a hand-written [mcp_servers.skeletonkey] entry exactly as it is", () => {
    const file = path.join(userHome, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mine = '[mcp_servers.skeletonkey]\ncommand = "node"\nargs = ["/my/path/cli.js", "mcp"]\n';
    fs.writeFileSync(file, mine);
    const actions = applyRegistration(options());
    expect(fs.readFileSync(file, "utf8")).toBe(mine);
    const codex = actions.find((action) => action.target === file);
    expect(codex?.change).toBe("unchanged");
    expect(codex?.what).toMatch(/left exactly as it is/);
  });

  it("can register a custom command, for a local build instead of npx", () => {
    applyRegistration({
      ...options(),
      command: "node",
      args: ["/abs/path/dist/cli.js", "mcp"],
    });
    const toml = fs.readFileSync(path.join(userHome, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('command = "node"');
    expect(toml).toContain('args = ["/abs/path/dist/cli.js", "mcp"]');
  });

  it("can be limited to one agent", () => {
    applyRegistration({ ...options(), agents: ["codex"] });
    expect(fs.existsSync(path.join(userHome, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(userHome, ".claude.json"))).toBe(false);
  });

  it("writes no secret anywhere: these files are configuration only", () => {
    applyRegistration(options());
    for (const [, content] of Object.entries(snapshot(userHome))) {
      expect(content).not.toMatch(/BW_SESSION|password\s*[:=]|sk-[A-Za-z0-9]{8}/);
    }
  });

  it("knows where the packaged skill lives", () => {
    // In the repo the packaged path resolves next to src/, which is the same
    // layout the published package has (dist/agents -> skills/).
    expect(packagedSkillPath().endsWith(path.join("skills", "skeletonkey", "SKILL.md"))).toBe(true);
  });
});

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}
