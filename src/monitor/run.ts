/**
 * `skeletonkey monitor run` (ND-5): for every active ND-1 account, resolve its
 * vendor's official usage API (if any, if a checker for it ships), call it,
 * classify the result, compare it against the local ledger for a usage
 * anomaly, write state.json and a redacted weekly report, and raise one OS
 * notification if anything needs a human.
 *
 * Every secret this run touches (an account's key, Exa's service key) is read
 * from the vault here and nowhere else, registered with a run-scoped
 * `Redactor` the moment it is read, and never put in a classification result,
 * the state file, the report, a notification, or an error message.
 */
import fs from "node:fs";
import path from "node:path";
import { readAccounts, type AccountMeta } from "../accounts/store.js";
import { ensureHome, readConfig } from "../config.js";
import { EXIT } from "../exit-codes.js";
import { openLedger, type Ledger } from "../ledger.js";
import { OsNotifier, type Notifier } from "../notify.js";
import { monitorDir, monitorReportPath, monitorReportsDir, skeletonKeyHome } from "../paths.js";
import { Redactor } from "../redact.js";
import { maskUsername } from "../vault/entries.js";
import { openEntryStore, type VaultEntryStore } from "../vault/entry-store.js";
import type { Config } from "../types.js";
import { detectAnomaly, type LedgerWindowStats } from "./anomaly.js";
import { CHECKERS, defaultTransport } from "./checkers.js";
import { renderMonitorReport } from "./report.js";
import { readMonitorState, writeMonitorState } from "./state.js";
import { resolveMonitorThresholds } from "./thresholds.js";
import type {
  AccountCheckResult,
  AccountStatus,
  CheckerOutcome,
  HttpTransport,
  MonitorStateFile,
  NormalizedUsage,
} from "./types.js";
import { findVendorEntry } from "./vendor-entry.js";

const LOGIN_BILLING_NOTE = "login/billing anomaly check: not available via official API";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface MonitorRunOptions {
  home?: string;
  /** Limit the run to one account by name. */
  account?: string;
  /** Default true. `--no-notify` passes false. */
  notify?: boolean;
  notifier?: Notifier;
  reportDir?: string;
  /** Test seam: which apis.yaml / shards to resolve a vendor's usage_api from. */
  apisFile?: string;
  apiShardDirs?: string[];
  /** `YYYY-MM-DD`: compare official usage against this date instead of the last run. */
  since?: string;
  offline?: boolean;
  transport?: HttpTransport;
  now?: () => Date;
}

export interface MonitorRunResult {
  generatedAt: string;
  reportPath: string;
  reportText: string;
  accounts: AccountCheckResult[];
  alertCount: number;
  notified: boolean;
  exitCode: number;
}

/** `YYYY-MM-DD` for the report filename, in the local timezone (matches `todayLocalDate`). */
function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const ALERTING_STATUSES: readonly AccountStatus[] = ["invalid_key", "usage_anomaly", "error", "parse_error"];

/**
 * `email_hint` is documented as already masked (ND-1's `maskUsername`), but a
 * hand-edited `accounts.yaml` can defeat that. Re-mask anything that does not
 * already look masked, rather than trusting the file blindly.
 */
function safeEmailHint(hint: string | null): string | null {
  if (hint === null || hint === "") return hint;
  return hint.includes("*") ? hint : maskUsername(hint);
}

function result(
  account: AccountMeta,
  status: AccountStatus,
  options: {
    usage?: AccountCheckResult["usage"];
    httpStatus?: number | null;
    reasons?: string[];
    isAlert?: boolean;
  } = {},
): AccountCheckResult {
  // invalid_key/usage_anomaly/error/parse_error always alert unless a caller
  // overrides it (the --offline carry-forward path does, computing it from
  // the carried status instead of the placeholder status this run used).
  const alertsByDefault = ALERTING_STATUSES.includes(status);
  return {
    name: account.name,
    vendor: account.vendor,
    status,
    emailHint: safeEmailHint(account.email_hint),
    usage: options.usage ?? null,
    httpStatus: options.httpStatus ?? null,
    reasons: options.reasons ?? [],
    isAlert: options.isAlert ?? alertsByDefault,
    loginBillingNote: status === "skipped" ? null : LOGIN_BILLING_NOTE,
  };
}

async function resolveSecret(store: VaultEntryStore, alias: string): Promise<string | null> {
  const entry = store.resolve(alias);
  if (entry === null || entry.disabled) return null;
  return store.getField(entry, "api_key");
}

function windowedLedgerStats(ledger: Ledger, alias: string, sinceIso: string): LedgerWindowStats {
  const rows = ledger.recent(1_000_000, alias).filter((row) => row.timestamp >= sinceIso);
  const costs = rows.map((row) => row.cost).filter((cost): cost is number => cost !== null);
  return {
    calls: rows.length,
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

function resolveSinceIso(since: string | undefined, previousRunAt: string | undefined, now: Date): string {
  if (since !== undefined) {
    const parsed = new Date(`${since}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (previousRunAt !== undefined && previousRunAt !== "") return previousRunAt;
  return new Date(now.getTime() - WEEK_MS).toISOString();
}

/**
 * A 200 that parsed to nothing usable (a non-JSON body, or a JSON body with
 * none of the fields a checker looks for) must never be reported as a bare,
 * unexplained `ok` -- see `isUnparsedUsage`'s callers in `runMonitor`.
 */
function isUnparsedUsage(usage: NormalizedUsage): boolean {
  return usage.used === null && usage.limit === null && usage.remaining === null && usage.period === null;
}

function readConfigOrNull(home: string): Config | null {
  try {
    return readConfig(home);
  } catch {
    return null;
  }
}

export async function runMonitor(options: MonitorRunOptions = {}): Promise<MonitorRunResult> {
  const home = options.home ?? skeletonKeyHome();
  const now = (options.now ?? (() => new Date()))();
  const transport = options.transport ?? defaultTransport;
  const config = readConfigOrNull(home);
  const thresholds = resolveMonitorThresholds(config);

  const allAccounts = readAccounts(home).accounts;
  const accounts =
    options.account === undefined ? allAccounts : allAccounts.filter((a) => a.name === options.account);

  const state = readMonitorState(home);
  const nextState: MonitorStateFile = { version: 1, accounts: { ...state.accounts } };
  const redactor = new Redactor();

  let store: VaultEntryStore | null = null;
  const getStore = (): VaultEntryStore => {
    if (store === null) store = openEntryStore(home);
    return store;
  };
  // Cheap and config-independent (unlike the vault), so opened unconditionally.
  const ledger = openLedger(home);

  const results: AccountCheckResult[] = [];

  for (const account of accounts) {
    if (account.disabled) {
      results.push(result(account, "skipped", { reasons: ["skipped: account is disabled"] }));
      continue;
    }

    const previous = state.accounts[account.name] ?? null;

    if (account.key_alias === null) {
      results.push(
        result(account, "no_usage_api", {
          reasons: ["cannot auto-compare usage: no api_key is linked to this account"],
        }),
      );
      continue;
    }

    const entry = findVendorEntry(account.vendor, {
      home,
      ...(options.apisFile === undefined ? {} : { apisFile: options.apisFile }),
      ...(options.apiShardDirs === undefined ? {} : { apiShardDirs: options.apiShardDirs }),
    });
    const usageApi = entry?.usage_api ?? null;
    const checker = CHECKERS[account.vendor.toLowerCase()];

    if (usageApi?.available !== true || checker === undefined) {
      const reason =
        usageApi?.available === true
          ? `cannot auto-compare usage: official usage API documented but no checker implemented ` +
            `yet for "${account.vendor}"`
          : "cannot auto-compare usage: no official usage API verified (not verified in official docs)";
      results.push(result(account, "no_usage_api", { reasons: [reason] }));
      continue;
    }

    let url: URL;
    try {
      url = new URL(usageApi.path as string);
    } catch {
      results.push(
        result(account, "error", { reasons: ["error: usage_api.path is not an absolute URL"] }),
      );
      continue;
    }
    if (url.host.toLowerCase() !== checker.host) {
      results.push(
        result(account, "error", {
          reasons: [
            `error: refused -- usage_api.path host "${url.host}" does not match the official host ` +
              `"${checker.host}" for "${account.vendor}"`,
          ],
        }),
      );
      continue;
    }
    if (url.protocol !== "https:") {
      results.push(
        result(account, "error", {
          reasons: [
            `error: refused -- usage_api.path "${url.protocol}//${url.host}" is not https; a key is ` +
              `never sent over plain HTTP`,
          ],
        }),
      );
      continue;
    }

    if (options.offline === true) {
      const carried = previous;
      results.push(
        result(account, carried?.last_status ?? "no_usage_api", {
          usage: carried?.last_usage == null ? null : redactor.redactDeep(carried.last_usage),
          httpStatus: carried?.last_http_status ?? null,
          isAlert: carried !== null && ALERTING_STATUSES.includes(carried.last_status),
          reasons: [
            carried === null
              ? "offline: not checked this run, and no previous run to carry forward"
              : `offline: not checked this run; showing the last known status from ${carried.last_run_at}`,
          ],
        }),
      );
      continue;
    }

    const key = await resolveSecret(getStore(), account.key_alias);
    if (key === null) {
      results.push(
        result(account, "error", {
          reasons: ["error: the vault entry for this account's key is missing or disabled"],
        }),
      );
      continue;
    }
    redactor.add(key);

    let serviceKey: string | null = null;
    if (checker.needsServiceKey === true) {
      serviceKey = await resolveSecret(getStore(), `${account.key_alias}-service`);
      if (serviceKey === null) {
        results.push(result(account, "no_usage_api", { reasons: ["requires Team Management service key"] }));
        continue;
      }
      redactor.add(serviceKey);
    }

    let outcome: CheckerOutcome;
    try {
      outcome = await checker.run({
        url: usageApi.path as string,
        method: usageApi.method ?? "GET",
        key,
        serviceKey,
        transport,
      });
    } catch {
      // Never store the raw error: it may embed the request URL (and, for
      // serpapi, the key as a query param), which redaction has not seen yet.
      results.push(result(account, "error", { reasons: [`error: network error contacting ${url.host}`] }));
      continue;
    }

    if (outcome.note !== null) {
      results.push(result(account, "no_usage_api", { reasons: [outcome.note] }));
      continue;
    }

    if (outcome.httpStatus === 401 || outcome.httpStatus === 403) {
      const sudden = previous?.last_status === "ok";
      results.push(
        result(account, "invalid_key", {
          httpStatus: outcome.httpStatus,
          isAlert: true,
          reasons: [
            sudden
              ? `invalid_key: sudden HTTP ${outcome.httpStatus} -- the last run was ok`
              : `invalid_key: HTTP ${outcome.httpStatus} from the vendor's usage API`,
          ],
        }),
      );
      nextState.accounts[account.name] = {
        vendor: account.vendor,
        last_status: "invalid_key",
        last_run_at: now.toISOString(),
        last_usage: previous?.last_usage ?? null,
        last_http_status: outcome.httpStatus,
      };
      continue;
    }

    if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) {
      results.push(
        result(account, "error", {
          httpStatus: outcome.httpStatus,
          reasons: [`error: upstream returned HTTP ${outcome.httpStatus}`],
        }),
      );
      nextState.accounts[account.name] = {
        vendor: account.vendor,
        last_status: "error",
        last_run_at: now.toISOString(),
        last_usage: previous?.last_usage ?? null,
        last_http_status: outcome.httpStatus,
      };
      continue;
    }

    // A vendor response is never trusted as-is before it reaches a result or
    // state.json: a value a vendor echoes back verbatim (seen in practice:
    // apify folding the account's own key into usageCycle.startAt -> period)
    // must go through the same run-scoped Redactor as the report.
    const usage = outcome.usage === null ? null : redactor.redactDeep(outcome.usage);

    if (usage === null || isUnparsedUsage(usage)) {
      results.push(
        result(account, "parse_error", {
          usage,
          httpStatus: outcome.httpStatus,
          isAlert: true,
          reasons: [
            "parse_error: usage could not be parsed from the response (HTTP 200, but no usable fields)",
          ],
        }),
      );
      nextState.accounts[account.name] = {
        vendor: account.vendor,
        last_status: "parse_error",
        last_run_at: now.toISOString(),
        last_usage: previous?.last_usage ?? null,
        last_http_status: outcome.httpStatus,
      };
      continue;
    }

    const sinceIso = resolveSinceIso(options.since, previous?.last_run_at, now);
    const ledgerStats = windowedLedgerStats(ledger, account.key_alias, sinceIso);
    const verdict = detectAnomaly(usage, previous?.last_usage ?? null, ledgerStats, thresholds);
    const status: AccountStatus = verdict.isAnomaly ? "usage_anomaly" : "ok";

    results.push(
      result(account, status, {
        usage,
        httpStatus: outcome.httpStatus,
        isAlert: verdict.isAnomaly,
        reasons: verdict.reasons,
      }),
    );
    nextState.accounts[account.name] = {
      vendor: account.vendor,
      last_status: status,
      last_run_at: now.toISOString(),
      last_usage: usage,
      last_http_status: outcome.httpStatus,
    };
  }

  ledger.close();

  const alertCount = results.filter((account) => account.isAlert).length;
  const reportDir = options.reportDir ?? monitorReportsDir(home);
  const reportPath = options.reportDir
    ? path.join(options.reportDir, `weekly-${localDate(now)}.md`)
    : monitorReportPath(localDate(now), reportDir);

  let notified = false;
  let notificationLine: string;
  if (alertCount === 0) {
    notificationLine = "not sent (no alerts this run)";
  } else if (options.notify === false) {
    notificationLine = `skipped (--no-notify); ${alertCount} issue(s) found`;
  } else {
    const notifier = options.notifier ?? new OsNotifier();
    const summary = results
      .filter((account) => account.isAlert)
      .map((account) => `${account.name} (${account.vendor}): ${account.status}`)
      .join("; ");
    try {
      notified = await notifier.notify({
        title: `SkeletonKey weekly check: ${alertCount} issue(s)`,
        body: redactor.redact(`${summary} -- report: ${reportPath}`),
      });
    } catch {
      notified = false;
    }
    notificationLine = notified
      ? `sent (${alertCount} issue(s))`
      : "could not be sent (no OS notifier found; see this report for the issue(s))";
  }

  const reportText = renderMonitorReport(
    {
      generatedAt: now.toISOString(),
      accounts: results,
      notificationLine,
      ...(thresholds.warnings === undefined ? {} : { thresholdWarnings: thresholds.warnings }),
    },
    redactor,
  );

  ensureHome(home);
  fs.mkdirSync(monitorDir(home), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, reportText, { mode: 0o600 });
  fs.chmodSync(reportPath, 0o600);

  writeMonitorState(nextState, home);

  return {
    generatedAt: now.toISOString(),
    reportPath,
    reportText,
    accounts: results,
    alertCount,
    notified,
    exitCode: alertCount > 0 ? EXIT.monitor_alert : EXIT.ok,
  };
}
