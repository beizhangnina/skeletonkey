/**
 * `~/.skeletonkey/monitor/state.json` (ND-5): per-account last status, last
 * normalized usage, and last run time -- never a secret. This is the only
 * baseline `monitor run` compares a new check against (a "sudden 401", a usage
 * jump), so the file is JSON, mode 0600, and tolerant of being hand-edited or
 * missing entirely.
 */
import fs from "node:fs";
import { ensureHome } from "../config.js";
import { monitorDir, monitorStatePath, skeletonKeyHome } from "../paths.js";
import { redactDeepShapes } from "../redact.js";
import {
  ACCOUNT_STATUSES,
  type AccountStatus,
  type MonitorAccountState,
  type MonitorStateFile,
  type NormalizedUsage,
} from "./types.js";

export function readMonitorState(home = skeletonKeyHome()): MonitorStateFile {
  const file = monitorStatePath(home);
  if (!fs.existsSync(file)) return { version: 1, accounts: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { version: 1, accounts: {} };
  }
  if (parsed === null || typeof parsed !== "object") return { version: 1, accounts: {} };
  const raw = (parsed as Record<string, unknown>)["accounts"];
  if (raw === null || typeof raw !== "object") return { version: 1, accounts: {} };
  const accounts: Record<string, MonitorAccountState> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const coerced = coerceAccountState(value);
    if (coerced !== null) accounts[name] = coerced;
  }
  // Defense in depth: this run's own Redactor already strips known secrets
  // before anything is written, but a file written before that fix (or
  // hand-edited) is still only one shape-rule pass away from leaking.
  return redactDeepShapes({ version: 1, accounts });
}

export function writeMonitorState(state: MonitorStateFile, home = skeletonKeyHome()): void {
  ensureHome(home);
  fs.mkdirSync(monitorDir(home), { recursive: true, mode: 0o700 });
  const file = monitorStatePath(home);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function coerceAccountState(raw: unknown): MonitorAccountState | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const status = obj["last_status"];
  if (typeof status !== "string" || !(ACCOUNT_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  const vendor = typeof obj["vendor"] === "string" ? obj["vendor"] : "";
  const lastRunAt = typeof obj["last_run_at"] === "string" ? obj["last_run_at"] : "";
  if (vendor === "" || lastRunAt === "") return null;
  return {
    vendor,
    last_status: status as AccountStatus,
    last_run_at: lastRunAt,
    last_usage: coerceUsage(obj["last_usage"]),
    last_http_status:
      typeof obj["last_http_status"] === "number" ? (obj["last_http_status"] as number) : null,
  };
}

function coerceUsage(raw: unknown): NormalizedUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const field = (name: string): number | null =>
    typeof obj[name] === "number" && Number.isFinite(obj[name]) ? (obj[name] as number) : null;
  const text = (name: string): string | null => (typeof obj[name] === "string" ? (obj[name] as string) : null);
  return {
    used: field("used"),
    limit: field("limit"),
    remaining: field("remaining"),
    unit: text("unit"),
    period: text("period"),
  };
}
