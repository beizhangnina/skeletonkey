/**
 * ND-2 signup session metadata: `signups.yaml`, one row per
 * `skeletonkey signup start`, through to `complete` or `abandon`.
 *
 * Strictly metadata, like `accounts.yaml`: an id, the vendor, the account name
 * it is bound to (or will be), a state, timestamps, and the (secret-free)
 * human_steps a human was shown. Never an email, a password, or a key.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import YAML from "yaml";
import { ensureHome } from "../config.js";
import { signupsPath, skeletonKeyHome } from "../paths.js";

export const SIGNUP_STATES = ["needs_human", "key_pending", "bound", "abandoned"] as const;
export type SignupState = (typeof SIGNUP_STATES)[number];

export interface SignupSession {
  id: string;
  vendor: string;
  account: string;
  state: SignupState;
  /** Why the state is what it is, e.g. `no_driver`, `captcha`, `complete`. Never a secret. */
  reason: string | null;
  created: string;
  updated: string;
  /** The human_steps shown at the time of the last state change. Never a secret. */
  steps: string[];
}

export interface SignupsFile {
  version: 1;
  sessions: SignupSession[];
}

const HEADER = `# SkeletonKey signup session metadata -- NO SECRET VALUES ARE STORED HERE.
# One row per \`skeletonkey signup start\`. See \`skeletonkey signup status\` and docs/signup.md.
`;

export function readSignups(home = skeletonKeyHome()): SignupsFile {
  const file = signupsPath(home);
  if (!fs.existsSync(file)) return { version: 1, sessions: [] };
  const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object") return { version: 1, sessions: [] };
  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw["sessions"]) ? (raw["sessions"] as unknown[]) : [];
  return {
    version: 1,
    sessions: list.map(coerceSession).filter((session): session is SignupSession => session !== null),
  };
}

export function writeSignups(data: SignupsFile, home = skeletonKeyHome()): void {
  ensureHome(home);
  const file = signupsPath(home);
  const body = YAML.stringify({
    version: 1,
    sessions: [...data.sessions].sort((a, b) => a.id.localeCompare(b.id)),
  });
  fs.writeFileSync(file, HEADER + body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function findSession(id: string, home = skeletonKeyHome()): SignupSession | undefined {
  return readSignups(home).sessions.find((session) => session.id === id);
}

/** Sessions for one vendor, newest-updated first. */
export function sessionsForVendor(vendor: string, home = skeletonKeyHome()): SignupSession[] {
  return readSignups(home)
    .sessions.filter((session) => session.vendor === vendor)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

/** The session for one vendor + account pair, if one exists. */
export function findSessionFor(
  vendor: string,
  account: string,
  home = skeletonKeyHome(),
): SignupSession | undefined {
  return readSignups(home).sessions.find(
    (session) => session.vendor === vendor && session.account === account,
  );
}

export function upsertSession(session: SignupSession, home = skeletonKeyHome()): void {
  const data = readSignups(home);
  const index = data.sessions.findIndex((existing) => existing.id === session.id);
  if (index >= 0) data.sessions[index] = session;
  else data.sessions.push(session);
  writeSignups(data, home);
}

/** A fresh session id. Opaque; carries no information about the vendor or account. */
export function newSessionId(): string {
  return `sgn_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Starts (or re-touches) the session for one vendor + account. An existing
 * session already `bound` is left alone -- re-running `signup start` after a
 * successful `complete` must not make a finished signup look unfinished again.
 */
export function touchSession(
  vendor: string,
  account: string,
  update: { state: SignupState; reason: string | null; steps: string[] },
  home = skeletonKeyHome(),
): SignupSession {
  const existing = findSessionFor(vendor, account, home);
  const now = new Date().toISOString();
  if (existing?.state === "bound") return existing;
  const session: SignupSession = {
    id: existing?.id ?? newSessionId(),
    vendor,
    account,
    state: update.state,
    reason: update.reason,
    created: existing?.created ?? now,
    updated: now,
    steps: update.steps,
  };
  upsertSession(session, home);
  return session;
}

function coerceSession(raw: unknown): SignupSession | null {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const id = typeof obj["id"] === "string" ? obj["id"] : "";
  const vendor = typeof obj["vendor"] === "string" ? obj["vendor"] : "";
  const account = typeof obj["account"] === "string" ? obj["account"] : "";
  if (id === "" || vendor === "" || account === "") return null;
  const stateRaw = typeof obj["state"] === "string" ? obj["state"] : "";
  const state = (SIGNUP_STATES as readonly string[]).includes(stateRaw)
    ? (stateRaw as SignupState)
    : "needs_human";
  const str = (field: string): string | null =>
    typeof obj[field] === "string" ? (obj[field] as string) : null;
  const steps = Array.isArray(obj["steps"])
    ? (obj["steps"] as unknown[]).filter((step): step is string => typeof step === "string")
    : [];
  return {
    id,
    vendor,
    account,
    state,
    reason: str("reason"),
    created: str("created") ?? "",
    updated: str("updated") ?? "",
    steps,
  };
}
