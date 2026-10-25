/**
 * Vendor signup automation: interfaces only in v0.3.
 *
 * The playbook-driven Playwright runner lands in v0.5 (§8). What exists here is
 * the shape the runner will call, plus the honest default: every vendor is a
 * human handoff until a playbook exists for it. The point of shipping the
 * interface now is that the runner's request flow, the approval page, and the
 * ladder are all wired to something real rather than to a TODO.
 */
import type { SecretRequest, SecretResolution } from "../secrets/types.js";

export type SignupOutcomeStatus = "ready" | "needs_human" | "failed";

export interface SignupOutcome {
  status: SignupOutcomeStatus;
  /** Opaque key handle when a key was created and written to the vault. */
  handle: string | null;
  /** `captcha`, `phone`, `no_playbook`, `tos_unknown`, ... */
  reason: string;
  /** Lines for the ledger and the human's page. Never a secret. */
  log: string[];
}

export interface SignupContext {
  vendor: string;
  /** Domain the playbook is allowed to touch; enforced by the allowlist. */
  domain: string | null;
  signupUrl: string | null;
  /** Bound email the account is created with. */
  email: string | null;
  /** The ladder. The only way a playbook may obtain any secret value. */
  resolveSecret(request: SecretRequest): Promise<SecretResolution | null>;
  /** Appends to the request's log. Redacted by the caller. */
  log(line: string): void;
}

/** One vendor's steps. YAML/TS playbooks arrive in v0.5. */
export interface SignupPlaybook {
  vendor: string;
  /** Domains this playbook may drive; checked against the allowlist. */
  domains: string[];
  /** Whether the vendor's terms allow automated signup at all. */
  automation: "allowed" | "human" | "unknown";
}

export interface SignupRunner {
  readonly id: string;
  playbookFor(vendor: string): SignupPlaybook | null;
  run(context: SignupContext): Promise<SignupOutcome>;
}

/**
 * v0.3's runner: no playbooks, so every vendor is a human handoff. It still
 * exercises the real contract -- the request ends in `needs_human` with a
 * reason, which is exactly what the agent sees for a captcha in v0.5.
 */
export class HumanHandoffSignupRunner implements SignupRunner {
  readonly id = "human-handoff";

  playbookFor(): null {
    return null;
  }

  async run(context: SignupContext): Promise<SignupOutcome> {
    context.log(
      `No signup playbook exists for ${context.vendor} in v0.3, so signup is a guided human ` +
        "handoff. Automated signup (Apify, TikHub, Apollo, DropLeads) lands in v0.5.",
    );
    return {
      status: "needs_human",
      handle: null,
      reason: "no_playbook",
      log: [],
    };
  }
}
