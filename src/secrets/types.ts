/**
 * The interfaces behind the secret value resolution ladder (§5a).
 *
 * Every secret the runner needs -- a card number, a CVV, a generated password,
 * an email OTP -- is asked for through one shape, so the ladder can try
 * Bitwarden, then the bound inbox, then the Secure Input Popup without any
 * caller knowing which one answered.
 *
 * A resolved value lives in the runner's memory only. Nothing in this directory
 * returns a value to an MCP tool, writes one to a log, or puts one in a status
 * file.
 */

export const SECRET_CLASSES = [
  "api_key",
  "password",
  "card_number",
  "card_cvv",
  "card_expiry",
  "otp",
] as const;
export type SecretClass = (typeof SECRET_CLASSES)[number];

/**
 * Classes that must never reach the AI under any circumstances (the HARD RULE).
 * `otp` is deliberately absent: §5a allows an agent-read OTP as a fallback, and
 * it is the only class that may ever be seen by an agent.
 */
export const NEVER_VIA_AGENT: readonly SecretClass[] = [
  "api_key",
  "password",
  "card_number",
  "card_cvv",
  "card_expiry",
];

export function neverViaAgent(secretClass: SecretClass): boolean {
  return NEVER_VIA_AGENT.includes(secretClass);
}

export interface SecretRequest {
  class: SecretClass;
  /** Vendor the value is for, as the index names it. */
  vendor: string;
  /**
   * The origin the value will be typed into: an absolute URL of the page the
   * runner has open. Checked against the allowlist before any source is asked.
   */
  origin: string;
  /** Form field or purpose, shown to the human: "SMS code", "card number". */
  field: string;
  /** Vault alias to read (or write) when Bitwarden can answer. */
  alias?: string;
  /** Free text shown on the popup so the human knows why they are being asked. */
  reason?: string;
}

/** Where a value came from. Carries the value; never leaves the runner. */
export interface SecretResolution {
  source: "bitwarden" | "inbox" | "popup";
  value: string;
  /** Human-readable account of how it was resolved, with no value in it. */
  detail: string;
}

/** What the ladder reports when nothing could answer. */
export interface SecretFailure {
  source: null;
  /** `blocked` = allowlist refused; `unavailable` = no source could answer. */
  kind: "blocked" | "unavailable" | "declined" | "timeout";
  detail: string;
}

export type SecretOutcome = SecretResolution | SecretFailure;

export function isResolved(outcome: SecretOutcome): outcome is SecretResolution {
  return outcome.source !== null;
}

export interface SecretSource {
  /** `bitwarden` | `inbox` | `popup`. The rung's name. */
  readonly id: SecretResolution["source"];
  /** Classes this rung can answer at all. */
  handles(secretClass: SecretClass): boolean;
  /**
   * Resolves the value, or null when this rung cannot answer *this* request
   * (not installed, not logged in, no matching mail, human declined).
   */
  resolve(request: SecretRequest): Promise<SecretResolution | null>;
  /** Why this rung could not answer, for the log. Never contains a value. */
  lastDetail(): string | null;
}
