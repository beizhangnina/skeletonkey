import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { configPath, skeletonKeyHome } from "./paths.js";
import {
  resolveBackendId,
  type Config,
  type GatewayConfig,
  type MonitorConfig,
  type ProxyConfig,
} from "./types.js";

export function ensureHome(home = skeletonKeyHome()): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, so set it explicitly for existing dirs too.
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    // Non-POSIX filesystems may refuse chmod; the vault file check still applies.
  }
  return home;
}

export function configExists(home = skeletonKeyHome()): boolean {
  return fs.existsSync(configPath(home));
}

export function writeConfig(config: Config, home = skeletonKeyHome()): void {
  ensureHome(home);
  const file = configPath(home);
  fs.writeFileSync(file, YAML.stringify(config), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function readConfig(home = skeletonKeyHome()): Config {
  const file = configPath(home);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No SkeletonKey home found at ${path.dirname(file)}. Run \`skeletonkey init\` first.`,
    );
  }
  const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${file} is not a valid SkeletonKey config.`);
  }
  const raw = parsed as Record<string, unknown>;
  const email = typeof raw["email"] === "string" ? raw["email"] : "";
  const backendRaw = typeof raw["backend"] === "string" ? raw["backend"] : "";
  if (!email) throw new Error(`${file}: missing \`email\`.`);
  const backend = resolveBackendId(backendRaw);
  if (backend === null) {
    throw new Error(`${file}: unknown backend ${JSON.stringify(backendRaw)}.`);
  }
  const config: Config = {
    email,
    backend,
    created: typeof raw["created"] === "string" ? raw["created"] : "",
  };
  if (typeof raw["op_vault"] === "string") config.op_vault = raw["op_vault"];
  if (typeof raw["bw_folder"] === "string") config.bw_folder = raw["bw_folder"];

  const proxy = coerceProxy(raw["proxy"]);
  if (proxy) config.proxy = proxy;
  const gateway = coerceGateway(raw["gateway"]);
  if (gateway) config.gateway = gateway;
  const monitor = coerceMonitor(raw["monitor"]);
  if (monitor) config.monitor = monitor;
  return config;
}

function section(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function coerceProxy(value: unknown): ProxyConfig | null {
  const raw = section(value);
  if (!raw) return null;
  const out: ProxyConfig = {};
  if (typeof raw["bind"] === "string") out.bind = raw["bind"];
  if (typeof raw["port"] === "number" && Number.isFinite(raw["port"])) out.port = raw["port"];
  return Object.keys(out).length > 0 ? out : null;
}

function coerceMonitor(value: unknown): MonitorConfig | null {
  const raw = section(value);
  if (!raw) return null;
  const out: MonitorConfig = {};
  if (typeof raw["anomaly_multiplier"] === "number" && Number.isFinite(raw["anomaly_multiplier"])) {
    out.anomaly_multiplier = raw["anomaly_multiplier"];
  }
  if (
    typeof raw["anomaly_absolute_threshold"] === "number" &&
    Number.isFinite(raw["anomaly_absolute_threshold"])
  ) {
    out.anomaly_absolute_threshold = raw["anomaly_absolute_threshold"];
  }
  if (
    typeof raw["remaining_drop_pct_threshold"] === "number" &&
    Number.isFinite(raw["remaining_drop_pct_threshold"])
  ) {
    out.remaining_drop_pct_threshold = raw["remaining_drop_pct_threshold"];
  }
  return Object.keys(out).length > 0 ? out : null;
}

function coerceGateway(value: unknown): GatewayConfig | null {
  const raw = section(value);
  if (!raw) return null;
  const out: GatewayConfig = {};
  if (typeof raw["bind"] === "string") out.bind = raw["bind"];
  if (typeof raw["port"] === "number" && Number.isFinite(raw["port"])) out.port = raw["port"];
  if (typeof raw["token"] === "string") out.token = raw["token"];
  if (raw["allow_all_interfaces"] === true) out.allow_all_interfaces = true;
  if (typeof raw["fallback_bind"] === "string") out.fallback_bind = raw["fallback_bind"];
  return Object.keys(out).length > 0 ? out : null;
}

