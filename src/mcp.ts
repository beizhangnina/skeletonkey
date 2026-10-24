/**
 * Local stdio MCP server, so an agent (Claude Code, Codex, anything that speaks
 * MCP) can work with SkeletonKey without ever holding a key.
 *
 * The hard rule, enforced by a test that calls every handler below: **no tool
 * response ever contains a secret value.** The tools deal in metadata, ledger
 * rows, and the proxy URL. The only tool that touches a secret at all is
 * `register_key`, and it does so by asking the human on `/dev/tty` -- out of
 * band, never through the agent's context.
 */
import fs from "node:fs";
import { z } from "zod";
import { matchesCapability, resolveApisPath, validateApisFile, type ApiEntry } from "./apis.js";
import { readConfig } from "./config.js";
import {
  domainMatches,
  findKey,
  normalizeDomain,
  readKeys,
  setDisabled,
  upsertKey,
} from "./keys.js";
import { openLedger, type LedgerSummary } from "./ledger.js";
import { keysPath } from "./paths.js";
import { promptHiddenOnTty } from "./prompt.js";
import { createVault } from "./vault/index.js";
import { DEFAULT_PROXY_PORT, type Config, type KeyMeta, type LedgerRow } from "./types.js";

export interface McpContext {
  home: string;
  /** Overridable so tests can point at a fixture. */
  apisFile?: string;
  /**
   * Test seam: when false, `register_key` never tries to open `/dev/tty` and
   * always returns the "ask the human to run `skeletonkey add`" plan.
   */
  allowTtyPrompt?: boolean;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** The MCP result type is open-ended; this keeps us assignable to it. */
  [key: string]: unknown;
}

export interface SkeletonKeyToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly: boolean;
  handler: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
}

// --- shared helpers -------------------------------------------------------

/** Metadata view of a key. Contains no secret: `format` is only the template. */
interface PublicKey {
  alias: string;
  platform: string;
  domain: string;
  header: string;
  /** Template such as `Bearer {key}`. The `{key}` placeholder is never filled in here. */
  header_format: string;
  created: string;
  last_used: string | null;
  disabled: boolean;
}

function publicKey(key: KeyMeta): PublicKey {
  return {
    alias: key.alias,
    platform: key.platform,
    domain: key.domain,
    header: key.header,
    header_format: key.format,
    created: key.created,
    last_used: key.last_used,
    disabled: key.disabled,
  };
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function required(args: Record<string, unknown>, name: string): string {
  const value = str(args, name);
  if (value === undefined) throw new Error(`\`${name}\` is required.`);
  return value;
}

function loadConfig(ctx: McpContext): Config | null {
  try {
    return readConfig(ctx.home);
  } catch {
    return null;
  }
}

function apisEntries(ctx: McpContext): { file: string; entries: ApiEntry[]; errors: string[] } {
  const file = ctx.apisFile ?? resolveApisPath(ctx.home);
  const result = validateApisFile(file);
  return { file, entries: result.document?.entries ?? [], errors: result.errors };
}

/**
 * Where an agent should send its requests. Reverse mode (`/<domain>/<path>`) is
 * the mode that actually works for HTTPS upstreams -- see README.
 */
function proxyInfo(config: Config | null): {
  proxy_url: string;
  usage: string;
  gateway: string | null;
  note: string;
} {
  const bind = config?.proxy?.bind ?? "127.0.0.1";
  const port = config?.proxy?.port ?? DEFAULT_PROXY_PORT;
  const host = bind.toLowerCase() === "tailscale" ? "<this-host>.<tailnet>.ts.net" : bind;
  const proxyUrl = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  const gatewayBind = config?.gateway?.bind;
  const gatewayPort = config?.gateway?.port ?? port;
  return {
    proxy_url: proxyUrl,
    usage: `${proxyUrl}/<api-domain>/<path>`,
    gateway:
      gatewayBind === undefined
        ? null
        : `gateway configured on ${gatewayBind}:${gatewayPort}; other devices must send the X-SkeletonKey-Token header`,
    note:
      "Send the request with NO credential of your own. The proxy injects the key " +
      "by destination domain. Start it with `skeletonkey proxy` if it is not running.",
  };
}

function matchKeyForTarget(
  keys: KeyMeta[],
  target: { platform?: string | undefined; domain?: string | undefined; alias?: string | undefined },
): KeyMeta | undefined {
  const platform = target.platform?.toLowerCase();
  const domain = target.domain === undefined ? undefined : normalizeDomain(target.domain);
  return keys.find((key) => {
    if (target.alias !== undefined && key.alias === target.alias) return true;
    if (domain !== undefined && domainMatches(key.domain, domain)) return true;
    if (platform !== undefined) {
      if (key.platform.toLowerCase() === platform) return true;
      if (key.alias.toLowerCase() === platform) return true;
      if (key.platform.toLowerCase().includes(platform)) return true;
    }
    return false;
  });
}

/** A step in an assisted-signup plan, tagged with who does it in v0.1. */
interface PlanStep {
  step: number;
  action: string;
  /** `agent` = the agent's own tools do it; `human` = a person must act. */
  actor: "agent" | "human";
  /** True when v0.1 of SkeletonKey itself automates this step. */
  skeletonkey_automates: boolean;
}

function signupPlan(options: {
  platform: string;
  entry: ApiEntry | null;
  email: string | null;
  reason: string | undefined;
  estBudget: number | null;
}): { steps: PlanStep[]; final_step: string; cautions: string[] } {
  const { platform, entry, email, estBudget } = options;
  const signupUrl = entry?.url ?? `(unknown -- search for the ${platform} API docs)`;
  const aliasEmail =
    email === null
      ? "(run `skeletonkey init` first so a dedicated email is on file)"
      : email.replace("@", `+${platform.toLowerCase().replace(/[^a-z0-9]+/g, "")}@`);

  const steps: PlanStep[] = [
    {
      step: 1,
      action: `Check apis.yaml for ${platform} with find_api, and SkeletonKey itself with list_keys.`,
      actor: "agent",
      skeletonkey_automates: true,
    },
    {
      step: 2,
      action: `Open ${signupUrl} with your own computer-use or browser tool and start signup.`,
      actor: "agent",
      skeletonkey_automates: false,
    },
    {
      step: 3,
      action: `Sign up as ${aliasEmail} (a +alias on the dedicated SkeletonKey email).`,
      actor: "agent",
      skeletonkey_automates: false,
    },
    {
      step: 4,
      action:
        "Read the verification code from your own email connector and complete email verification.",
      actor: "agent",
      skeletonkey_automates: false,
    },
    {
      step: 5,
      action: "Create an API key in the provider dashboard. Do NOT copy it into chat or a file.",
      actor: "agent",
      skeletonkey_automates: false,
    },
    {
      step: 6,
      action:
        estBudget === null
          ? "If payment is required, STOP and hand over: the human enters their own card."
          : `If payment is required (agent estimate: $${estBudget}), STOP and hand over: the human enters their own card.`,
      actor: "human",
      skeletonkey_automates: false,
    },
    {
      step: 7,
      action:
        "Call register_key(alias, platform, domain); the human types the key straight into the " +
        "vault on the terminal, or runs `skeletonkey add` themselves. You never see it.",
      actor: "human",
      skeletonkey_automates: true,
    },
    {
      step: 8,
      action: "Call request_access again to get the proxy URL, then call the API through the proxy.",
      actor: "agent",
      skeletonkey_automates: true,
    },
  ];

  const cautions: string[] = [
    "Never paste a key into chat, a file, a commit, or an environment variable.",
    "The human performs the final Terms-of-Service confirmation and any payment. Always.",
  ];
  if (entry === null) {
    cautions.push(
      `${platform} is not in apis.yaml, so its terms, prices, and whether signup may be ` +
        "automated are all unknown. Treat every cost as unknown rather than guessing one.",
    );
  } else {
    if (entry.min_topup === null) {
      cautions.push(
        `apis.yaml records no minimum top-up for ${entry.name} (min_topup: null = unknown, ` +
          "not free).",
      );
    }
    if (entry.signup_automatable !== true) {
      cautions.push(
        `apis.yaml does not confirm that ${entry.name} signup may be automated ` +
          `(signup_automatable: ${String(entry.signup_automatable)}). Check the terms before ` +
          "driving the browser.",
      );
    }
    if (entry.tos_notes !== null) cautions.push(`Terms note: ${entry.tos_notes}`);
  }

  return {
    steps,
    final_step: "human confirms: Terms of Service acceptance and any payment, on their own screen",
    cautions,
  };
}

function ledgerView(rows: LedgerRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    id: row.id,
    alias: row.alias,
    domain: row.domain,
    timestamp: row.timestamp,
    status: row.status,
    bytes: row.bytes,
    cost_usd: row.cost,
  }));
}

function withLedger<T>(home: string, fn: (ledger: ReturnType<typeof openLedger>) => T): T {
  const ledger = openLedger(home);
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

function spendNote(summary: LedgerSummary): string {
  if (summary.calls === 0) return "No calls recorded yet.";
  if (summary.cost_usd === null) {
    return `No upstream reported a price for any of the ${summary.calls} call(s); spend is unknown, not zero.`;
  }
  return `$${summary.cost_usd} reported across ${summary.calls - summary.calls_without_cost} of ${summary.calls} call(s); the rest reported no price.`;
}

// --- tools ----------------------------------------------------------------

export const SKELETONKEY_TOOLS: SkeletonKeyToolDef[] = [
  {
    name: "find_api",
    title: "Find an API by capability",
    description:
      "Search the local apis.yaml index for APIs that provide a capability " +
      '(e.g. "embeddings", "web scraping", "social data"). Returns how each one is paid ' +
      "for and whether SkeletonKey already holds a key for it. Prices are null when " +
      "unknown -- null never means free.",
    readOnly: true,
    inputSchema: {
      capability: z
        .string()
        .describe('What you need, in plain words: "embeddings", "web scraping", "tweets".'),
    },
    async handler(args, ctx) {
      const capability = required(args, "capability");
      const { file, entries, errors } = apisEntries(ctx);
      const keys = readKeys(ctx.home).keys;
      const matches = entries.filter((entry) => matchesCapability(entry, capability));
      return {
        capability,
        apis_file: file,
        ...(errors.length > 0 ? { apis_file_errors: errors } : {}),
        match_count: matches.length,
        matches: matches.map((entry) => {
          const key = matchKeyForTarget(keys, { platform: entry.name, domain: entry.domain });
          return {
            name: entry.name,
            url: entry.url,
            domain: entry.domain ?? null,
            capabilities: entry.capabilities ?? [],
            access_mode: entry.access_mode,
            min_topup_usd: entry.min_topup,
            billing_unit: entry.billing_unit,
            signup_automatable: entry.signup_automatable,
            tos_notes: entry.tos_notes,
            source: entry.source,
            checked_date: entry.checked_date,
            is_example_row: entry.example === true,
            key_in_skeletonkey: key ? { alias: key.alias, disabled: key.disabled } : null,
          };
        }),
        reminders: [
          "min_topup_usd: null means nobody has checked the price. Do not guess one.",
          "checked_date: null means no human has verified this row.",
          "is_example_row: true means the row is a placeholder shipped with the repo, not a real offer.",
          "Next: request_access(platform, reason, est_budget) to get a proxy URL or a signup plan.",
        ],
      };
    },
  },

  {
    name: "list_keys",
    title: "List keys (metadata only)",
    description:
      "List every key SkeletonKey knows about: alias, platform, destination domain, which " +
      "header gets injected, created/last-used timestamps, and whether it is disabled. " +
      "Secret values are never returned by this server.",
    readOnly: true,
    inputSchema: {},
    async handler(_args, ctx) {
      const keys = readKeys(ctx.home).keys;
      const lastUsed = withLedger(ctx.home, (ledger) => ledger.lastUsedByAlias());
      const config = loadConfig(ctx);
      return {
        count: keys.length,
        metadata_file: keysPath(ctx.home),
        vault_backend: config?.backend ?? null,
        keys: keys.map((key) => ({
          ...publicKey(key),
          last_used: key.last_used ?? lastUsed.get(key.alias) ?? null,
        })),
        note: "Call the API through the proxy; there is no tool that reveals a key.",
      };
    },
  },

  {
    name: "key_status",
    title: "Status of one key",
    description:
      "Metadata, last use, and recorded spend for one alias. Spend comes from the local " +
      "ledger and is null unless the upstream actually reported a price.",
    readOnly: true,
    inputSchema: {
      alias: z.string().describe("The alias as shown by list_keys."),
    },
    async handler(args, ctx) {
      const alias = required(args, "alias");
      const key = findKey(alias, ctx.home);
      if (!key) {
        return {
          alias,
          found: false,
          hint: "Call list_keys for the aliases that exist, or request_access to get a signup plan.",
        };
      }
      const { summary, rows, ledgerLastUsed } = withLedger(ctx.home, (ledger) => ({
        summary: ledger.summary(alias),
        rows: ledger.recent(5, alias),
        ledgerLastUsed: ledger.lastUsedByAlias().get(alias) ?? null,
      }));
      return {
        found: true,
        ...publicKey(key),
        last_used: key.last_used ?? ledgerLastUsed,
        usable: !key.disabled,
        spend: {
          calls: summary.calls,
          bytes: summary.bytes,
          cost_usd: summary.cost_usd,
          calls_without_reported_cost: summary.calls_without_cost,
          first_call: summary.first_call,
          last_call: summary.last_call,
          note: spendNote(summary),
        },
        recent_calls: ledgerView(rows),
      };
    },
  },

  {
    name: "request_access",
    title: "Request access to a platform",
    description:
      "Ask whether a usable key exists for a platform. If it does, you get the proxy URL to " +
      "call through (and no key). If it does not, you get a step-by-step signup plan whose " +
      "final step is a human confirming Terms of Service and payment.",
    readOnly: true,
    inputSchema: {
      platform: z.string().describe('Platform or vendor, e.g. "Voyage AI", "Apify".'),
      reason: z.string().optional().describe("Why you need it; recorded in the response for the human."),
      est_budget: z
        .number()
        .optional()
        .describe("Your own USD estimate for this work. Never treated as a real price."),
    },
    async handler(args, ctx) {
      const platform = required(args, "platform");
      const reason = str(args, "reason");
      const estBudget = typeof args["est_budget"] === "number" ? args["est_budget"] : null;
      const config = loadConfig(ctx);
      const keys = readKeys(ctx.home).keys;
      const { entries } = apisEntries(ctx);
      const entry =
        entries.find((item) => item.name.toLowerCase() === platform.toLowerCase()) ??
        entries.find((item) => matchesCapability(item, platform)) ??
        null;

      const key = matchKeyForTarget(keys, {
        platform,
        domain: entry?.domain,
        alias: platform,
      });

      if (key && !key.disabled) {
        const proxy = proxyInfo(config);
        return {
          platform,
          reason: reason ?? null,
          has_key: true,
          alias: key.alias,
          domain: key.domain,
          injected_header: key.header,
          proxy: proxy,
          call_example: `GET ${proxy.proxy_url}/${key.domain}/<path>`,
          signup_plan: null,
        };
      }

      if (key && key.disabled) {
        return {
          platform,
          reason: reason ?? null,
          has_key: false,
          alias: key.alias,
          disabled: true,
          hint:
            `A key for ${key.alias} exists but is disabled, so the proxy will not inject it. ` +
            "A human can re-enable it with `skeletonkey enable " +
            `${key.alias}\`. Ask them; do not work around it.`,
          signup_plan: null,
        };
      }

      return {
        platform,
        reason: reason ?? null,
        has_key: false,
        est_budget_usd: estBudget,
        apis_yaml_entry: entry
          ? {
              name: entry.name,
              url: entry.url,
              access_mode: entry.access_mode,
              min_topup_usd: entry.min_topup,
              billing_unit: entry.billing_unit,
              signup_automatable: entry.signup_automatable,
              checked_date: entry.checked_date,
              is_example_row: entry.example === true,
            }
          : null,
        signup_plan: signupPlan({
          platform,
          entry,
          email: config?.email ?? null,
          reason,
          estBudget,
        }),
      };
    },
  },

  {
    name: "register_key",
    title: "Register a new key (human types it)",
    description:
      "Record a new key AFTER a human has created it. The human types the secret on their own " +
      "terminal, or runs `skeletonkey add` themselves -- the secret never passes through you and " +
      "is never returned. Call this once signup is done.",
    readOnly: false,
    inputSchema: {
      alias: z.string().describe("Short name for the key, e.g. voyage-personal."),
      platform: z.string().describe('Vendor name, e.g. "Voyage AI".'),
      domain: z.string().describe("API hostname the key is for, e.g. api.voyageai.com."),
      header: z.string().optional().describe("Header to inject. Defaults to Authorization."),
      format: z
        .string()
        .optional()
        .describe("Header value template containing {key}. Defaults to `Bearer {key}`."),
    },
    async handler(args, ctx) {
      const alias = required(args, "alias");
      const platform = required(args, "platform");
      const domainInput = required(args, "domain");
      const header = str(args, "header") ?? "Authorization";
      const format = str(args, "format") ?? "Bearer {key}";
      const domain = normalizeDomain(domainInput);

      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(alias)) {
        throw new Error("Alias must start with a letter or digit and contain only [A-Za-z0-9._-].");
      }
      if (!format.includes("{key}")) {
        throw new Error("`format` must contain the {key} placeholder.");
      }
      if (domain === "") throw new Error("`domain` must be a hostname.");

      const manualCommand = [
        "skeletonkey add",
        alias,
        "--platform",
        JSON.stringify(platform),
        "--domain",
        domain,
        "--header",
        header,
        "--format",
        JSON.stringify(format),
      ].join(" ");

      const config = loadConfig(ctx);
      if (config === null) {
        return {
          alias,
          stored: false,
          action_required: "human",
          instructions:
            "No SkeletonKey home is initialised yet. Ask the human to run `skeletonkey init`, then: " +
            manualCommand,
          command_for_human: manualCommand,
        };
      }

      const existing = findKey(alias, ctx.home);
      const prompt =
        `\n[skeletonkey] An agent asks to register the key "${alias}" (${platform} -> ${domain}).\n` +
        `[skeletonkey] Paste the ${platform} API key (not echoed, goes straight to the vault), ` +
        "or press Ctrl-C to refuse: ";

      const secret =
        ctx.allowTtyPrompt === false ? null : await promptHiddenOnTty(prompt).catch(() => null);

      if (secret === null || secret.trim() === "") {
        return {
          alias,
          platform,
          domain,
          stored: false,
          action_required: "human",
          reason:
            secret === null
              ? "No terminal was available to ask the human (or they declined)."
              : "The human entered nothing.",
          instructions:
            "Ask the human to run this in their own terminal; it prompts for the key without " +
            "echoing it. Do not ask them to tell you the key.",
          command_for_human: manualCommand,
          already_registered: existing !== undefined,
        };
      }

      const vault = createVault(config, ctx.home);
      await vault.check();
      await vault.set(alias, secret.trim());
      const readBack = await vault.get(alias);
      if (readBack !== secret.trim()) {
        return {
          alias,
          stored: false,
          action_required: "human",
          reason: "The vault read-back did not match what was written; nothing was recorded.",
          command_for_human: manualCommand,
        };
      }
      upsertKey(
        {
          alias,
          platform,
          domain,
          header,
          format,
          created: existing?.created ?? new Date().toISOString(),
          last_used: existing?.last_used ?? null,
          disabled: existing?.disabled ?? false,
        },
        ctx.home,
      );
      const proxy = proxyInfo(config);
      return {
        alias,
        platform,
        domain,
        stored: true,
        secret_length_chars: secret.trim().length,
        vault: vault.location,
        injected_header: header,
        proxy,
        note: "The secret is in the vault. It was not returned to you and never will be.",
      };
    },
  },

  {
    name: "ledger",
    title: "Recent proxied calls and spend",
    description:
      "Recent calls through the proxy, for one alias or all of them, plus the recorded spend. " +
      "Cost is null unless the upstream reported a price -- null is unknown, not zero.",
    readOnly: true,
    inputSchema: {
      alias: z.string().optional().describe("Limit to one alias. Omit for everything."),
      limit: z.number().optional().describe("How many rows (default 20, max 200)."),
    },
    async handler(args, ctx) {
      const alias = str(args, "alias") ?? null;
      const rawLimit = typeof args["limit"] === "number" ? args["limit"] : 20;
      const limit = Math.min(200, Math.max(1, Math.trunc(rawLimit)));
      const { rows, summary } = withLedger(ctx.home, (ledger) => ({
        rows: ledger.recent(limit, alias),
        summary: ledger.summary(alias),
      }));
      return {
        alias,
        rows: ledgerView(rows),
        summary: {
          calls: summary.calls,
          bytes: summary.bytes,
          cost_usd: summary.cost_usd,
          calls_without_reported_cost: summary.calls_without_cost,
          first_call: summary.first_call,
          last_call: summary.last_call,
          note: spendNote(summary),
        },
      };
    },
  },

  {
    name: "disable",
    title: "Disable a key",
    description:
      "Stop the proxy from injecting a key. The secret stays in the vault and the metadata " +
      "stays in keys.yaml; only injection stops. Use this the moment a key looks compromised " +
      "or is no longer needed. A human re-enables it with `skeletonkey enable`.",
    readOnly: false,
    inputSchema: {
      alias: z.string().describe("The alias to disable."),
      reason: z.string().optional().describe("Why, for the human reading the transcript."),
    },
    async handler(args, ctx) {
      const alias = required(args, "alias");
      const reason = str(args, "reason") ?? null;
      const key = setDisabled(alias, true, ctx.home);
      return {
        alias: key.alias,
        disabled: true,
        reason,
        platform: key.platform,
        domain: key.domain,
        note:
          "The proxy will no longer inject this header. The secret is untouched in the vault; " +
          `a human can restore it with \`skeletonkey enable ${key.alias}\`.`,
      };
    },
  },
];

/** Tool names, handy for tests that assert full coverage. */
export const SKELETONKEY_TOOL_NAMES = SKELETONKEY_TOOLS.map((tool) => tool.name);

/**
 * Calls a tool the way the MCP transport would, returning MCP-shaped content.
 * Exported so the test suite can exercise every handler in-process without
 * standing up a transport.
 */
export async function callSkeletonKeyTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<McpToolResult> {
  const tool = SKELETONKEY_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `unknown tool ${name}` }) }],
      isError: true,
    };
  }
  try {
    const result = await tool.handler(args, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    };
  }
}

const INSTRUCTIONS = `This server fronts SkeletonKey, a local personal API vault. It returns metadata, never
secret values, and there is no tool that can reveal a key.

Before calling any paid API: find_api(capability) to see what exists, then
request_access(platform, reason, est_budget). If a key is already in the vault you
get a proxy URL -- send your request there with no credential of your own and the
proxy attaches the key. If no key exists you get a signup plan: your own
computer-use/browser tool and your own email connector do the signup, and a human
performs the final Terms-of-Service confirmation and any payment. Then call
register_key so the human can enter the key out of band.

Never ask a human to tell you a key, and never write one to chat, a file, or an
environment variable.`;

export interface McpServerHandle {
  /** Resolves when the transport closes. */
  closed: Promise<void>;
  close(): Promise<void>;
}

/** Starts the stdio MCP server. Nothing but JSON-RPC goes to stdout. */
export async function startMcpServer(ctx: McpContext): Promise<McpServerHandle> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new McpServer(
    { name: "skeletonkey", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  for (const tool of SKELETONKEY_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: tool.name === "find_api",
        },
      },
      async (args: unknown) =>
        callSkeletonKeyTool(tool.name, (args ?? {}) as Record<string, unknown>, ctx),
    );
  }

  const transport = new StdioServerTransport();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  transport.onclose = () => resolveClosed();
  await server.connect(transport);
  // stderr is safe: stdout is the protocol channel.
  process.stderr.write(
    `skeletonkey mcp: serving ${SKELETONKEY_TOOLS.length} tools over stdio (home: ${ctx.home})\n`,
  );
  if (!fs.existsSync(ctx.home)) {
    process.stderr.write(
      "skeletonkey mcp: no SkeletonKey home found yet -- tools will return setup instructions until " +
        "`skeletonkey init` has run.\n",
    );
  }
  return {
    closed,
    close: async () => {
      await server.close();
    },
  };
}
