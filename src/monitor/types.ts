/** Shared shapes for the weekly monitor (ND-5): checkers, state, and results. */

/** A vendor's usage/quota reduced to a handful of numbers. Unknown fields stay null. */
export interface NormalizedUsage {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: string | null;
  period: string | null;
}

/** Enough of a fetch `Response` for a checker to read a status and a body. */
export interface TransportResponse {
  status: number;
  text(): Promise<string>;
}

export interface TransportInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Injectable in place of `fetch`. Tests stub this; nothing here ever touches the network. */
export type HttpTransport = (url: string, init?: TransportInit) => Promise<TransportResponse>;

export interface CheckerInput {
  /** `usage_api.path`, already matched against this checker's official host. */
  url: string;
  method: string;
  /** The account's key, read from the vault for this call only. Never logged. */
  key: string;
  /** Set only for a vendor whose usage endpoint needs a distinct credential (ND-5: Exa). */
  serviceKey?: string | null;
  transport: HttpTransport;
}

export interface CheckerOutcome {
  /** 0 when the request was never sent (e.g. a missing service key). */
  httpStatus: number;
  usage: NormalizedUsage | null;
  /** A reason the call was skipped or usage could not be parsed. Never a secret. */
  note: string | null;
}

export type Checker = (input: CheckerInput) => Promise<CheckerOutcome>;

export interface VendorChecker {
  /** The only host this checker will ever send the key to. */
  host: string;
  /** True when the usage endpoint needs the `<key_alias>-service` vault entry. */
  needsServiceKey?: boolean;
  run: Checker;
}

export const ACCOUNT_STATUSES = [
  "ok",
  "invalid_key",
  "usage_anomaly",
  "no_usage_api",
  "error",
  "skipped",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** One account's outcome for one `monitor run`. Never carries a secret value. */
export interface AccountCheckResult {
  name: string;
  vendor: string;
  status: AccountStatus;
  /** Already masked (`accounts.yaml`'s `email_hint`), or null. Never a plaintext email. */
  emailHint: string | null;
  usage: NormalizedUsage | null;
  httpStatus: number | null;
  /** Why the status is what it is: anomaly reasons, "cannot auto-compare", etc. */
  reasons: string[];
  /** True when this status alone is reason to notify (invalid_key/usage_anomaly/error). */
  isAlert: boolean;
  /** The one check every first-wave vendor is missing, stated rather than invented. */
  loginBillingNote: string | null;
}

/** One account's row in state.json: enough to detect "sudden 401" and usage deltas. */
export interface MonitorAccountState {
  vendor: string;
  last_status: AccountStatus;
  last_run_at: string;
  last_usage: NormalizedUsage | null;
  last_http_status: number | null;
}

export interface MonitorStateFile {
  version: 1;
  accounts: Record<string, MonitorAccountState>;
}
