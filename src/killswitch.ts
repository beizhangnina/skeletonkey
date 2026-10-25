/**
 * One kill switch, read by both the proxy and the runner.
 *
 * `skeletonkey disable --all` (or the button on the approval page) writes the
 * flag file; the proxy then refuses every request locally, and the runner voids
 * pending approvals and refuses new ones. Clearing it is a human action
 * (`skeletonkey resume`), the same as enabling a key.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureHome } from "./config.js";
import { skeletonKeyHome } from "./paths.js";

export interface KillSwitchState {
  engaged: boolean;
  at: string | null;
  reason: string | null;
  by: string | null;
}

export function killSwitchPath(home = skeletonKeyHome()): string {
  return path.join(home, "killswitch.json");
}

export function killSwitchState(home = skeletonKeyHome()): KillSwitchState {
  const file = killSwitchPath(home);
  if (!fs.existsSync(file)) return { engaged: false, at: null, reason: null, by: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      engaged: raw["engaged"] === true,
      at: typeof raw["at"] === "string" ? raw["at"] : null,
      reason: typeof raw["reason"] === "string" ? raw["reason"] : null,
      by: typeof raw["by"] === "string" ? raw["by"] : null,
    };
  } catch {
    // An unreadable flag file is treated as engaged: failing closed is the
    // whole point of a kill switch.
    return { engaged: true, at: null, reason: "killswitch.json is unreadable", by: null };
  }
}

export function engageKillSwitch(
  options: { reason?: string; by?: string } = {},
  home = skeletonKeyHome(),
): KillSwitchState {
  ensureHome(home);
  const state: KillSwitchState = {
    engaged: true,
    at: new Date().toISOString(),
    reason: options.reason ?? null,
    by: options.by ?? "cli",
  };
  const file = killSwitchPath(home);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return state;
}

/** Human-only: the agent-facing surface has no verb that reaches this. */
export function releaseKillSwitch(home = skeletonKeyHome()): KillSwitchState {
  const file = killSwitchPath(home);
  if (fs.existsSync(file)) fs.rmSync(file);
  return { engaged: false, at: null, reason: null, by: null };
}
