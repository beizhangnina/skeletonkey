#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { loadApiIndex, resolveApisPath, validateApisFile } from "./apis.js";
import { resolveBind, TAILSCALE_SENTINEL } from "./bind.js";
import { configExists, ensureHome, readConfig, writeConfig } from "./config.js";
import {
  applyRegistration,
  planRegistration,
  renderDiff,
  type AgentId,
  type RegistrationAction,
} from "./agents/register.js";
import { engageKillSwitch, killSwitchState, releaseKillSwitch } from "./killswitch.js";
import { capsUnset, policyPath, readPolicy, setCaps, vendorCap } from "./policy.js";
import { RequestStore } from "./requests.js";
import { DEFAULT_RUNNER_PORT, startRunner } from "./runner/server.js";
import { RunnerClient } from "./runner/client.js";
import { NoopNotifier } from "./notify.js";
import {
  findKey,
  normalizeDomain,
  readKeys,
  setDisabled,
  upsertKey,
  writeKeys,
} from "./keys.js";
import { openLedger } from "./ledger.js";
import { configPath, skeletonKeyHome, keysPath, ledgerPath } from "./paths.js";
import { promptLine, readSecret } from "./prompt.js";
import { startMcpServer } from "./mcp.js";
import { startProxy, upstreamSchemeFor } from "./proxy.js";
import {
  DEFAULT_STALE_DAYS,
  httpFetcher,
  readStaleCache,
  runStaleCheck,
  staleCachePath,
  writeStaleCache,
  type StaleFinding,
} from "./stale.js";
import { silenceSqliteExperimentalWarning } from "./quiet.js";
import { tailscaleIPv4 } from "./tailscale.js";
import {
  BACKENDS,
  DEFAULT_PROXY_PORT,
  PUBLIC_BACKENDS,
  isTestOnlyBackend,
  resolveBackendId,
  type BackendId,
  UPSTREAM_SCHEMES,
  type Config,
  type KeyMeta,
  type UpstreamScheme,
} from "./types.js";
import { createVault, testBackendAllowed } from "./vault/index.js";
import {
  bwAccountStatus,
  bwGuidance,
  bwGuidanceError,
  describeVendorItems,
  findVendorItems,
  sameMailbox,
  type BwAccount,
} from "./vault/bw-account.js";

const DEFAULT_HEADER = "Authorization";
const DEFAULT_FORMAT = "Bearer {key}";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("skeletonkey")
    .description(
      "Local-only vault for your personal API keys, with a header-injecting proxy.\n" +
        "Set SKELETONKEY_HOME to point every command at a different directory.",
    )
    .version("0.3.0")
    .showHelpAfterError();

  program
    .command("init")
    .description("create ~/.skeletonkey, pick a vault backend, record the dedicated email")
    .option("--email <email>", "dedicated email used for API signups")
    .addOption(
      new Option("--backend <backend>", "where secrets are stored (default: bitwarden)").choices([
        ...BACKENDS,
      ]),
    )
    .option("--op-vault <name>", "1Password vault name (1password backend only)", "Private")
    .option("--bw-folder <name>", "Bitwarden folder name (bitwarden backend only)")
    .option("--force", "overwrite an existing config", false)
    .option("--no-register", "skip registering the MCP server with Claude Code and Codex")
    .option("--yes", "do not ask before writing the agent config files", false)
    .option(
      "--user-home <dir>",
      "home directory the agent config files live under (default: your home; used by tests)",
    )
    .option("--agent-command <cmd>", "command the agents should run (default: npx)")
    .action(async (options: InitOptions) => {
      await cmdInit(options);
    });

  program
    .command("register")
    .description("register the MCP server + skill with Claude Code and Codex (re-runnable)")
    .option("--dry-run", "show what would change and write nothing", false)
    .option("--user-home <dir>", "home directory to register into (default: your home)")
    .option("--agent-command <cmd>", "command the agents should run (default: npx)")
    .option("--agent <id>", "only `claude-code` or only `codex`")
    .action(async (options: RegisterCliOptions) => {
      await cmdRegister(options);
    });

  const bitwarden = program
    .command("bitwarden")
    .alias("bw")
    .description("check the `bw` CLI, and find vendor accounts by the bound email");
  bitwarden
    .command("status", { isDefault: true })
    .description("is `bw` installed, logged in, unlocked -- and as the bound email?")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      await cmdBitwardenStatus(options.json);
    });
  bitwarden
    .command("find <domain>")
    .description("list vault items for the bound email that match a vendor domain (never values)")
    .option("--json", "machine-readable output", false)
    .action(async (domain: string, options: { json: boolean }) => {
      await cmdBitwardenFind(domain, options.json);
    });

  program
    .command("runner")
    .description("run the trusted local runner: approvals, spend policy, secure input, secrets")
    .option("--port <n>", "port to listen on (loopback only)", (value: string) => Number(value))
    .option("--no-notify", "do not send OS notifications (the URL is still printed)")
    .action(async (options: RunnerCliOptions) => {
      await cmdRunner(options);
    });

  const policy = program.command("policy").description("read or set the spend caps (human only)");
  policy
    .command("show", { isDefault: true })
    .description("print the current caps")
    .option("--json", "machine-readable output", false)
    .action((options: { json: boolean }) => {
      cmdPolicyShow(options.json);
    });
  policy
    .command("set")
    .description("set the global monthly cap and/or one vendor cap")
    .option("--global <usd>", "global monthly cap in USD", (value: string) => Number(value))
    .option("--vendor <name>", "vendor to cap")
    .option("--vendor-cap <usd>", "that vendor's cap in USD", (value: string) => Number(value))
    .action((options: PolicySetOptions) => {
      cmdPolicySet(options);
    });

  program
    .command("requests")
    .description("list the approval requests agents have raised")
    .option("--json", "machine-readable output", false)
    .action((options: { json: boolean }) => {
      cmdRequests(options.json);
    });

  program
    .command("resume")
    .description("clear the kill switch (human only)")
    .action(() => {
      cmdResume();
    });

  program
    .command("add")
    .description("store a secret in the vault and record its metadata in keys.yaml")
    .argument("<alias>", "short name you will refer to this key by")
    .requiredOption("-p, --platform <platform>", "platform or vendor name")
    .requiredOption("-d, --domain <domain>", "destination domain the key is for")
    .option("--header <name>", "header to inject", DEFAULT_HEADER)
    .option("--format <template>", "header value template containing {key}", DEFAULT_FORMAT)
    .addOption(
      new Option(
        "--scheme <scheme>",
        "scheme the proxy uses for this domain (default: https, or http for a loopback host)",
      ).choices([...UPSTREAM_SCHEMES]),
    )
    .option("--stdin", "always read the secret from stdin", false)
    .action(async (alias: string, options: AddOptions) => {
      await cmdAdd(alias, options);
    });

  program
    .command("list")
    .description("list known keys (metadata only, never secrets)")
    .option("--json", "machine-readable output", false)
    .action((options: { json: boolean }) => {
      cmdList(options.json);
    });

  program
    .command("idle")
    .description("show keys not used in the last N days")
    .requiredOption("--days <n>", "age threshold in days", (value: string) => Number(value))
    .option("--json", "machine-readable output", false)
    .action((options: { days: number; json: boolean }) => {
      cmdIdle(options.days, options.json);
    });

  program
    .command("disable")
    .description("stop the proxy from injecting a key (metadata stays, secret stays in vault)")
    .argument("[alias]")
    .option("--all", "kill switch: disable every key, halt the runner, void pending approvals", false)
    .action(async (alias: string | undefined, options: { all: boolean }) => {
      await cmdDisable(alias, options.all);
    });

  program
    .command("enable")
    .description("re-enable a previously disabled key")
    .argument("<alias>")
    .action((alias: string) => {
      setDisabled(alias, false);
      console.log(`Enabled ${alias}.`);
    });

  program
    .command("proxy")
    .description("run the local injecting proxy (forward-proxy and /<domain>/<path> modes)")
    .option("--port <n>", "port to listen on", (value: string) => Number(value))
    .option(
      "--bind <address>",
      `address to bind: an IP, or \`${TAILSCALE_SENTINEL}\` to use this host's tailnet IP`,
    )
    .option("--host <host>", "alias for --bind")
    .option("--gateway", "serve other devices: requires a shared X-SkeletonKey-Token", false)
    .option("--token <value>", "shared gateway token (or set SKELETONKEY_GATEWAY_TOKEN)")
    .option("--allow-all-interfaces", "permit binding 0.0.0.0 / :: (not recommended)", false)
    .option("--insecure-no-token", "run gateway mode with no shared token", false)
    .addOption(
      new Option(
        "--upstream-scheme <scheme>",
        "force the scheme for every /<domain>/<path> request (default: per key, " +
          "then http for loopback hosts, then https)",
      ).choices([...UPSTREAM_SCHEMES]),
    )
    .action(async (options: ProxyCliOptions) => {
      await cmdProxy(options);
    });

  program
    .command("mcp")
    .description("run the stdio MCP server for agents (tools never return secret values)")
    .action(async () => {
      await cmdMcp();
    });

  program
    .command("ledger")
    .description("print recent proxied calls")
    .option("--limit <n>", "rows to show", (value: string) => Number(value), 20)
    .option("--json", "machine-readable output", false)
    .action((options: { limit: number; json: boolean }) => {
      cmdLedger(options.limit, options.json);
    });

  const apis = program.command("apis").description("work with the apis.yaml index");
  apis
    .command("validate")
    .description("validate an apis.yaml file against the documented schema")
    .argument("[file]", "path to apis.yaml", resolveApisPath())
    .action((file: string) => {
      cmdApisValidate(file);
    });

  program
    .command("stale-check")
    .description("re-fetch every billing/pricing verified_url in the index and flag what moved")
    .option("--max-age-days <n>", "flag rows verified longer ago than this", (value: string) => Number(value), DEFAULT_STALE_DAYS)
    .option("--only <name>", "limit to index rows whose name contains this")
    .option("--no-fetch", "skip the network and report recorded dates only")
    .option("--json", "machine-readable output", false)
    .action(async (options: StaleCliOptions) => {
      await cmdStaleCheck(options);
    });

  return program;
}

interface StaleCliOptions {
  maxAgeDays: number;
  only?: string;
  fetch: boolean;
  json: boolean;
}

interface InitOptions {
  email?: string;
  backend?: string;
  opVault: string;
  bwFolder?: string;
  force: boolean;
  /** Commander turns `--no-register` into `register: false`. */
  register: boolean;
  yes: boolean;
  userHome?: string;
  agentCommand?: string;
}

interface RegisterCliOptions {
  dryRun: boolean;
  userHome?: string;
  agentCommand?: string;
  agent?: string;
}

interface RunnerCliOptions {
  port?: number;
  /** `--no-notify` becomes `notify: false`. */
  notify: boolean;
}

interface PolicySetOptions {
  global?: number;
  vendor?: string;
  vendorCap?: number;
}

interface AddOptions {
  platform: string;
  domain: string;
  header: string;
  format: string;
  scheme?: UpstreamScheme;
  stdin: boolean;
}

interface ProxyCliOptions {
  port?: number;
  bind?: string;
  host?: string;
  gateway: boolean;
  token?: string;
  allowAllInterfaces: boolean;
  insecureNoToken: boolean;
  upstreamScheme?: UpstreamScheme;
}

async function cmdInit(options: InitOptions): Promise<void> {
  const home = skeletonKeyHome();
  if (configExists(home) && !options.force) {
    throw new Error(`${configPath(home)} already exists. Pass --force to overwrite it.`);
  }

  const interactive = process.stdin.isTTY === true;
  let email = options.email?.trim() ?? "";
  if (!email) {
    if (!interactive) throw new Error("--email is required in non-interactive mode.");
    email = await promptLine(
      "Dedicated email for API signups (keep it separate from your main inbox): ",
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${JSON.stringify(email)} does not look like an email address.`);
  }

  let backendInput = options.backend?.trim() ?? "";
  if (!backendInput) {
    if (!interactive) {
      throw new Error(
        `--backend is required in non-interactive mode. Expected one of ${PUBLIC_BACKENDS.join(", ")}.`,
      );
    }
    console.error("Vault backends:");
    console.error(
      "  1) bitwarden       Bitwarden via the `bw` CLI -- free tier, unlimited devices, syncs (default)",
    );
    console.error("  2) 1password       1Password items via the `op` CLI");
    console.error("  3) keychain        macOS login keychain, or libsecret on Linux");
    console.error(
      "  4) encrypted-file  AES-256-GCM file under SKELETONKEY_HOME, unlocked by a passphrase (zero install)",
    );
    const answer = await promptLine("Backend [1/2/3/4 or name] (1): ", "1");
    backendInput =
      { "1": "bitwarden", "2": "1password", "3": "keychain", "4": "encrypted-file" }[answer] ??
      answer;
  }
  const resolved = resolveBackendId(backendInput);
  if (resolved === null) {
    throw new Error(
      `Unknown backend ${JSON.stringify(backendInput)}. Expected one of ${PUBLIC_BACKENDS.join(", ")}.`,
    );
  }
  const backend: BackendId = resolved;
  if (isTestOnlyBackend(backend) && !testBackendAllowed()) {
    throw new Error(
      `The \`${backend}\` backend stores secrets in PLAINTEXT and exists only for this repo's ` +
        `tests and demo. Pick one of ${PUBLIC_BACKENDS.join(", ")}, or set ` +
        "SKELETONKEY_ALLOW_TEST_BACKEND=1 if you really mean it.",
    );
  }

  ensureHome(home);
  const config: Config = {
    email,
    backend,
    ...(backend === "1password" ? { op_vault: options.opVault } : {}),
    ...(backend === "bitwarden" && options.bwFolder ? { bw_folder: options.bwFolder } : {}),
    proxy: { bind: "127.0.0.1", port: DEFAULT_PROXY_PORT },
    created: new Date().toISOString(),
  };

  const vault = createVault(config, home);
  if (backend === "bitwarden") {
    // Guided, and re-checkable: `init` is where a human finds out that `bw` is
    // missing or locked, not three commands later.
    await guideBitwarden(email, interactive);
  } else {
    await vault.check();
  }

  writeConfig(config, home);
  // Create keys.yaml and the ledger up front so their permissions are right from the start.
  writeKeys(readKeys(home), home);
  openLedger(home).close();

  console.log(`SkeletonKey initialised at ${home}`);
  console.log(`  email:    ${email}`);
  console.log(`  backend:  ${backend}`);
  console.log(`  secrets:  ${vault.location}`);
  console.log(`  metadata: ${keysPath(home)} (never contains secrets)`);
  console.log(`  ledger:   ${ledgerPath(home)}`);
  console.log(`  proxy:    http://127.0.0.1:${DEFAULT_PROXY_PORT} (edit \`proxy\` in ${configPath(home)})`);
  console.log(`  policy:   ${policyPath(home)} (caps default to $0 -- a human sets them)`);
  console.log(
    `  runner:   start it with \`skeletonkey runner\` (holds the secrets, raises approvals)`,
  );
  if (isTestOnlyBackend(backend)) {
    console.log(
      "\nWARNING: the `file` backend stores secrets in PLAINTEXT and is test-only. " +
        "Never put a real key in it.",
    );
  }

  if (options.register === false) {
    console.log(
      "\nSkipped agent registration (--no-register). Run `skeletonkey register` when you want it.",
    );
    return;
  }
  await registerAgents({
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.agentCommand === undefined ? {} : { command: options.agentCommand }),
    confirm: options.yes !== true && interactive,
  });
}

/**
 * Writes the Claude Code and Codex config (D8: those two only), after showing
 * the human exactly what is about to change (§5.1).
 */
async function registerAgents(options: {
  userHome?: string;
  command?: string;
  agents?: readonly AgentId[];
  confirm: boolean;
  dryRun?: boolean;
}): Promise<RegistrationAction[]> {
  const planOptions = {
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  };
  const planned = planRegistration(planOptions);
  const changes = planned.filter((action) => action.change !== "unchanged");

  console.log("\nAgent registration (Claude Code and Codex only):");
  for (const action of planned) console.log(renderDiff(action));

  if (changes.length === 0) {
    console.log("  Nothing to do: both agents are already registered.");
    return planned;
  }
  if (options.dryRun === true) {
    console.log("  --dry-run: nothing was written.");
    return planned;
  }
  if (options.confirm) {
    const answer = await promptLine(`Write these ${changes.length} change(s)? [Y/n]: `, "y");
    if (!/^y(es)?$/i.test(answer)) {
      console.log("  Skipped. Run `skeletonkey register` later.");
      return planned;
    }
  }
  const applied = applyRegistration(planOptions);
  for (const action of applied.filter((item) => item.change !== "unchanged")) {
    console.log(`  wrote ${action.target}`);
  }
  console.log(
    "  Restart Claude Code / Codex to pick the server up. If it still does not appear, re-run " +
      "`skeletonkey register` and see the install troubleshooting table in the README.",
  );
  return applied;
}

async function cmdRegister(options: RegisterCliOptions): Promise<void> {
  const agents =
    options.agent === undefined
      ? undefined
      : ([options.agent] as AgentId[]).filter(
          (id) => id === "claude-code" || id === "codex",
        );
  if (options.agent !== undefined && (agents === undefined || agents.length === 0)) {
    throw new Error("--agent must be `claude-code` or `codex` (those are the supported agents).");
  }
  await registerAgents({
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
    ...(options.agentCommand === undefined ? {} : { command: options.agentCommand }),
    ...(agents === undefined ? {} : { agents }),
    confirm: false,
    dryRun: options.dryRun === true,
  });
}

/** The bound email, or null when `init` has not run yet. */
function boundEmail(home: string): string | null {
  try {
    return readConfig(home).email;
  } catch {
    return null;
  }
}

/**
 * `skeletonkey bitwarden status`: installed, logged in, unlocked, and as which
 * account -- plus the commands the human runs when the answer is no. Exits 1
 * when `bw` cannot be read, so a script can gate on it.
 */
async function cmdBitwardenStatus(json: boolean): Promise<void> {
  const home = skeletonKeyHome();
  const bound = boundEmail(home);
  const status = await bwAccountStatus({ bound });
  const guidance = bwGuidance(status);
  if (json) {
    console.log(
      JSON.stringify(
        {
          state: status.state,
          usable: status.usable,
          account: status.account,
          bound_email: status.bound,
          matches_bound_email: status.matchesBound,
          summary: status.summary,
          guidance,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Bitwarden: ${status.summary}.`);
    console.log(`  bw CLI:       ${status.state === "not-installed" ? "NOT on PATH" : "installed"}`);
    console.log(
      `  logged in:    ${status.state === "unlocked" || status.state === "locked" ? "yes" : "no"}`,
    );
    console.log(`  unlocked:     ${status.usable ? "yes" : "no"}`);
    console.log(`  account:      ${status.account ?? "unknown (`bw status` reports none)"}`);
    console.log(
      `  bound email:  ${status.bound ?? "unset -- run `skeletonkey init --email <address>`"}` +
        (status.matchesBound === null ? "" : status.matchesBound ? " (matches)" : " (DIFFERENT)"),
    );
    if (guidance.length > 0) {
      console.log("");
      for (const line of guidance) console.log(`  ${line}`);
    }
  }
  if (!status.usable) process.exitCode = 1;
}

/**
 * `skeletonkey bitwarden find <domain>`: the vendor accounts already in the
 * vault for the bound email. Names, ids and which field matched -- never a
 * password, never an API key.
 */
async function cmdBitwardenFind(domain: string, json: boolean): Promise<void> {
  const home = skeletonKeyHome();
  const bound = boundEmail(home);
  const lookup = await findVendorItems({ domain, bound });
  // Deliberately rebuilt field by field: `lookup.items` carries the values.
  const safe = lookup.items.map((item) => ({
    id: item.id,
    name: item.name,
    username: item.username,
    email_match: item.email_match,
    domain_match: item.domain_match,
    has_password: item.has_password,
    api_key_field: item.api_key_field,
    has_api_key: item.api_key !== null,
  }));
  if (json) {
    console.log(
      JSON.stringify(
        {
          domain: normalizeDomain(domain),
          bound_email: bound,
          state: lookup.account.state,
          searched: lookup.searched,
          detail: lookup.detail,
          items: safe,
          note: "Values are never printed. The runner reads them in memory only.",
        },
        null,
        2,
      ),
    );
  } else {
    console.log(lookup.detail);
    for (const line of describeVendorItems(lookup)) console.log(`  ${line}`);
    if (!lookup.account.usable) {
      for (const line of bwGuidance(lookup.account)) console.log(`  ${line}`);
    } else if (safe.length > 0) {
      console.log("");
      console.log(
        "No value was printed. `skeletonkey add <alias> --platform ... --domain ...` stores a key " +
          "SkeletonKey injects; the runner reads these items in memory only.",
      );
    }
  }
  if (!lookup.account.usable) process.exitCode = 1;
}

/**
 * The guided Bitwarden setup `init` runs for the default backend: detect the
 * state, print the exact commands, and re-check when the human says they have
 * done it. SkeletonKey never collects the master password -- `bw login` and
 * `bw unlock` happen in the human's own terminal, and only the BW_SESSION they
 * export comes back here.
 */
async function guideBitwarden(email: string, interactive: boolean): Promise<BwAccount> {
  let status = await bwAccountStatus({ bound: email });
  let loginAs = email;
  let asked = false;
  while (!status.usable) {
    // Confirm the address rather than guessing it into a `bw login` line.
    if (
      interactive &&
      !asked &&
      (status.state === "unauthenticated" || status.state === "not-installed")
    ) {
      asked = true;
      loginAs = await promptLine(`Bitwarden account email [${email}]: `, email);
      if (!sameMailbox(loginAs, email)) {
        console.error(
          `Note: ${loginAs} is not the bound email ${email}. SkeletonKey looks vendor accounts up ` +
            "by the bound email, so keep the two the same unless you mean it.",
        );
      }
    }
    console.error(`\nBitwarden: ${status.summary}.`);
    for (const line of bwGuidance(status, loginAs)) console.error(`  ${line}`);
    if (!interactive) throw bwGuidanceError(status, loginAs);
    const answer = await promptLine(
      "Press Enter once you have done that and I will re-check, or type `skip`: ",
      "recheck",
    );
    if (/^(skip|s|no?)$/i.test(answer)) {
      console.error(
        "Carrying on without Bitwarden. `skeletonkey add` and the proxy will refuse with these " +
          "same steps until `bw` is unlocked; re-check any time with `skeletonkey bitwarden status`.",
      );
      return status;
    }
    status = await bwAccountStatus({ bound: email });
  }
  console.error(`Bitwarden: ${status.summary}.`);
  if (status.matchesBound === false) {
    for (const line of bwGuidance(status, loginAs)) console.error(`  ${line}`);
  }
  return status;
}

async function cmdRunner(options: RunnerCliOptions): Promise<void> {
  const home = skeletonKeyHome();
  readConfig(home); // fail early and clearly when `init` has not run
  const handle = await startRunner({
    home,
    port: options.port ?? DEFAULT_RUNNER_PORT,
    ...(options.notify === false ? { notifier: new NoopNotifier() } : {}),
  });
  const policy = readPolicy(home);
  console.log(`skeletonkey runner listening on ${handle.url}`);
  console.log(`  approvals:    ${handle.url}/ (localhost only, no token)`);
  console.log(`  secure input: ${handle.url}/input/<id> (announced by an OS notification)`);
  console.log(`  agent API:    ${handle.url}/v1/... (needs the token in runner.json)`);
  console.log(
    `  caps:         global $${policy.global_monthly_cap_usd}/month` +
      (capsUnset(policy) ? " -- unset, so the first paid action will ask you to set them" : ""),
  );
  console.log(`  allowlist:    ${handle.allowlist.size} vendor domain(s) from the API index`);
  console.log(`  kill switch:  ${killSwitchState(home).engaged ? "ENGAGED" : "clear"}`);
  console.log("  secrets stay in this process. No MCP tool and no runner verb can read one.");

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive until a signal arrives.
  await new Promise<void>(() => {});
}

function cmdPolicyShow(json: boolean): void {
  const home = skeletonKeyHome();
  const policy = readPolicy(home);
  if (json) {
    console.log(JSON.stringify({ file: policyPath(home), ...policy }, null, 2));
    return;
  }
  console.log(`policy file: ${policyPath(home)}`);
  console.log(`global monthly cap: $${policy.global_monthly_cap_usd}`);
  const vendors = Object.entries(policy.vendor_caps_usd);
  if (vendors.length === 0) console.log("per-vendor caps:    none set");
  else printTable(["VENDOR", "CAP (USD)"], vendors.map(([name, cap]) => [name, `$${cap}`]));
  console.log(`last change by:     ${policy.last_change_by ?? "nobody yet"}`);
  if (capsUnset(policy)) {
    console.log(
      "\nEvery cap is $0, so nothing can be spent. The first paid action raises an approval " +
        "asking you to set them -- there are no preset numbers.",
    );
  }
  console.log("Agents can never raise these. Only this command and the approval page can.");
}

function cmdPolicySet(options: PolicySetOptions): void {
  const home = skeletonKeyHome();
  if (options.global === undefined && options.vendorCap === undefined) {
    throw new Error("Pass --global <usd> and/or --vendor <name> --vendor-cap <usd>.");
  }
  if ((options.vendor === undefined) !== (options.vendorCap === undefined)) {
    throw new Error("--vendor and --vendor-cap go together.");
  }
  const updated = setCaps(
    {
      ...(options.global === undefined ? {} : { global_monthly_cap_usd: options.global }),
      ...(options.vendor === undefined || options.vendorCap === undefined
        ? {}
        : { vendor: options.vendor, vendor_cap_usd: options.vendorCap }),
    },
    { by: "cli" },
    home,
  );
  console.log(`Caps written to ${policyPath(home)}.`);
  console.log(`  global monthly: $${updated.global_monthly_cap_usd}`);
  if (options.vendor !== undefined) {
    console.log(`  ${options.vendor}: $${vendorCap(updated, options.vendor)}`);
  }
}

function cmdRequests(json: boolean): void {
  const home = skeletonKeyHome();
  const requests = RequestStore.open(home).list();
  if (json) {
    console.log(JSON.stringify(requests, null, 2));
    return;
  }
  if (requests.length === 0) {
    console.log("No requests yet. An agent raises one with request_access.");
    return;
  }
  printTable(
    ["ID", "KIND", "VENDOR", "STATUS", "EST", "CREATED"],
    requests.map((request) => [
      request.id,
      request.kind,
      request.vendor,
      request.status,
      request.est_budget_usd === null ? "-" : `$${request.est_budget_usd}`,
      request.created,
    ]),
  );
  const pending = requests.filter((request) => request.status === "pending_approval");
  if (pending.length > 0) {
    const state = readRunnerStateForHints(home);
    console.log(
      `\n${pending.length} pending. Decide them at ` +
        (state === null ? "the runner's /approve/<id> page (start `skeletonkey runner`)" : `${state}/`),
    );
  }
}

function readRunnerStateForHints(home: string): string | null {
  const client = RunnerClient.fromHome(home);
  return client === null ? null : client.url;
}

async function cmdDisable(alias: string | undefined, all: boolean): Promise<void> {
  const home = skeletonKeyHome();
  if (!all) {
    if (alias === undefined) throw new Error("Pass an alias, or --all for the kill switch.");
    setDisabled(alias, true, home);
    console.log(`Disabled ${alias}. The proxy will no longer inject its header.`);
    return;
  }

  const keys = readKeys(home).keys;
  for (const key of keys) if (!key.disabled) setDisabled(key.alias, true, home);
  const state = engageKillSwitch({ reason: "skeletonkey disable --all", by: "cli" }, home);

  // Tell a running runner, so pending approvals are voided now rather than at
  // its next restart.
  let voided: unknown = "no runner was running";
  const client = RunnerClient.fromHome(home);
  if (client !== null) {
    try {
      const result = await client.kill("skeletonkey disable --all");
      voided = result["voided_requests"] ?? [];
    } catch {
      voided = "the runner did not answer; its pending approvals are voided when it next starts";
    }
  } else {
    const store = RequestStore.open(home);
    const localVoided = store.voidPending("Voided by `skeletonkey disable --all`.");
    voided = localVoided.map((request) => request.id);
  }

  console.log(`Kill switch engaged at ${state.at}.`);
  console.log(`  keys disabled:      ${keys.length}`);
  console.log(`  pending approvals:  ${JSON.stringify(voided)}`);
  console.log("  the proxy now answers every call with 403 {\"error\":\"kill_switch\"} locally");
  console.log("  clear it with `skeletonkey resume` (only a human can).");
}

function cmdResume(): void {
  const home = skeletonKeyHome();
  const before = killSwitchState(home);
  releaseKillSwitch(home);
  console.log(
    before.engaged
      ? "Kill switch cleared. Keys you disabled stay disabled: re-enable them with `skeletonkey enable <alias>`."
      : "The kill switch was not engaged; nothing to clear.",
  );
}

async function cmdAdd(alias: string, options: AddOptions): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(alias)) {
    throw new Error("Alias must start with a letter or digit and contain only [A-Za-z0-9._-].");
  }
  const home = skeletonKeyHome();
  const config = readConfig(home);
  const vault = createVault(config, home);
  await vault.check();

  if (!options.format.includes("{key}")) {
    throw new Error(`--format must contain the {key} placeholder (got ${JSON.stringify(options.format)}).`);
  }
  const domain = normalizeDomain(options.domain);
  if (!domain) throw new Error("--domain is required and must be a hostname.");

  const secret = (await readSecret(options.stdin)).trim();
  if (!secret) throw new Error("Empty secret; nothing stored.");

  await vault.set(alias, secret);
  const stored = await vault.get(alias);
  if (stored !== secret) {
    throw new Error("Vault read-back did not match what was written; metadata not recorded.");
  }

  const existing = findKey(alias, home);
  const scheme = options.scheme ?? existing?.scheme;
  const meta: KeyMeta = {
    alias,
    platform: options.platform,
    domain,
    header: options.header,
    format: options.format,
    created: existing?.created ?? new Date().toISOString(),
    last_used: existing?.last_used ?? null,
    disabled: existing?.disabled ?? false,
    ...(scheme === undefined ? {} : { scheme }),
  };
  upsertKey(meta, home);

  console.log(`Stored secret for ${alias} in ${vault.location}.`);
  console.log(`Metadata recorded in ${keysPath(home)} (${secret.length} chars of secret NOT written there).`);
  console.log(`The proxy will send: ${meta.header}: ${meta.format.replace("{key}", "<secret>")} -> ${domain}`);
  console.log(
    `Upstream scheme:     ${
      meta.scheme === undefined
        ? `${upstreamSchemeFor(domain, meta)} (decided per host; override with --scheme)`
        : `${meta.scheme} (recorded on this key)`
    }`,
  );
}

function cmdList(json: boolean): void {
  const home = skeletonKeyHome();
  const keys = readKeys(home).keys;
  const lastUsed = ledgerLastUsed(home);
  const rows = keys.map((key) => ({
    ...key,
    last_used: newest(key.last_used, lastUsed.get(key.alias) ?? null),
  }));

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No keys yet. Add one with: skeletonkey add <alias> --platform <p> --domain <d>");
    return;
  }
  printTable(
    ["ALIAS", "PLATFORM", "DOMAIN", "HEADER", "SCHEME", "STATE", "LAST USED"],
    rows.map((row) => [
      row.alias,
      row.platform,
      row.domain,
      row.header,
      row.scheme ?? `${upstreamSchemeFor(row.domain, row)}*`,
      row.disabled ? "disabled" : "enabled",
      row.last_used ?? "never",
    ]),
  );
  console.log("* scheme decided per host (no --scheme recorded on the key).");
}

function cmdIdle(days: number, json: boolean): void {
  if (!Number.isFinite(days) || days < 0) throw new Error("--days must be a non-negative number.");
  const home = skeletonKeyHome();
  const lastUsed = ledgerLastUsed(home);
  const cutoff = Date.now() - days * 86_400_000;
  const idle = readKeys(home)
    .keys.map((key) => ({
      ...key,
      last_used: newest(key.last_used, lastUsed.get(key.alias) ?? null),
    }))
    .filter((key) => {
      if (key.last_used === null) return true;
      const parsed = Date.parse(key.last_used);
      return Number.isNaN(parsed) ? true : parsed < cutoff;
    });

  if (json) {
    console.log(JSON.stringify(idle, null, 2));
    return;
  }
  if (idle.length === 0) {
    console.log(`No keys idle for more than ${days} day(s).`);
    return;
  }
  console.log(`Keys unused for more than ${days} day(s) -- candidates to disable or cancel:`);
  printTable(
    ["ALIAS", "PLATFORM", "DOMAIN", "STATE", "LAST USED"],
    idle.map((key) => [
      key.alias,
      key.platform,
      key.domain,
      key.disabled ? "disabled" : "enabled",
      key.last_used ?? "never",
    ]),
  );
}

function cmdLedger(limit: number, json: boolean): void {
  const ledger = openLedger(skeletonKeyHome());
  try {
    const rows = ledger.recent(limit);
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("Ledger is empty. Route a call through `skeletonkey proxy` first.");
      return;
    }
    printTable(
      ["ID", "TIMESTAMP", "ALIAS", "DOMAIN", "STATUS", "BYTES", "COST"],
      rows.map((row) => [
        String(row.id),
        row.timestamp,
        row.alias ?? "-",
        row.domain,
        row.status === null ? "-" : String(row.status),
        String(row.bytes),
        row.cost === null ? "-" : String(row.cost),
      ]),
    );
  } finally {
    ledger.close();
  }
}

async function cmdProxy(options: ProxyCliOptions): Promise<void> {
  const home = skeletonKeyHome();
  const config = readConfig(home);
  const gateway = options.gateway === true;
  const section = gateway ? config.gateway : config.proxy;

  // --bind wins over --host (its alias), then the matching config section.
  const requested = options.bind ?? options.host ?? section?.bind;
  const port =
    options.port ?? section?.port ?? config.proxy?.port ?? DEFAULT_PROXY_PORT;
  const token =
    options.token ?? process.env.SKELETONKEY_GATEWAY_TOKEN ?? config.gateway?.token ?? null;

  // Resolving the tailnet address is the only I/O; the decision itself is pure.
  const wantsTailscale = (requested ?? "").trim().toLowerCase() === TAILSCALE_SENTINEL;
  const tailscaleAddress = wantsTailscale ? await tailscaleIPv4() : null;

  const decision = resolveBind({
    requested,
    gateway,
    allowAllInterfaces:
      options.allowAllInterfaces === true || config.gateway?.allow_all_interfaces === true,
    tailscaleAddress,
    fallbackBind: config.gateway?.fallback_bind,
    hasToken: token !== null && token !== "",
    allowNoToken: options.insecureNoToken === true,
  });

  for (const warning of decision.warnings) console.error(`skeletonkey: warning: ${warning}`);
  if (!decision.ok) throw new Error(decision.errors.join("\n  "));

  const handle = await startProxy({
    port,
    host: decision.host,
    home,
    ...(options.upstreamScheme === undefined ? {} : { upstreamScheme: options.upstreamScheme }),
    token,
    requireToken: decision.requireToken,
  });

  const enabled = readKeys(home).keys.filter((key) => !key.disabled);
  console.log(`skeletonkey proxy listening on ${handle.url}${gateway ? " (gateway mode)" : ""}`);
  if (decision.source === "tailscale") {
    console.log(`  bind:           ${decision.host} (resolved from \`tailscale ip -4\`)`);
  }
  console.log(
    `  reverse mode:   curl ${handle.url}/<domain>/<path>  (upstream scheme: ${
      options.upstreamScheme === undefined
        ? "per key, then http for loopback, else https"
        : `${options.upstreamScheme} -- forced for every host`
    })`,
  );
  console.log(`  forward proxy:  export HTTP_PROXY=${handle.url}  (plain HTTP upstreams only)`);
  console.log(`  forward proxy:  HTTPS_PROXY is NOT supported -- CONNECT tunnels cannot be injected`);
  console.log(
    `  auth:           ${
      handle.requireToken
        ? "X-SkeletonKey-Token required on every request (except /__skeletonkey/health)"
        : "none -- anything that can reach this port can spend through your keys"
    }`,
  );
  console.log(`  injecting for:  ${enabled.map((key) => `${key.alias}@${key.domain}`).join(", ") || "(no enabled keys)"}`);
  console.log(`  ledger:         ${ledgerPath(home)}`);

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdMcp(): Promise<void> {
  // stdout belongs to the JSON-RPC transport from here on.
  const home = skeletonKeyHome();
  const handle = await startMcpServer({ home });
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await handle.closed;
}

function cmdApisValidate(file: string): void {
  const result = validateApisFile(path.resolve(file));
  if (!result.valid) {
    console.error(`${file}: invalid`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  const entries = result.document?.entries ?? [];
  const examples = entries.filter((entry) => entry.example === true).length;
  const unknownPrice = entries.filter((entry) => entry.min_topup === null).length;
  console.log(`${file}: valid -- ${entries.length} entries (${examples} example, ${unknownPrice} with unknown min_topup)`);
}

/**
 * Re-reads the pages the index claims its prices came from. Exit code 1 when
 * something needs a human: a page moved, or stopped answering. "Verified N days
 * ago" is a warning, not a failure -- the facts may still be right.
 */
async function cmdStaleCheck(options: StaleCliOptions): Promise<void> {
  const home = skeletonKeyHome();
  const index = loadApiIndex({ home });
  const cacheFile = staleCachePath(home);
  const result = await runStaleCheck({
    entries: index.entries,
    cache: readStaleCache(cacheFile),
    fetchUrl: options.fetch ? httpFetcher() : null,
    maxAgeDays: options.maxAgeDays,
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  if (options.fetch) writeStaleCache(cacheFile, result.cache);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          index_files: index.files.length,
          entries_checked: index.entries.length,
          urls_checked: result.findings.length,
          fetched: result.fetched,
          max_age_days: options.maxAgeDays,
          cache_file: cacheFile,
          counts: result.counts,
          needs_attention: result.needs_attention,
          findings: result.findings,
        },
        null,
        2,
      ),
    );
  } else if (result.findings.length === 0) {
    console.log(
      "stale-check: no verified_url anywhere in the index" +
        (options.only === undefined ? "" : ` matching ${JSON.stringify(options.only)}`) +
        " -- nothing to re-check. A row with no verified_url is unverified by definition.",
    );
  } else {
    printTable(
      ["status", "entry", "field", "age", "http", "url"],
      result.findings.map((finding: StaleFinding) => [
        finding.status.toUpperCase(),
        finding.entry,
        finding.field,
        finding.age_days === null ? "-" : `${finding.age_days}d`,
        finding.http_status === null ? "-" : String(finding.http_status),
        finding.url,
      ]),
    );
    console.log("");
    for (const finding of result.findings) {
      if (finding.status === "ok") continue;
      console.log(`${finding.status.toUpperCase()}  ${finding.entry} ${finding.field}: ${finding.detail}`);
    }
    const parts = Object.entries(result.counts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`);
    console.log("");
    console.log(
      `stale-check: ${result.findings.length} url(s), ${parts.join(", ")}` +
        (result.fetched ? "" : " (dates only, --no-fetch)"),
    );
    if (!result.fetched) {
      console.log("Re-run without --no-fetch to compare each page against its recorded fingerprint.");
    }
  }

  if (result.needs_attention) {
    console.error(
      "stale-check: a page a price was read from changed or stopped answering. Re-read it and " +
        "update billing.verified_date, or set the price back to null.",
    );
    process.exitCode = 1;
  }
}

function ledgerLastUsed(home: string): Map<string, string> {
  const ledger = openLedger(home);
  try {
    return ledger.lastUsedByAlias();
  } finally {
    ledger.close();
  }
}

function newest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  console.log(render(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(render(row));
}

export async function main(argv: string[] = process.argv): Promise<void> {
  silenceSqliteExperimentalWarning();
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`skeletonkey: ${message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) void main();
