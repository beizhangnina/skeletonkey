#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { loadApiIndex, resolveApisPath, validateApisFile } from "./apis.js";
import { resolveBind, TAILSCALE_SENTINEL } from "./bind.js";
import { configExists, ensureHome, readConfig, writeConfig } from "./config.js";
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
    .version("0.1.0")
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
    .action(async (options: InitOptions) => {
      await cmdInit(options);
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
    .argument("<alias>")
    .action((alias: string) => {
      setDisabled(alias, true);
      console.log(`Disabled ${alias}. The proxy will no longer inject its header.`);
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
  await vault.check();

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
  if (isTestOnlyBackend(backend)) {
    console.log(
      "\nWARNING: the `file` backend stores secrets in PLAINTEXT and is test-only. " +
        "Never put a real key in it.",
    );
  }
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
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) void main();
