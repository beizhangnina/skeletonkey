/**
 * ND-2's driver seam for `skeletonkey signup start`.
 *
 * No bundled driver exists for any first-wave vendor (see playbooks.ts): this
 * interface exists so trusted host code -- never the CLI, never agent input --
 * can inject one later without changing the contract. `Nd2SignupDriver` has
 * exactly one method, called at most once, so there is no second call for a
 * stop outcome to lead into: once `run()` reports `captcha`, `phone`,
 * `oauth_consent`, or `payment`, there is nothing left on the interface to
 * call, and no payment field anywhere on it to have asked for in the first
 * place. A `complete` outcome hands back only an opaque key string, bound into
 * the vault by the caller through the same ND-1 path `account add` uses.
 */
import type { SignupOutcome } from "./types.js";

export type Nd2SignupStep =
  | { kind: "captcha" | "phone" | "oauth_consent" | "payment" }
  /** The account exists, but the key itself still needs a human on the key page. */
  | { kind: "key_pending" }
  | { kind: "complete"; apiKey: string };

export interface Nd2SignupDriver {
  run(): Promise<Nd2SignupStep>;
}

const STOP_REASONS = ["captcha", "phone", "oauth_consent", "payment"] as const;

/**
 * Drives one signup attempt. With no driver, the honest answer is
 * `needs_human`/`no_driver` -- the state every first-wave vendor is in today.
 */
export async function driveSignup(driver?: Nd2SignupDriver): Promise<SignupOutcome> {
  if (!driver) {
    return { status: "needs_human", handle: null, reason: "no_driver", log: [] };
  }
  let step: Nd2SignupStep;
  try {
    step = await driver.run();
  } catch {
    // Never echo a driver's exception message: it may carry vendor response
    // bodies or other state that was never meant to leave this process.
    return { status: "needs_human", handle: null, reason: "signup_failed", log: [] };
  }
  if (step.kind === "complete") {
    if (typeof step.apiKey !== "string" || step.apiKey.trim() === "") {
      return { status: "needs_human", handle: null, reason: "key_unavailable", log: [] };
    }
    return { status: "ready", handle: step.apiKey, reason: "complete", log: [] };
  }
  if (step.kind === "key_pending") {
    return { status: "needs_human", handle: null, reason: "key_pending", log: [] };
  }
  const reason: string = (STOP_REASONS as readonly string[]).includes(step.kind)
    ? step.kind
    : "unexpected_step";
  return { status: "needs_human", handle: null, reason, log: [] };
}
