/**
 * Auto-registration for the two supported agents (D8, §5.1): Claude Code and
 * Codex. No Cursor, no anything else.
 *
 * `skeletonkey init` calls `planRegistration` to show the human exactly what is
 * about to change, then `applyRegistration` once they say yes. Everything is
 * idempotent: a second run reports `unchanged` rather than writing a duplicate
 * server entry or appending the skill twice.
 *
 * `userHome` is a parameter rather than a call to `os.homedir()` so the tests
 * can register into a temp directory; `SKELETONKEY_USER_HOME` does the same for
 * a CLI run, which is how the suite keeps `skeletonkey init` away from the real
 * `~/.claude.json` and `~/.codex/`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Points agent registration at a different home. The tests set it. */
export const USER_HOME_ENV = "SKELETONKEY_USER_HOME";

/** The home agent config is written under: the option, the env var, then yours. */
export function agentUserHome(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== "") return path.resolve(explicit);
  const override = process.env[USER_HOME_ENV];
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return os.homedir();
}

export const AGENTS = ["claude-code", "codex"] as const;
export type AgentId = (typeof AGENTS)[number];

/** Markers around the block this tool owns inside a file it does not own. */
export const BLOCK_BEGIN = "<!-- skeletonkey:begin (managed by `skeletonkey init`) -->";
export const BLOCK_END = "<!-- skeletonkey:end -->";
export const TOML_BEGIN = "# skeletonkey:begin (managed by `skeletonkey init`)";
export const TOML_END = "# skeletonkey:end";

export interface RegistrationAction {
  agent: AgentId;
  /** Absolute path of the file this action writes. */
  target: string;
  /** `create`, `update`, or `unchanged`. */
  change: "create" | "update" | "unchanged";
  what: string;
  /** The file's content after the change, for the diff preview. */
  after: string;
  /** The file's content before, so `init` can show a diff. */
  before: string | null;
}

export interface RegisterOptions {
  /** The user's home directory. Defaults to `SKELETONKEY_USER_HOME`, then yours. */
  userHome?: string;
  /** Command the agent should run. Defaults to the one-line `npx` form. */
  command?: string;
  args?: string[];
  /** Path to the SKILL.md to install. Defaults to the packaged one. */
  skillFile?: string;
  /** Limit to one agent. Default: both. */
  agents?: readonly AgentId[];
}

/** The SKILL.md shipped inside the package. */
export function packagedSkillPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/agents/register.js -> <package>/skills/skeletonkey/SKILL.md
  return path.join(here, "..", "..", "skills", "skeletonkey", "SKILL.md");
}

function resolveSkillFile(options: RegisterOptions): string | null {
  const candidate = options.skillFile ?? packagedSkillPath();
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * The one-line install path (D9): both agents can run SkeletonKey straight from
 * the registry with no global install. The package is scoped, so the `npx`
 * argument is the full `@dormy/skeletonkey`, not the bare binary name.
 */
export const DEFAULT_COMMAND = "npx";
export const PACKAGE_NAME = "@dormy/skeletonkey";
export const DEFAULT_ARGS = ["-y", PACKAGE_NAME, "mcp"];

function serverSpec(options: RegisterOptions): { command: string; args: string[] } {
  return {
    command: options.command ?? DEFAULT_COMMAND,
    args: options.args ?? DEFAULT_ARGS,
  };
}

/** What would change, without touching the disk. */
export function planRegistration(options: RegisterOptions = {}): RegistrationAction[] {
  const home = agentUserHome(options.userHome);
  const agents = options.agents ?? AGENTS;
  const actions: RegistrationAction[] = [];
  if (agents.includes("claude-code")) actions.push(...planClaudeCode(home, options));
  if (agents.includes("codex")) actions.push(...planCodex(home, options));
  return actions;
}

/** Writes the planned actions. Returns the ones that actually changed a file. */
export function applyRegistration(options: RegisterOptions = {}): RegistrationAction[] {
  const actions = planRegistration(options);
  for (const action of actions) {
    if (action.change === "unchanged") continue;
    fs.mkdirSync(path.dirname(action.target), { recursive: true });
    fs.writeFileSync(action.target, action.after, { mode: 0o600 });
  }
  return actions;
}

// --- Claude Code ----------------------------------------------------------

/**
 * Claude Code keeps user-scope MCP servers in `~/.claude.json` (the same file
 * `claude mcp add -s user` writes), and user skills in
 * `~/.claude/skills/<name>/SKILL.md`.
 */
function planClaudeCode(home: string, options: RegisterOptions): RegistrationAction[] {
  const actions: RegistrationAction[] = [];
  const configFile = path.join(home, ".claude.json");
  const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  let config: Record<string, unknown> = {};
  if (before !== null) {
    try {
      const parsed = JSON.parse(before) as unknown;
      if (parsed !== null && typeof parsed === "object") config = parsed as Record<string, unknown>;
    } catch {
      // A malformed ~/.claude.json is the user's file, not ours: leave it alone
      // and say so instead of overwriting their settings.
      return [
        {
          agent: "claude-code",
          target: configFile,
          change: "unchanged",
          what:
            `${configFile} is not valid JSON, so SkeletonKey did not touch it. Fix or move it, then ` +
            "re-run `skeletonkey init`.",
          before,
          after: before,
        },
        ...planClaudeSkill(home, options),
      ];
    }
  }
  const servers =
    config["mcpServers"] !== null && typeof config["mcpServers"] === "object"
      ? ({ ...(config["mcpServers"] as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const spec = { ...serverSpec(options), type: "stdio" as const };
  const existing = servers["skeletonkey"];
  const same = JSON.stringify(existing) === JSON.stringify(spec);
  servers["skeletonkey"] = spec;
  const after = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
  actions.push({
    agent: "claude-code",
    target: configFile,
    change: same ? "unchanged" : before === null ? "create" : "update",
    what: same
      ? "MCP server `skeletonkey` is already registered for Claude Code."
      : `register MCP server \`skeletonkey\` (${spec.command} ${spec.args.join(" ")})`,
    before,
    after: same && before !== null ? before : after,
  });
  actions.push(...planClaudeSkill(home, options));
  return actions;
}

function planClaudeSkill(home: string, options: RegisterOptions): RegistrationAction[] {
  const source = resolveSkillFile(options);
  const target = path.join(home, ".claude", "skills", "skeletonkey", "SKILL.md");
  if (source === null) {
    return [
      {
        agent: "claude-code",
        target,
        change: "unchanged",
        what: "the packaged skills/skeletonkey/SKILL.md was not found, so no skill was installed",
        before: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null,
        after: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "",
      },
    ];
  }
  const after = fs.readFileSync(source, "utf8");
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  return [
    {
      agent: "claude-code",
      target,
      change: before === after ? "unchanged" : before === null ? "create" : "update",
      what:
        before === after
          ? "the skeletonkey skill is already installed for Claude Code"
          : "install the skeletonkey skill file",
      before,
      after,
    },
  ];
}

// --- Codex ----------------------------------------------------------------

/**
 * Codex reads `~/.codex/config.toml`. The entry is appended inside a marked
 * block so a re-run can replace exactly what SkeletonKey wrote and nothing
 * else -- no TOML parser, no risk of reformatting the user's own settings.
 */
function planCodex(home: string, options: RegisterOptions): RegistrationAction[] {
  const actions: RegistrationAction[] = [];
  const configFile = path.join(home, ".codex", "config.toml");
  const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  const spec = serverSpec(options);
  const block = [
    TOML_BEGIN,
    "[mcp_servers.skeletonkey]",
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    TOML_END,
    "",
  ].join("\n");

  let after: string;
  let change: RegistrationAction["change"];
  let what: string;
  if (before === null) {
    after = block;
    change = "create";
    what = `create ${configFile} with [mcp_servers.skeletonkey]`;
  } else if (before.includes(TOML_BEGIN)) {
    after = replaceBlock(before, TOML_BEGIN, TOML_END, block);
    change = after === before ? "unchanged" : "update";
    what =
      after === before
        ? "Codex already has the SkeletonKey MCP server block."
        : "refresh the managed [mcp_servers.skeletonkey] block";
  } else if (/^\s*\[mcp_servers\.skeletonkey\]/m.test(before)) {
    // The user (or `codex mcp add`) wrote their own entry. Theirs wins.
    after = before;
    change = "unchanged";
    what =
      `${configFile} already defines [mcp_servers.skeletonkey] outside SkeletonKey's managed block, ` +
      "so it was left exactly as it is.";
  } else {
    after = `${before.replace(/\s*$/, "")}\n\n${block}`;
    change = "update";
    what = "append [mcp_servers.skeletonkey] to the Codex config";
  }
  actions.push({ agent: "codex", target: configFile, change, what, before, after });

  // Codex reads AGENTS.md; the skill file doubles as one (see SKILL.md).
  const source = resolveSkillFile(options);
  if (source !== null) {
    const skillTarget = path.join(home, ".codex", "skills", "skeletonkey", "SKILL.md");
    const skill = fs.readFileSync(source, "utf8");
    const skillBefore = fs.existsSync(skillTarget)
      ? fs.readFileSync(skillTarget, "utf8")
      : null;
    actions.push({
      agent: "codex",
      target: skillTarget,
      change: skillBefore === skill ? "unchanged" : skillBefore === null ? "create" : "update",
      what:
        skillBefore === skill
          ? "the skeletonkey skill is already installed for Codex"
          : "install the skeletonkey skill file for Codex",
      before: skillBefore,
      after: skill,
    });

    const agentsFile = path.join(home, ".codex", "AGENTS.md");
    const pointer = [
      BLOCK_BEGIN,
      "## SkeletonKey",
      "",
      "Before calling any API that needs a key, ask SkeletonKey first (MCP server",
      "`skeletonkey`): `find_api`, then `request_access`. You never see a key — you call",
      "APIs through the local proxy, and a human approves spend outside this context.",
      "",
      `Full rules: ${skillTarget}`,
      BLOCK_END,
      "",
    ].join("\n");
    const agentsBefore = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : null;
    let agentsAfter: string;
    if (agentsBefore === null) agentsAfter = pointer;
    else if (agentsBefore.includes(BLOCK_BEGIN))
      agentsAfter = replaceBlock(agentsBefore, BLOCK_BEGIN, BLOCK_END, pointer);
    else agentsAfter = `${agentsBefore.replace(/\s*$/, "")}\n\n${pointer}`;
    actions.push({
      agent: "codex",
      target: agentsFile,
      change:
        agentsAfter === agentsBefore
          ? "unchanged"
          : agentsBefore === null
            ? "create"
            : "update",
      what:
        agentsAfter === agentsBefore
          ? "the Codex AGENTS.md already points at the SkeletonKey rules"
          : "point ~/.codex/AGENTS.md at the SkeletonKey rules",
      before: agentsBefore,
      after: agentsAfter,
    });
  }
  return actions;
}

function replaceBlock(text: string, begin: string, end: string, replacement: string): string {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end, start);
  if (start < 0 || stop < 0) return `${text.replace(/\s*$/, "")}\n\n${replacement}`;
  return text.slice(0, start) + replacement.replace(/\n$/, "") + text.slice(stop + end.length);
}

/** A unified-ish diff of one action, for `init` to print before it writes. */
export function renderDiff(action: RegistrationAction): string {
  if (action.change === "unchanged") return `  (unchanged) ${action.target}: ${action.what}`;
  const beforeLines = (action.before ?? "").split("\n");
  const afterLines = action.after.split("\n");
  const removed = beforeLines.filter((line) => !afterLines.includes(line));
  const added = afterLines.filter((line) => !beforeLines.includes(line));
  const lines = [`  ${action.change === "create" ? "+ create" : "~ update"} ${action.target}`];
  for (const line of removed.slice(0, 20)) lines.push(`    - ${line}`);
  for (const line of added.slice(0, 20)) lines.push(`    + ${line}`);
  if (added.length > 20 || removed.length > 20) lines.push("    ... (truncated)");
  return lines.join("\n");
}
