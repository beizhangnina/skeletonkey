/**
 * Local stdio MCP server, so an agent (Claude Code, Codex, anything that speaks
 * MCP) can work with SkeletonKey without ever holding a key.
 *
 * The hard rule, enforced by a test that calls every handler below: **no tool
 * response ever contains a secret value.** The tools deal in metadata, ledger
 * rows, opaque request ids, and the proxy URL. The only tool that touches a
 * secret at all is `register_key`, and it does so by asking the human on
 * `/dev/tty` -- out of band, never through the agent's context.
 *
 * v0.3 moves everything that needs a secret or a decision behind the trusted
 * runner (`src/runner/server.ts`): this process asks it for an approval and
 * polls a status. The runner's API has no verb that returns a secret value, so
 * there is nothing here for a prompt injection to ask for.
 */
import fs from "node:fs";
import { z } from "zod";
import {
  ACCESS_MODES,
  AGGREGATOR_NAMES,
  BILLING_MODELS,
  CONNECT_AUTH_KINDS,
  HIGHLIGHTS_MAX,
  OFFERING_SUMMARY_MAX,
  SERVICE_CATEGORIES,
  loadApiIndex,
  queryTokens,
  rankByCapability,
  type ApiEntry,
  type ApiIndex,
  type IndexEntry,
} from "./apis.js";
import { entryFreshness, staleAfterDays, type Freshness } from "./stale.js";
import {
  DISCOVERY_RULES,
  DISCOVERY_SOURCES,
  promoteFromLedger,
  proposeEntry,
  readUserIndex,
  userIndexPath,
} from "./discover.js";
import { routeAccess, routeSummary, type RoutingDecision } from "./routing.js";
import { readConfig } from "./config.js";
import { killSwitchState } from "./killswitch.js";
import { globalRedactor } from "./redact.js";
import { policyView, readPolicy } from "./policy.js";
import { RunnerClient, RunnerUnavailableError } from "./runner/client.js";
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
import { upstreamSchemeFor } from "./proxy.js";
import {
  DEFAULT_PROXY_PORT,
  UPSTREAM_SCHEMES,
  type Config,
  type KeyMeta,
  type LedgerRow,
  type UpstreamScheme,
} from "./types.js";

export interface McpContext {
  home: string;
  /** Overridable so tests can point at a fixture. */
  apisFile?: string;
  /**
   * Directories of generated provider shards merged into the index. Overridable
   * so a test can run against a fixture, or against no shards at all (`[]`).
   */
  apiShardDirs?: string[];
  /**
   * Where `propose_entry` writes and `find_api` reads discovered rows. `null`
   * ignores the user index entirely; undefined uses SKELETONKEY_HOME.
   */
  userIndexFile?: string | null;
  /**
   * Test seam: when false, `register_key` never tries to open `/dev/tty` and
   * always returns the "ask the human to run `skeletonkey add`" plan.
   */
  allowTtyPrompt?: boolean;
  /**
   * How old a verified fact may be before the tools warn, in days. Defaults to
   * `SKELETONKEY_STALE_DAYS`, then to 90.
   */
  staleAfterDays?: number;
  /** Test seam: the date freshness is judged against. Defaults to today. */
  today?: string;
  /**
   * How the tools reach the trusted runner. Undefined reads `runner.json` from
   * the home directory; `null` means "there is no runner", which the tools
   * report honestly rather than papering over.
   */
  runner?: RunnerClient | null;
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
  /** Scheme the proxy uses for this key's domain, and where that came from. */
  upstream_scheme: UpstreamScheme;
  upstream_scheme_source: "key" | "loopback-default" | "default";
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
    upstream_scheme: upstreamSchemeFor(key.domain, key),
    upstream_scheme_source:
      key.scheme !== undefined
        ? "key"
        : upstreamSchemeFor(key.domain, key) === "http"
          ? "loopback-default"
          : "default",
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

/**
 * The index the tools search: `apis.yaml` merged with the generated
 * `data/apis/*.yaml` shards, so the 160-odd indexed providers are reachable and
 * not just the handful of rows in apis.yaml.
 */
function apiIndex(ctx: McpContext): ApiIndex {
  return loadApiIndex({
    ...(ctx.apisFile === undefined ? {} : { apisFile: ctx.apisFile }),
    ...(ctx.apiShardDirs === undefined ? {} : { shardDirs: ctx.apiShardDirs }),
    ...(ctx.userIndexFile === undefined ? {} : { userIndexFile: ctx.userIndexFile }),
    home: ctx.home,
  });
}

/** The local user index `propose_entry` writes to, honouring the test seam. */
function userIndexFileFor(ctx: McpContext): string | null {
  if (ctx.userIndexFile === null) return null;
  return ctx.userIndexFile ?? userIndexPath(ctx.home);
}

/**
 * Promotes any discovered row whose domain has a 2xx in the ledger. Called
 * before the read-only tools answer, so `unverified` turns into `verified` the
 * moment the first real call works -- never on an agent's say-so.
 */
function promote(ctx: McpContext): ReturnType<typeof promoteFromLedger> | null {
  const file = userIndexFileFor(ctx);
  if (file === null) return null;
  try {
    return promoteFromLedger({ file, home: ctx.home });
  } catch {
    return null;
  }
}

/** The staleness window this server judges rows against. */
function staleWindow(ctx: McpContext, args?: Record<string, unknown>): number {
  const asked = args === undefined ? undefined : args["max_age_days"];
  if (typeof asked === "number" && Number.isFinite(asked) && asked >= 0) return Math.trunc(asked);
  return staleAfterDays(ctx.staleAfterDays);
}

/** Age judgement for one row, in the shape the tools report it. */
function freshness(entry: ApiEntry | null, ctx: McpContext, maxAgeDays: number): Freshness | null {
  if (entry === null) return null;
  return entryFreshness(entry, {
    maxAgeDays,
    ...(ctx.today === undefined ? {} : { today: ctx.today }),
  });
}

/**
 * The warning `request_access` prints when the row it is answering from is out
 * of date. Spliced in only when there is something to say.
 */
function staleNote(
  entry: ApiEntry | null,
  ctx: McpContext,
  maxAgeDays: number,
): { staleness_warning?: string[] } {
  const judged = freshness(entry, ctx, maxAgeDays);
  if (judged === null || !judged.stale) return {};
  return { staleness_warning: judged.warnings };
}

/** The billing block as a tool reports it: every unknown an explicit null. */
function billingFacts(entry: ApiEntry | null): Record<string, unknown> {
  const billing = entry?.billing ?? null;
  return {
    model: billing?.model ?? null,
    free_tier_note: billing?.free_tier_note ?? null,
    free_tier_covers_api: billing?.free_tier_covers_api ?? null,
    verified_url: billing?.verified_url ?? null,
    verified_date: billing?.verified_date ?? null,
    note:
      billing === null || billing.model === null
        ? "No billing model recorded: null means nobody checked, NOT free. Verify the vendor's own " +
          "pricing page before spending, or call discover_api for the recipe."
        : billing.verified_url === null
          ? "billing.model is recorded but verified_url is null, so the model was never read off a " +
            "vendor page. Treat it as unverified."
          : null,
  };
}

/**
 * The router's decision, flattened for a tool response. `{route, reason}` is
 * the contract; everything else is the evidence behind it.
 */
function routingView(decision: RoutingDecision): Record<string, unknown> {
  const summary = routeSummary(decision);
  return {
    route: summary.route,
    reason: decision.reason,
    via: decision.via,
    per_call_price_usd: decision.per_call_price_usd,
    price_verified_url: decision.price_verified_url,
    price_unverified: decision.price_unverified,
    billing_model: decision.billing_model,
    billing_verified_url: decision.billing_verified_url,
    billing_verified_date: decision.billing_verified_date,
    alternatives: decision.alternatives.map((option) => ({
      route: option.route === "aggregator" ? `aggregator:${option.via}` : option.route,
      via: option.via,
      per_call_price_usd: option.per_call_price_usd,
      price_verified_url: option.price_verified_url,
      reason: option.reason,
    })),
    notes: decision.notes,
  };
}

/** Aggregator carriage as a tool reports it. */
function carriageView(entry: ApiEntry | null): Record<string, unknown>[] {
  return (entry?.aggregators ?? []).map((item) => ({
    name: item.name,
    carries: item.carries,
    per_call_price_usd: item.per_call_price ?? null,
    price_verified_url: item.price_verified_url ?? null,
    price_note: item.price_note ?? null,
  }));
}

/** The auth facts for one row, with every unknown reported as null. */
function authFacts(entry: ApiEntry | null): Record<string, unknown> {
  return {
    auth_header: entry?.auth_header ?? null,
    auth_format: entry?.auth_format ?? null,
    base_url: entry?.base_url ?? null,
    signup_url: entry?.signup_url ?? null,
    key_page_url: entry?.key_page_url ?? null,
    email_only_signup: entry?.email_only_signup ?? null,
    requires_card: entry?.requires_card ?? null,
    requires_phone: entry?.requires_phone ?? null,
    requires_work_email: entry?.requires_work_email ?? null,
    auth_required: entry?.auth_required ?? null,
    auth_headers: entry?.auth_headers ?? null,
    human_steps: entry?.human_steps ?? [],
    note:
      entry?.auth_required === false
        ? "The vendor documents NO credential for this API (auth_required: false), so there is " +
          "nothing to register. If it answers 401, the row is wrong -- say so rather than inventing " +
          "a header."
        : entry?.auth_header === null || entry?.auth_header === undefined
          ? "No auth header recorded: null means nobody checked, not `Authorization: Bearer`. " +
            "Read the vendor's own auth docs before registering a key."
          : null,
  };
}

/**
 * The offering block as a tool reports it: Layer 1 flattened, Layer 2 passed
 * through as the sample it is. The `note` is there so an agent does not read a
 * short highlight list as the vendor's whole catalog.
 */
function offeringView(entry: ApiEntry | null): Record<string, unknown> | null {
  const offering = entry?.offering ?? null;
  if (offering === null) return null;
  const highlights = offering.highlights ?? [];
  return {
    summary: offering.summary,
    categories: offering.categories ?? [],
    endpoint_count: offering.endpoint_count,
    model_count: offering.model_count,
    count_note: offering.count_note,
    free_tier: offering.free_tier ?? {
      available: null,
      what: null,
      limits: null,
      requires_key: null,
      requires_account: null,
    },
    connect: offering.connect ?? { base_url: null, auth: null, auth_header: null, auth_format: null },
    catalog_url: offering.catalog_url,
    verified_url: offering.verified_url,
    verified_date: offering.verified_date,
    source_urls: offering.source_urls ?? [],
    highlights,
    note:
      highlights.length === 0
        ? "No highlights recorded. Fetch catalog_url for what this vendor actually offers."
        : `${highlights.length} highlighted ${highlights.length === 1 ? "entry" : "entries"}: a ` +
          "SAMPLE, not the catalog. Fetch catalog_url for the current full list.",
  };
}

/** The index row whose domain or base URL covers a hostname, if any. */
function entryForDomain(entries: IndexEntry[], domain: string): IndexEntry | undefined {
  const target = normalizeDomain(domain);
  if (target === "") return undefined;
  return entries.find((entry) => {
    for (const candidate of [entry.domain, entry.base_url]) {
      if (candidate === undefined || candidate === null) continue;
      const host = normalizeDomain(candidate);
      if (host === "") continue;
      if (domainMatches(host, target) || domainMatches(target, host)) return true;
    }
    return false;
  });
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
  /** Which of the agent's OWN capabilities the step needs, when it needs one. */
  capability?: "browser" | "inbox";
}

/** One thing a person has to do themselves, and why. */
interface HumanGate {
  gate: string;
  why: string;
  /** Where the requirement comes from, so the agent can tell fact from default. */
  source: "apis.yaml" | "skeletonkey-policy" | "unknown";
}

/**
 * The explicit list of human-only steps for a platform. Three gates are
 * SkeletonKey policy and always present; the rest come from the index row's
 * `requires_*` flags and `human_steps`. A flag that is `null` is reported as an
 * unknown gate rather than silently dropped -- "nobody checked" is not "no".
 */
function humanGates(platform: string, entry: ApiEntry | null): HumanGate[] {
  const name = entry?.name ?? platform;
  const gates: HumanGate[] = [];

  if (entry?.requires_card === true) {
    gates.push({
      gate: "Enter a payment card",
      why: `apis.yaml records requires_card: true for ${name}. The card is the user's, entered by the user.`,
      source: "apis.yaml",
    });
  } else {
    gates.push({
      gate: "Any payment, card entry, or top-up",
      why:
        entry?.requires_card === false
          ? `apis.yaml records requires_card: false for ${name}, but if any payment is asked for, the human pays it.`
          : `apis.yaml does not record whether ${name} needs a card (requires_card: ${String(entry?.requires_card ?? null)} = unknown). If one is asked for, hand over.`,
      source: entry?.requires_card === false ? "apis.yaml" : "unknown",
    });
  }

  gates.push({
    gate: "The final Terms-of-Service confirmation",
    why: "SkeletonKey policy: the last button that creates the account or commits spend is pressed by a human.",
    source: "skeletonkey-policy",
  });

  gates.push({
    gate: "Typing the key into the vault",
    why: "SkeletonKey policy: register_key prompts on /dev/tty, or the human runs `skeletonkey add`. The key never enters the agent's context.",
    source: "skeletonkey-policy",
  });

  if (entry?.requires_work_email === true) {
    gates.push({
      gate: "Choosing the signup address (a work email is required)",
      why: `apis.yaml records requires_work_email: true for ${name}, so a +alias on a generic mailbox may be refused. Which real address to use is the human's call.`,
      source: "apis.yaml",
    });
  }

  if (entry?.requires_phone === true) {
    gates.push({
      gate: "Phone / SMS verification",
      why: `apis.yaml records requires_phone: true for ${name}. The user's phone number is theirs to give.`,
      source: "apis.yaml",
    });
  } else if (entry?.requires_phone !== false) {
    gates.push({
      gate: "Phone verification, if the vendor asks for one",
      why: `apis.yaml does not record whether ${name} asks for a phone number (requires_phone: null = unknown). If a number is asked for, hand over.`,
      source: "unknown",
    });
  }

  gates.push({
    gate: "Captcha or any device/identity check",
    why: "Not recorded in the index for any vendor. If one appears, stop and hand over rather than attempting it.",
    source: "unknown",
  });

  for (const step of entry?.human_steps ?? []) {
    gates.push({ gate: step, why: `Recorded in apis.yaml human_steps for ${name}.`, source: "apis.yaml" });
  }

  return gates;
}

function signupPlan(options: {
  platform: string;
  entry: ApiEntry | null;
  email: string | null;
  reason: string | undefined;
  estBudget: number | null;
}): {
  steps: PlanStep[];
  human_gates: HumanGate[];
  email_verification: Record<string, unknown>;
  final_step: string;
  cautions: string[];
} {
  const { platform, entry, email, estBudget } = options;
  // signup_url is where signup actually starts; `url` is often just the docs root.
  const signupUrl =
    entry?.signup_url ?? entry?.url ?? `(unknown -- search for the ${platform} API docs)`;
  const workEmailRequired = entry?.requires_work_email === true;
  const aliasEmail =
    email === null
      ? "(run `skeletonkey init` first so a dedicated email is on file)"
      : email.replace("@", `+${platform.toLowerCase().replace(/[^a-z0-9]+/g, "")}@`);
  const addressToUse = email === null ? aliasEmail : workEmailRequired ? email : aliasEmail;
  const keyPage = entry?.key_page_url ?? null;

  const steps: PlanStep[] = [
    {
      step: 1,
      action: `Check the API index for ${platform} with find_api, and SkeletonKey itself with list_keys.`,
      actor: "agent",
      skeletonkey_automates: true,
    },
    {
      step: 2,
      action: `Open ${signupUrl} with your own computer-use or browser tool and start signup.`,
      actor: "agent",
      skeletonkey_automates: false,
      capability: "browser",
    },
    {
      step: 3,
      action: workEmailRequired
        ? `Sign up as ${addressToUse}. Do NOT add a +alias: apis.yaml records that ${entry?.name ?? platform} ` +
          "requires a work email address, and an aliased generic mailbox may be refused. If that address " +
          "is not a work address, stop and ask the human which address to use."
        : `Sign up as ${addressToUse} (a +alias on the dedicated SkeletonKey email).`,
      actor: workEmailRequired ? "human" : "agent",
      skeletonkey_automates: false,
      capability: "browser",
    },
    {
      step: 4,
      action:
        `Complete email verification: open the mailbox for ${email ?? "the dedicated SkeletonKey email"} ` +
        "with your OWN inbox/email connector, read the verification code or confirmation link out of the " +
        "vendor's message, and enter or follow it. Do not ask the human to read the code to you if you " +
        "have inbox access, and do not paste the message into a file.",
      actor: "agent",
      skeletonkey_automates: false,
      capability: "inbox",
    },
    {
      step: 5,
      action:
        (keyPage === null
          ? "Create an API key in the provider dashboard"
          : `Create an API key at ${keyPage}`) +
        ". Leave it on screen. Do NOT copy it into chat, a file, or your own notes.",
      actor: "agent",
      skeletonkey_automates: false,
      capability: "browser",
    },
    {
      step: 6,
      action:
        (entry?.requires_card === true
          ? `apis.yaml records that ${entry.name} requires a saved payment card, so STOP and hand over before that screen: `
          : "If payment is required, STOP and hand over: ") +
        (estBudget === null
          ? "the human enters their own card."
          : `the human enters their own card (agent estimate: $${estBudget}).`),
      actor: "human",
      skeletonkey_automates: false,
    },
    {
      step: 7,
      action:
        "Call register_key(alias, platform, domain); the human types the key straight into the " +
        "vault on the terminal, or runs `skeletonkey add` themselves. You never see it. " +
        "request_access returns ready-made register_key arguments, including the header this " +
        "vendor actually wants.",
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
      `${platform} is not in the API index, so its terms, prices, auth header, and whether signup may ` +
        "be automated are all unknown. Treat every cost as unknown rather than guessing one.",
    );
  } else {
    if (entry.min_topup === null) {
      cautions.push(
        `The index records no minimum top-up for ${entry.name} (min_topup: null = unknown, ` +
          "not free).",
      );
    }
    if (entry.signup_automatable !== true) {
      cautions.push(
        `The index does not confirm that ${entry.name} signup may be automated ` +
          `(signup_automatable: ${String(entry.signup_automatable)}). Check the terms before ` +
          "driving the browser.",
      );
    }
    if (entry.auth_header === null || entry.auth_header === undefined) {
      cautions.push(
        `The index records no auth header for ${entry.name}, so register_key would fall back to ` +
          "`Authorization: Bearer {key}`. Read the vendor's own auth docs first: a wrong header " +
          "fails as a vendor 401 that looks exactly like a bad key.",
      );
    }
    if (workEmailRequired) {
      cautions.push(
        `${entry.name} requires a work email address, so the usual +alias trick may be refused. ` +
          "Ask the human which address to use instead of inventing one.",
      );
    }
    if (entry.tos_notes !== null) cautions.push(`Terms note: ${entry.tos_notes}`);
  }

  return {
    steps,
    human_gates: humanGates(platform, entry),
    email_verification: {
      mailbox: email,
      address_to_use: addressToUse,
      alias_allowed: !workEmailRequired,
      how:
        "Use your own inbox/email connector on the mailbox above: find the vendor's verification " +
        "message, take the code or confirmation link from it, and complete verification in the browser.",
      note: workEmailRequired
        ? "A +alias is NOT used here: this vendor requires a work email address."
        : null,
    },
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

// --- the trusted runner ---------------------------------------------------

/**
 * How the tools reach the runner. `ctx.runner === null` is an explicit "no
 * runner"; undefined reads `runner.json`, which only exists while one is up.
 */
function runnerFor(ctx: McpContext): RunnerClient | null {
  if (ctx.runner !== undefined) return ctx.runner;
  return RunnerClient.fromHome(ctx.home);
}

/** The same honest answer everywhere the runner is not running. */
function runnerMissing(what: string): Record<string, unknown> {
  return {
    status: "runner_unavailable",
    runner: null,
    what,
    hint:
      "The trusted SkeletonKey runner is not running, and it is the only thing that can hold a " +
      "secret or raise an approval. Ask the human to start it with `skeletonkey runner`. Do not " +
      "attempt the signup yourself and do not ask anyone for a key.",
  };
}

/** Wraps a runner call so a dead runner is a status, not a stack trace. */
async function viaRunner<T>(
  ctx: McpContext,
  what: string,
  call: (client: RunnerClient) => Promise<T>,
): Promise<T | Record<string, unknown>> {
  const client = runnerFor(ctx);
  if (client === null) return runnerMissing(what);
  try {
    return await call(client);
  } catch (error) {
    if (error instanceof RunnerUnavailableError) {
      return { ...runnerMissing(what), detail: error.message };
    }
    throw error;
  }
}

/** The cheapest aggregator to offer if direct signup fails (D14). */
function fallbackAggregator(
  decision: RoutingDecision,
): { name: string; per_call_price_usd: number | null } | null {
  if (decision.route === "aggregator" && decision.via !== null) {
    return { name: decision.via, per_call_price_usd: decision.per_call_price_usd };
  }
  const option = decision.alternatives.find(
    (item) => item.route === "aggregator" && item.via !== null,
  );
  if (option === undefined || option.via === null) return null;
  return { name: option.via, per_call_price_usd: option.per_call_price_usd };
}

/** The caps block every spend-adjacent response carries. */
function policyBlock(ctx: McpContext): Record<string, unknown> {
  return policyView(readPolicy(ctx.home));
}

/** Kill-switch state, reported wherever it would change what an agent should do. */
function killBlock(ctx: McpContext): Record<string, unknown> | null {
  const state = killSwitchState(ctx.home);
  if (!state.engaged) return null;
  return {
    kill_switch: true,
    engaged_at: state.at,
    reason: state.reason,
    note:
      "The SkeletonKey kill switch is engaged: the proxy refuses every call locally and the runner " +
      "accepts no new requests. Only a human clears it (`skeletonkey resume`). Stop and say so.",
  };
}

// --- tools ----------------------------------------------------------------

export const SKELETONKEY_TOOLS: SkeletonKeyToolDef[] = [
  {
    name: "find_api",
    title: "Find an API by capability",
    description:
      "Search the local API index for APIs that provide a capability " +
      '(e.g. "embeddings", "web scraping", "social data"). Searches apis.yaml, the local ' +
      "user index of rows discovered earlier, AND the generated provider shards in " +
      "data/apis/*.yaml, merged. Returns how each one is paid for (verified billing model), " +
      "which aggregators resell it and at what published per-call price, a recommended " +
      "{route, reason}, how it authenticates, and whether SkeletonKey already holds a key. " +
      "Prices are null when unknown -- null never means free. On a miss, call discover_api.",
    readOnly: true,
    inputSchema: {
      capability: z
        .string()
        .describe('What you need, in plain words: "embeddings", "web scraping", "tweets".'),
      limit: z
        .number()
        .optional()
        .describe("How many matches to return (default 25, max 200). match_count is the total."),
      max_age_days: z
        .number()
        .optional()
        .describe(
          "Warn about rows whose facts were verified longer ago than this (default 90, or " +
            "SKELETONKEY_STALE_DAYS).",
        ),
    },
    async handler(args, ctx) {
      const capability = required(args, "capability");
      const rawLimit = typeof args["limit"] === "number" ? args["limit"] : 25;
      const limit = Math.min(200, Math.max(1, Math.trunc(rawLimit)));
      const maxAgeDays = staleWindow(ctx, args);
      // Flip any discovered row that a real 2xx call has since proven.
      const promotion = promote(ctx);
      const index = apiIndex(ctx);
      const keys = readKeys(ctx.home).keys;
      // Whole-word matching, scored: strongest evidence first, and ties keep
      // index order, which puts apis.yaml rows (the ones that know the auth
      // header) ahead of generated shard rows.
      const ranked = rankByCapability(index.entries, capability);
      const terms = queryTokens(capability);
      const matches = ranked.map((row) => row.entry);
      const shown = ranked.slice(0, limit);
      const staleShown = shown.filter(
        (row) => freshness(row.entry, ctx, maxAgeDays)?.stale === true,
      ).length;
      return {
        capability,
        search_terms: terms.tokens,
        ignored_terms: terms.ignored,
        ...(terms.tokens.length === 0
          ? {
              no_search_terms:
                "Every word in that query is a generic word (api, data, search, lookup, ...), so " +
                "there was nothing specific to match on. Name the capability or the vendor: " +
                '"embeddings", "web scraping", "company enrichment".',
            }
          : {}),
        apis_file: index.files[0] ?? null,
        index_files: index.files.length,
        index_counts: index.counts,
        ...(index.errors.length > 0 ? { apis_file_errors: index.errors } : {}),
        match_count: matches.length,
        returned: shown.length,
        stale_after_days: maxAgeDays,
        stale_matches_returned: staleShown,
        ...(promotion !== null && promotion.promoted.length > 0
          ? { promoted_since_last_call: promotion.promoted }
          : {}),
        ...(matches.length > shown.length
          ? { truncated: `showing ${shown.length} of ${matches.length}; raise \`limit\` to see more` }
          : {}),
        matches: shown.map(({ entry, score }) => {
          const key = matchKeyForTarget(keys, {
            platform: entry.name,
            ...(entry.domain === undefined ? {} : { domain: entry.domain }),
          });
          const decision = routeAccess(entry, { hasKey: key !== undefined && !key.disabled });
          return {
            name: entry.name,
            match_score: score.score,
            matched_terms: score.matched,
            url: entry.url,
            domain: entry.domain ?? null,
            capabilities: entry.capabilities ?? [],
            access_mode: entry.access_mode,
            min_topup_usd: entry.min_topup,
            billing_unit: entry.billing_unit,
            signup_automatable: entry.signup_automatable,
            billing: billingFacts(entry),
            offering: offeringView(entry),
            aggregators: carriageView(entry),
            ...(entry.aggregators_source === undefined
              ? {}
              : { aggregators_source: entry.aggregators_source }),
            route: routeSummary(decision),
            auth: authFacts(entry),
            status: entry.status ?? null,
            source_urls: entry.source_urls ?? null,
            tos_notes: entry.tos_notes,
            source: entry.source,
            checked_date: entry.checked_date,
            freshness: freshness(entry, ctx, maxAgeDays),
            is_example_row: entry.example === true,
            index_origin: entry.origin,
            ...(entry.category === undefined ? {} : { index_category: entry.category }),
            ...(entry.vendor_url === undefined ? {} : { vendor_url: entry.vendor_url }),
            key_in_skeletonkey: key ? { alias: key.alias, disabled: key.disabled } : null,
          };
        }),
        reminders: [
          "min_topup_usd: null means nobody has checked the price. Do not guess one.",
          "billing.model: null means nobody checked how the vendor charges. It never means free.",
          "aggregators[].per_call_price_usd: null means that aggregator publishes no comparable " +
            "per-call price, not that the call is free. A price always comes with price_verified_url.",
          "route.reason says `price unverified` whenever no verified price backs the route. Say so " +
            "to the human rather than quoting a number you do not have.",
          "status: `unverified` rows were discovered by an agent and proven by nothing yet; they are " +
            "promoted to `verified` only after a 2xx call through the proxy.",
          "offering.highlights is a SAMPLE of a vendor's models/endpoints, capped on purpose. For the " +
            "full list fetch offering.catalog_url live -- the vendor's own catalog is current, a copy " +
            "in this index would not be.",
          "offering.free_tier.available: null means nobody checked. false means the vendor documents " +
            "no free tier. Only `true` plus a `what` is a free tier you can rely on.",
          "If nothing here fits, call discover_api(capability) -- do not invent a vendor or a price.",
          "checked_date: null means no human has verified this row.",
          `freshness.stale: true means this row's facts are older than ${maxAgeDays} days, or ` +
            "carry no verification date at all. Say so to the human, and run " +
            "`skeletonkey stale-check` before quoting anything on it.",
          "is_example_row: true means the row is a placeholder shipped with the repo, not a real offer.",
          "auth.auth_header: null means the header is unknown, NOT that it is Authorization: Bearer.",
          "index_origin: shard rows are generated from aggregator catalogs and carry no auth facts " +
            "and no API domain; verify the vendor's own docs before registering a key.",
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
      "call through (and no key). If it does not, the trusted local runner raises an approval " +
      "with the human OUT OF BAND (OS notification plus a localhost page) and you get back " +
      "{request_id, status: \"pending_approval\"} -- poll access_status(request_id) and do not " +
      "ask the human anything yourself. The response also carries the vendor's verified billing " +
      "model, a recommended {route, reason}, the auth facts, ready-made register_key arguments, " +
      "the human-only gates, and the current spend caps (which you can never raise).",
    readOnly: false,
    inputSchema: {
      platform: z.string().describe('Platform or vendor, e.g. "Voyage AI", "Apify".'),
      reason: z.string().optional().describe("Why you need it; recorded in the response for the human."),
      est_budget: z
        .number()
        .optional()
        .describe("Your own USD estimate for this work. Never treated as a real price."),
      max_age_days: z
        .number()
        .optional()
        .describe(
          "Warn when the row's facts were verified longer ago than this (default 90, or " +
            "SKELETONKEY_STALE_DAYS).",
        ),
    },
    async handler(args, ctx) {
      const platform = required(args, "platform");
      const reason = str(args, "reason");
      const estBudget = typeof args["est_budget"] === "number" ? args["est_budget"] : null;
      const maxAgeDays = staleWindow(ctx, args);
      promote(ctx);
      const suggestedAlias = `${platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "api"}-personal`;
      const config = loadConfig(ctx);
      const keys = readKeys(ctx.home).keys;
      const { entries } = apiIndex(ctx);
      // An exact name wins; otherwise the best-scoring row, not merely the first
      // one in index order that happened to share a word.
      const entry =
        entries.find((item) => item.name.toLowerCase() === platform.toLowerCase()) ??
        rankByCapability(entries, platform)[0]?.entry ??
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
          ...(killBlock(ctx) ?? {}),
          alias: key.alias,
          domain: key.domain,
          injected_header: key.header,
          upstream_scheme: upstreamSchemeFor(key.domain, key),
          billing: billingFacts(entry),
          aggregators: carriageView(entry),
          routing: routingView(routeAccess(entry, { hasKey: true })),
          auth: authFacts(entry),
          freshness: freshness(entry, ctx, maxAgeDays),
          ...staleNote(entry, ctx, maxAgeDays),
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
          billing: billingFacts(entry),
          routing: routingView(routeAccess(entry, { hasKey: false })),
          freshness: freshness(entry, ctx, maxAgeDays),
          ...staleNote(entry, ctx, maxAgeDays),
          proxy_behaviour:
            "While it is disabled the proxy answers calls to that domain itself, with " +
            '403 {"error":"key_disabled"}; nothing is sent upstream and nothing is charged.',
          hint:
            `A key for ${key.alias} exists but is disabled, so the proxy will not inject it. ` +
            "A human can re-enable it with `skeletonkey enable " +
            `${key.alias}\`. Ask them; do not work around it.`,
          signup_plan: null,
        };
      }

      // No key: the human decides whether this happens at all, and they decide
      // it on the runner's own page -- not in this conversation.
      const decision = routeAccess(entry, { hasKey: false });
      const fallback = fallbackAggregator(decision);
      const accessRequest = await viaRunner(ctx, "raise an access approval", (client) =>
        client.createRequest({
          vendor: entry?.name ?? platform,
          domain: entry?.domain ?? null,
          purpose: reason ?? null,
          est_budget_usd: estBudget,
          tos_url: entry?.signup_url ?? entry?.url ?? null,
          requires_payment: entry?.requires_card ?? null,
          fallback_aggregator: fallback?.name ?? null,
          fallback_price_usd: fallback?.per_call_price_usd ?? null,
        }),
      );

      return {
        platform,
        reason: reason ?? null,
        has_key: false,
        est_budget_usd: estBudget,
        ...(killBlock(ctx) ?? {}),
        access_request: accessRequest,
        policy: policyBlock(ctx),
        next_step:
          "Poll access_status(request_id) until it is `ready`, `denied`, `needs_human` or " +
          "`cancelled`. The human approves on the localhost page the runner opened; you never " +
          "collect a secret, a card, or an OTP, and you never raise a cap.",
        apis_yaml_entry: entry
          ? {
              name: entry.name,
              url: entry.url,
              domain: entry.domain ?? null,
              access_mode: entry.access_mode,
              min_topup_usd: entry.min_topup,
              billing_unit: entry.billing_unit,
              signup_automatable: entry.signup_automatable,
              checked_date: entry.checked_date,
              is_example_row: entry.example === true,
              index_origin: entry.origin,
            }
          : null,
        billing: billingFacts(entry),
        offering: offeringView(entry),
        aggregators: carriageView(entry),
        routing: routingView(decision),
        auth: authFacts(entry),
        freshness: freshness(entry, ctx, maxAgeDays),
        ...staleNote(entry, ctx, maxAgeDays),
        register_key_args: {
          alias: suggestedAlias,
          platform: entry?.name ?? platform,
          domain: entry?.domain ?? (entry?.base_url === null || entry?.base_url === undefined ? null : normalizeDomain(entry.base_url)),
          header: entry?.auth_header ?? "Authorization",
          format: entry?.auth_format ?? "Bearer {key}",
          header_source:
            entry?.auth_header === null || entry?.auth_header === undefined
              ? "skeletonkey-default"
              : "api-index",
          note:
            entry?.auth_header === null || entry?.auth_header === undefined
              ? "These are SkeletonKey's defaults, not this vendor's documented header: the index " +
                "records no auth_header. Confirm the header in the vendor's own auth docs first -- a " +
                "wrong header fails as a vendor 401 indistinguishable from a bad key."
              : `Header and format come from the API index row for ${entry?.name}. Pass them to ` +
                "register_key as-is, or let register_key read them from the index itself.",
        },
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
    name: "access_status",
    title: "Poll one access request",
    description:
      "The status of a request_access request, by its opaque request_id. Statuses: " +
      "`pending_approval` (the human has not decided yet -- wait, do not nudge them through this " +
      "channel), `approved`, `ready` (a key exists; call request_access again for the proxy URL), " +
      "`needs_human` (a captcha, a phone check, or no playbook: the human is being walked through " +
      "it), `denied`, `cancelled`, `voided` (the kill switch). When the human approved the " +
      "aggregator fallback, the runner routed the call itself and `routed_via`, " +
      "`routed_cost_usd`, `routed_http_status` and `routed_result` carry what came back. Never " +
      "returns a key, a password, a card, an OTP, a screenshot, or page content.",
    readOnly: true,
    inputSchema: {
      request_id: z.string().describe("The opaque id request_access handed you."),
    },
    async handler(args, ctx) {
      const requestId = required(args, "request_id");
      const status = await viaRunner(ctx, `read the status of ${requestId}`, (client) =>
        client.getRequest(requestId),
      );
      return {
        ...(killBlock(ctx) ?? {}),
        ...status,
        reminders: [
          "A `pending_approval` is a human deciding on their own screen. Poll; do not ask them here.",
          "`needs_human` means a person has to finish a step (captcha, phone, terms). Report it and stop.",
          "`routed_result` is the aggregator's own answer, routed with the aggregator key the " +
            "runner holds. A `needs_human` on an aggregator route can mean no such key is " +
            "configured: the reason names where the human signs up.",
          "There is no tool, and no runner verb, that returns the key itself.",
        ],
      };
    },
  },

  {
    name: "cancel_request",
    title: "Cancel a request you raised",
    description:
      "Withdraw a pending access request: the approval is settled as `cancelled` and any Secure " +
      "Input Popup waiting for the human is closed. Use it the moment you no longer need the " +
      "access you asked for, so the human is not left with a stale approval. You may cancel a " +
      "request and disable a key; you may never approve one, enable a key, or raise a cap.",
    readOnly: false,
    inputSchema: {
      request_id: z.string().describe("The opaque id request_access handed you."),
      reason: z.string().optional().describe("Why, for the human reading the transcript."),
    },
    async handler(args, ctx) {
      const requestId = required(args, "request_id");
      const reason = str(args, "reason") ?? null;
      const cancelled = await viaRunner(ctx, `cancel ${requestId}`, (client) =>
        client.cancelRequest(requestId, reason),
      );
      return {
        ...cancelled,
        cancelled_reason: reason,
        note:
          "Cancelling is yours to do. Approving, re-enabling a key, and raising a cap are the " +
          "human's, on the local approval page.",
      };
    },
  },

  {
    name: "spend_policy",
    title: "Read the spend caps",
    description:
      "The current global monthly cap and per-vendor caps, read from policy.yaml. Both default " +
      "to $0, so the first paid action raises an approval asking the human to set them. This " +
      "tool is read-only by design: there is no tool that can raise a cap or enable a key.",
    readOnly: true,
    inputSchema: {},
    async handler(_args, ctx) {
      return {
        ...(killBlock(ctx) ?? {}),
        ...policyBlock(ctx),
        how_caps_change:
          "A human sets them on the runner's approval page, or runs `skeletonkey policy set`. " +
          "Asking them to raise a cap in this conversation is not how it is done: the approval " +
          "page is the place, and it is theirs.",
      };
    },
  },

  {
    name: "discover_api",
    title: "Research an API the index has never heard of",
    description:
      "Call this when find_api comes back empty, or returns nothing that fits. It does NOT reach " +
      "the network itself: it hands you the research recipe (which sources to read, in which " +
      "order, and which field each one fills), tells you what the local index already nearly " +
      "matched so you do not duplicate a row, and tells you exactly what propose_entry will " +
      "accept. You do the research with your own browser/fetch tools, then call propose_entry. " +
      "Never invent a vendor, a header, or a price: an unsourced field stays null.",
    readOnly: true,
    inputSchema: {
      capability: z
        .string()
        .describe('What you need that the index does not have: "CVE lookup", "IP reputation".'),
      vendor: z
        .string()
        .optional()
        .describe("A specific vendor name, if you already have one in mind."),
    },
    async handler(args, ctx) {
      const capability = required(args, "capability");
      const vendor = str(args, "vendor") ?? null;
      const index = apiIndex(ctx);
      const near = rankByCapability(index.entries, capability)
        .slice(0, 10)
        .map(({ entry, score }) => ({
          name: entry.name,
          domain: entry.domain ?? null,
          index_origin: entry.origin,
          match_score: score.score,
          matched_terms: score.matched,
          auth_header: entry.auth_header ?? null,
          billing_model: entry.billing?.model ?? null,
        }));
      const terms = queryTokens(capability);
      const userFile = userIndexFileFor(ctx);
      const existing = userFile === null ? null : readUserIndex(userFile);

      return {
        capability,
        vendor,
        search_terms: terms.tokens,
        ignored_terms: terms.ignored,
        index_counts: index.counts,
        near_matches: near,
        near_match_note:
          near.length === 0
            ? "Nothing in the local index matches, so this is a genuine miss."
            : "These already exist. If one of them is really the vendor you need, use it instead of " +
              "writing a new row -- a reviewed row knows more than a fresh discovery.",
        research_plan: DISCOVERY_SOURCES.map((source) => ({ ...source })),
        rules: [...DISCOVERY_RULES],
        write_to: {
          tool: "propose_entry",
          user_index_file: userFile,
          user_index_exists: existing?.exists ?? false,
          discovered_rows: existing?.document.entries.length ?? 0,
          required_fields: ["name", "url", "access_mode", "source_urls"],
          recommended_fields: [
            "domain",
            "capabilities",
            "auth_header",
            "auth_format",
            "auth_required",
            "base_url",
            "signup_url",
            "key_page_url",
            "billing",
            "offering",
            "human_steps",
          ],
          billing_shape: {
            model: [...BILLING_MODELS, null],
            free_tier_note: "string or null (required when model names a free tier)",
            verified_url: "the vendor page you read the model off, or null",
            verified_date: "YYYY-MM-DD, required whenever verified_url is set",
            free_tier_covers_api: "true | false | null -- does the free tier include API access?",
          },
          offering_shape: {
            summary: `one line, at most ${OFFERING_SUMMARY_MAX} characters: what the vendor does`,
            categories: [...SERVICE_CATEGORIES],
            endpoint_count: "approximate integer or null -- only a number the vendor states",
            model_count: "approximate integer or null -- only a number the vendor states",
            count_note: "where the counts came from, and that they are approximate",
            free_tier: {
              available: "true | false | null (null = nobody checked)",
              what: "required when available is true: what is free, in the vendor's numbers",
              limits: "rate/volume/time limits as the vendor states them, or null",
              requires_key: "true | false | null",
              requires_account: "true | false | null",
            },
            connect: {
              base_url: "where requests go",
              auth: [...CONNECT_AUTH_KINDS],
              auth_header: "header name, no colon",
              auth_format: "template containing {key}",
            },
            catalog_url: "the VENDOR's own catalog/model-list page, never an aggregator's",
            verified_url: "the vendor page you read this off",
            verified_date: "YYYY-MM-DD, required whenever verified_url is set",
            source_urls: "every page these facts came from",
            highlights:
              `at most ${HIGHLIGHTS_MAX} rows of {id, kind: model|endpoint, free, note, url} -- ` +
              "a SAMPLE of notable or free models/endpoints. Never the full catalog: that is what " +
              "catalog_url is for.",
          },
          aggregator_shape: {
            name: [...AGGREGATOR_NAMES],
            carries: "boolean",
            per_call_price: "number or null -- null means no comparable price is published",
            price_verified_url: "required whenever per_call_price is set",
          },
        },
        promotion:
          "propose_entry writes status: unverified, or `docs-verified` if you pass that and the " +
          "vendor's OWN docs showed you the endpoint and its auth. Either way, call the API through " +
          "the SkeletonKey proxy: the first 2xx recorded in the ledger for that domain promotes the " +
          "row to status: verified on the next find_api/request_access call. Nothing else promotes " +
          "it, and `verified` passed in by hand is downgraded.",
        human_gates: [
          "Any signup, any payment, any Terms-of-Service click stays with the human, exactly as for " +
            "an indexed vendor.",
          "If the vendor's docs are behind a login, a captcha, or a bot wall, say so and leave the " +
            "fields null. Do not work around it.",
        ],
      };
    },
  },

  {
    name: "propose_entry",
    title: "Write a discovered API into the local user index",
    description:
      "Record what you found out about a vendor, so the next find_api hits instead of missing. " +
      "Writes to a LOCAL user index, never to the packaged apis.yaml, always with " +
      "`status: unverified` (or `docs-verified`, if the vendor's own docs showed you the endpoint " +
      "and its auth) -- you cannot mark your own research `verified`. A row is promoted to " +
      "`verified` only after a call to its domain through the proxy returns 2xx. Every row needs " +
      "at least one source URL, and any price needs the URL it was read from. Never pass a key.",
    readOnly: false,
    inputSchema: {
      name: z.string().describe("Short unique slug, e.g. `nvd-cve-api`."),
      url: z.string().describe("http(s) URL of the API or its docs."),
      access_mode: z
        .string()
        .describe(
          `${ACCESS_MODES.join(" | ")} -- how access is actually paid for. \`keyless\` when the ` +
            "vendor documents no credential at all; `wallet-x402` when the only way to pay is a " +
            "crypto wallet (recorded as a fact; SkeletonKey pays in fiat only).",
        ),
      status: z
        .string()
        .optional()
        .describe(
          "`docs-verified` when the VENDOR's own docs showed you the endpoint and how it " +
            "authenticates; otherwise leave it out (it defaults to `unverified`). `verified` is " +
            "earned by a 2xx through the proxy and is downgraded if you pass it.",
        ),
      source_urls: z
        .array(z.string())
        .describe("Every page you read these facts from. At least one is required."),
      domain: z.string().optional().describe("API hostname a key would be registered for."),
      capabilities: z.array(z.string()).optional().describe("Free-text tags find_api matches."),
      auth_header: z.string().optional().describe('Exact header name, e.g. "apiKey". No colon.'),
      auth_format: z.string().optional().describe('Value template containing {key}, e.g. "Bearer {key}".'),
      auth_required: z
        .boolean()
        .optional()
        .describe("false when the vendor documents NO credential. Omit when nobody checked."),
      auth_headers: z
        .array(
          z.object({
            header: z.string(),
            format: z.string(),
            note: z.string().nullable().optional(),
          }),
        )
        .optional()
        .describe(
          "Every credential header, when the vendor documents more than one. Element 0 must match " +
            "auth_header/auth_format -- that is the one the proxy injects.",
        ),
      base_url: z.string().optional().describe("Base URL requests go to."),
      signup_url: z.string().optional().describe("Where signup starts (often not the docs root)."),
      key_page_url: z.string().optional().describe("Where the key is created. Omit if login-gated."),
      billing: z
        .object({
          model: z.string().nullable().optional(),
          free_tier_note: z.string().nullable().optional(),
          verified_url: z.string().nullable().optional(),
          verified_date: z.string().nullable().optional(),
          free_tier_covers_api: z.boolean().nullable().optional(),
        })
        .optional()
        .describe("How the vendor charges, with the page you read it off."),
      offering: z
        .object({
          summary: z.string().nullable().optional(),
          categories: z.array(z.string()).nullable().optional(),
          endpoint_count: z.number().nullable().optional(),
          model_count: z.number().nullable().optional(),
          count_note: z.string().nullable().optional(),
          free_tier: z
            .object({
              available: z.boolean().nullable().optional(),
              what: z.string().nullable().optional(),
              limits: z.string().nullable().optional(),
              requires_key: z.boolean().nullable().optional(),
              requires_account: z.boolean().nullable().optional(),
            })
            .nullable()
            .optional(),
          connect: z
            .object({
              base_url: z.string().nullable().optional(),
              auth: z.string().nullable().optional(),
              auth_header: z.string().nullable().optional(),
              auth_format: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
          catalog_url: z.string().nullable().optional(),
          verified_url: z.string().nullable().optional(),
          verified_date: z.string().nullable().optional(),
          source_urls: z.array(z.string()).nullable().optional(),
          highlights: z
            .array(
              z.object({
                id: z.string(),
                kind: z.string(),
                free: z.boolean().nullable().optional(),
                note: z.string().nullable().optional(),
                url: z.string().nullable().optional(),
              }),
            )
            .nullable()
            .optional(),
        })
        .optional()
        .describe(
          "What the vendor offers: one-line summary, service categories, approximate counts, what " +
            `is free, how to connect, its own catalog URL, and at most ${HIGHLIGHTS_MAX} ` +
            "highlighted models/endpoints. Never copy a full catalog in.",
        ),
      aggregators: z
        .array(
          z.object({
            name: z.string(),
            carries: z.boolean(),
            per_call_price: z.number().nullable().optional(),
            price_verified_url: z.string().nullable().optional(),
            price_note: z.string().nullable().optional(),
          }),
        )
        .optional()
        .describe("Which aggregators resell it, and their published per-call prices."),
      requires_card: z.boolean().optional(),
      requires_phone: z.boolean().optional(),
      requires_work_email: z.boolean().optional(),
      email_only_signup: z.boolean().optional(),
      human_steps: z.array(z.string()).optional().describe("Steps only a human can do."),
      tos_notes: z.string().optional().describe("Anything in the terms that constrains use."),
    },
    async handler(args, ctx) {
      const file = userIndexFileFor(ctx);
      if (file === null) {
        return {
          written: false,
          action: "rejected",
          errors: ["The user index is disabled for this server, so there is nowhere to write."],
        };
      }
      // apis.yaml always wins: a discovered row may not shadow a reviewed one.
      const index = apiIndex(ctx);
      const reviewed = index.entries.filter((entry) => entry.origin === "apis.yaml");
      const reservedNames = new Set(reviewed.map((entry) => entry.name.toLowerCase()));
      const reservedDomains = new Set<string>();
      for (const entry of reviewed) {
        if (entry.domain !== undefined) reservedDomains.add(normalizeDomain(entry.domain));
      }

      const payload: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(args)) {
        if (value !== undefined) payload[field] = value;
      }
      const result = proposeEntry(payload, { file, reservedNames, reservedDomains });

      if (!result.written || result.entry === null) {
        return {
          written: false,
          action: result.action,
          file: result.file,
          errors: result.errors,
          notes: result.notes,
          hint:
            "Fix the fields above and call propose_entry again. Leave anything you could not read " +
            "off a page out entirely -- it becomes null, which is the honest value.",
        };
      }

      const stored = result.entry;
      const decision = routeAccess(stored, { hasKey: false });
      return {
        written: true,
        action: result.action,
        file: result.file,
        entry: {
          name: stored.name,
          url: stored.url,
          domain: stored.domain ?? null,
          status: stored.status ?? null,
          discovered_date: stored.discovered_date ?? null,
          source_urls: stored.source_urls ?? [],
          auth: authFacts(stored),
          billing: billingFacts(stored),
          aggregators: carriageView(stored),
        },
        routing: routingView(decision),
        notes: result.notes,
        next_steps: [
          "find_api will return this row from now on, marked status: unverified.",
          "request_access(platform) gives you the signup plan and the human gates for it.",
          `Once a key exists, call ${stored.domain ?? "the API host"} through the SkeletonKey proxy. ` +
            "The first 2xx promotes this row to status: verified, with the ledger row that did it " +
            "recorded in promoted_by.",
          "Nothing here is a reviewed fact yet: a human should still read the row before it is " +
            "copied into apis.yaml.",
        ],
        reminder: "No secret was written. This file is metadata only; keys live in the vault.",
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
      header: z
        .string()
        .optional()
        .describe(
          "Header to inject. Defaults to the auth_header the API index records for this domain, " +
            "then to Authorization.",
        ),
      format: z
        .string()
        .optional()
        .describe(
          "Header value template containing {key}. Defaults to the auth_format the API index " +
            "records for this domain, then to `Bearer {key}`.",
        ),
      scheme: z
        .enum(UPSTREAM_SCHEMES)
        .optional()
        .describe(
          "Scheme the proxy should use for this domain. Leave it out unless the vendor really " +
            "is plain HTTP: the default is https, except for loopback hosts.",
        ),
    },
    async handler(args, ctx) {
      const alias = required(args, "alias");
      const platform = required(args, "platform");
      const domainInput = required(args, "domain");
      const domain = normalizeDomain(domainInput);

      // The index decides the default, not `Authorization: Bearer`: Apollo and
      // DropLeads want `x-api-key: <key>`, and a wrong header fails as a vendor
      // 401 that looks exactly like a bad key.
      const indexEntry = domain === "" ? undefined : entryForDomain(apiIndex(ctx).entries, domain);
      const headerArg = str(args, "header");
      const formatArg = str(args, "format");
      const schemeArg = str(args, "scheme")?.toLowerCase();
      if (schemeArg !== undefined && !(UPSTREAM_SCHEMES as readonly string[]).includes(schemeArg)) {
        throw new Error("`scheme` must be `https` or `http`.");
      }
      const scheme = schemeArg as UpstreamScheme | undefined;
      const header = headerArg ?? indexEntry?.auth_header ?? "Authorization";
      const format = formatArg ?? indexEntry?.auth_format ?? "Bearer {key}";
      const headerSource =
        headerArg !== undefined
          ? "argument"
          : indexEntry?.auth_header !== null && indexEntry?.auth_header !== undefined
            ? `api-index (${indexEntry.name})`
            : "skeletonkey-default";
      const formatSource =
        formatArg !== undefined
          ? "argument"
          : indexEntry?.auth_format !== null && indexEntry?.auth_format !== undefined
            ? `api-index (${indexEntry.name})`
            : "skeletonkey-default";

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
        ...(scheme === undefined ? [] : ["--scheme", scheme]),
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
          injected_header: header,
          injected_format: format,
          header_source: headerSource,
          format_source: formatSource,
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
          injected_header: header,
          injected_format: format,
          header_source: headerSource,
          format_source: formatSource,
          ...(headerSource === "skeletonkey-default"
            ? {
                header_warning:
                  `The API index records no auth header for ${domain}, so this command falls back ` +
                  "to `Authorization: Bearer {key}`. If the vendor's docs say otherwise (Apollo and " +
                  "DropLeads use `x-api-key`), fix --header/--format before the human runs it.",
              }
            : {}),
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
      const stored: KeyMeta = {
        alias,
        platform,
        domain,
        header,
        format,
        created: existing?.created ?? new Date().toISOString(),
        last_used: existing?.last_used ?? null,
        disabled: existing?.disabled ?? false,
        ...(scheme === undefined
          ? existing?.scheme === undefined
            ? {}
            : { scheme: existing.scheme }
          : { scheme }),
      };
      upsertKey(stored, ctx.home);
      const proxy = proxyInfo(config);
      return {
        alias,
        platform,
        domain,
        stored: true,
        secret_length_chars: secret.trim().length,
        vault: vault.location,
        injected_header: header,
        injected_format: format,
        header_source: headerSource,
        format_source: formatSource,
        upstream_scheme: upstreamSchemeFor(domain, stored),
        upstream_scheme_source: stored.scheme === undefined ? "per-host default" : "argument",
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
        proxy_behaviour:
          `Calls to ${key.domain} through the proxy now get a local ` +
          '403 {"error":"key_disabled"} instead of being forwarded, so nothing reaches the ' +
          "vendor and nothing is charged.",
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
/** Every tool response goes through here; see the note in the handler below. */
function redact<T>(value: T): T {
  return globalRedactor.redactDeep(value);
}

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
    // Last gate before anything reaches the agent. Covers every value this
    // process has loaded (there should be none) *and* every secret shape --
    // which is what catches an agent passing a key as a `reason` and getting
    // it echoed back into its own transcript.
    return { content: [{ type: "text", text: JSON.stringify(redact(result), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: redact(message) }, null, 2) }],
      isError: true,
    };
  }
}

const INSTRUCTIONS = `This server fronts SkeletonKey, a local personal API vault. It returns metadata, never
secret values, and there is no tool that can reveal a key.

Before calling any paid API: find_api(capability) to see what exists, then
request_access(platform, reason, est_budget). If a key is already in the vault you
get a proxy URL -- send your request there with no credential of your own and the
proxy attaches the key.

If no key exists, a trusted local runner (a separate process that holds the
secrets) raises an approval with the human out of band: an OS notification and a
page on localhost. You get {request_id, status: "pending_approval"} and poll
access_status(request_id). You never collect a secret, a card number, a password,
or an OTP, and you never ask the human for one in this conversation: the runner's
Secure Input Popup is where that happens. cancel_request(request_id) withdraws a
request you no longer need.

Spend is capped by policy.yaml: a global monthly cap plus per-vendor caps, both
$0 by default, readable with spend_policy(). You may disable a key and cancel a
request. You may never enable a key or raise a cap -- those are human actions on
the approval page, and there is no tool here that can do them.

Both find_api and request_access return a {route, reason} recommendation: go
direct when the vendor is pay-as-you-go or its free tier covers the API, or
through the cheapest aggregator that resells it per call when direct access needs
a monthly subscription. When no verified price backs a route the reason says
"price unverified" -- repeat that to the human instead of quoting a number you do
not have. If direct signup fails, the runner asks the human about the aggregator
fallback; it is never routed without that approval.

If find_api misses, call discover_api(capability) for the research recipe, do the
research with your own tools, and write what you found with propose_entry. Rows you
write are status: unverified until a call through the proxy returns 2xx.

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
    { name: "skeletonkey", version: "0.3.0" },
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
    openWorldHint: tool.name === "find_api" || tool.name === "discover_api",
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
