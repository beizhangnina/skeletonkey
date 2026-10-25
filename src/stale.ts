/**
 * `skeletonkey stale-check` -- re-reads every URL the index claims a price was
 * verified on, and says which ones moved, which ones no longer answer, and
 * which were verified too long ago to trust.
 *
 * A verified_url is a promise that someone read a number off that page on a
 * date. Pages change silently; that is exactly how an index starts lying. The
 * fingerprint is taken over the page's *visible text*, not its bytes, so a
 * rotated CSRF token or a changed asset hash does not cry wolf.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { type ApiEntry } from "./apis.js";
import { ensureHome } from "./config.js";
import { skeletonKeyHome } from "./paths.js";

export const DEFAULT_STALE_DAYS = 90;

/** Identifies itself: nvd.nist.gov and abuseipdb.com both 403 a bare client. */
export const STALE_CHECK_USER_AGENT =
  "SkeletonKey-stale-check/0.2 (local API index verification; +https://github.com/beizhangnina/skeletonkey)";

/** Whole days between two ISO dates, or null when either one is unusable. */
function ageDays(from: string | null | undefined, today: string): number | null {
  if (from === null || from === undefined) return null;
  const a = Date.parse(from);
  const b = Date.parse(today);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * How old a verified fact may be before the tools warn. Overridable per call,
 * and by `SKELETONKEY_STALE_DAYS` for a whole session.
 */
export function staleAfterDays(configured?: number | null): number {
  if (configured !== undefined && configured !== null && Number.isFinite(configured) && configured >= 0) {
    return Math.trunc(configured);
  }
  const raw = process.env.SKELETONKEY_STALE_DAYS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return DEFAULT_STALE_DAYS;
}

/** What `find_api` and `request_access` report about one row's age. */
export interface Freshness {
  checked_date: string | null;
  /** Days since `checked_date`, or null when there is no date to measure. */
  checked_age_days: number | null;
  billing_verified_date: string | null;
  billing_age_days: number | null;
  /** The window these numbers were judged against. */
  max_age_days: number;
  /** True when at least one warning fired. */
  stale: boolean;
  warnings: string[];
}

/**
 * Judges one index row on age alone -- no network, no fetching.
 *
 * Two things are worth a warning. A date that has gone past the window: a price
 * read off a vendor page eighteen months ago is a rumour, not a fact. And a
 * MISSING date on a row that presents itself as real: an example row is honest
 * about being a placeholder, and a discovered row carries `status: unverified`,
 * but a row that is neither and still has no `checked_date` has nothing behind it.
 */
export function entryFreshness(
  entry: ApiEntry,
  options: { today?: string; maxAgeDays?: number | null } = {},
): Freshness {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const maxAge = staleAfterDays(options.maxAgeDays);
  const warnings: string[] = [];

  const isExample = entry.example === true;
  const isUnverifiedDiscovery = entry.status === "unverified";
  /** A row that claims to be a real, reviewed offer. */
  const claimsVerified = !isExample && !isUnverifiedDiscovery;

  const checkedAge = ageDays(entry.checked_date, today);
  if (entry.checked_date !== null && checkedAge !== null && checkedAge > maxAge) {
    warnings.push(
      `checked_date is ${entry.checked_date}, ${checkedAge} days ago -- older than the ` +
        `${maxAge}-day window. Re-verify the row (\`skeletonkey stale-check\`) before trusting ` +
        "its facts.",
    );
  }
  if (entry.checked_date === null && claimsVerified) {
    warnings.push(
      "checked_date is null: no human has ever verified this row, so treat every fact on it " +
        "(including any price) as unchecked.",
    );
  }

  const billing = entry.billing ?? null;
  const billingAge = ageDays(billing?.verified_date ?? null, today);
  if (billing?.verified_date != null && billingAge !== null && billingAge > maxAge) {
    warnings.push(
      `billing.verified_date is ${billing.verified_date}, ${billingAge} days ago -- older than ` +
        `the ${maxAge}-day window. The billing model may have changed; re-read ` +
        `${billing.verified_url ?? "the vendor's pricing page"}.`,
    );
  }
  if (billing?.model != null && billing.verified_date == null && claimsVerified) {
    warnings.push(
      `billing.model is ${billing.model} but billing.verified_date is null: nobody recorded when ` +
        "(or whether) that was read off a vendor page.",
    );
  }

  return {
    checked_date: entry.checked_date,
    checked_age_days: checkedAge,
    billing_verified_date: billing?.verified_date ?? null,
    billing_age_days: billingAge,
    max_age_days: maxAge,
    stale: warnings.length > 0,
    warnings,
  };
}

export interface StaleTarget {
  /** Index row the URL belongs to. */
  entry: string;
  /** Which field holds it, e.g. `billing.verified_url`. */
  field: string;
  url: string;
  /** The date the row claims it was verified, when it claims one. */
  verified_date: string | null;
  /** The value that was read off the page, for the report. */
  claim: string | null;
}

export type StaleStatus = "ok" | "new" | "changed" | "unreachable" | "old" | "undated";

export interface StaleFinding extends StaleTarget {
  status: StaleStatus;
  http_status: number | null;
  age_days: number | null;
  /** Short explanation, in the terms the CLI prints. */
  detail: string;
  fingerprint: string | null;
  previous_fingerprint: string | null;
}

export interface StaleCache {
  version: 1;
  urls: Record<string, { fingerprint: string; http_status: number; checked: string; bytes: number }>;
}

export interface FetchResult {
  status: number;
  /** Response body, or "" when the fetch failed. */
  body: string;
  error?: string;
}

export type UrlFetcher = (url: string) => Promise<FetchResult>;

export function staleCachePath(home = skeletonKeyHome()): string {
  return path.join(home, "stale-check.json");
}

export function readStaleCache(file: string): StaleCache {
  if (!fs.existsSync(file)) return { version: 1, urls: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return { version: 1, urls: {} };
    const urls = (parsed as Record<string, unknown>)["urls"];
    if (urls === null || typeof urls !== "object") return { version: 1, urls: {} };
    return { version: 1, urls: urls as StaleCache["urls"] };
  } catch {
    // A corrupt cache is a first run, not a failure.
    return { version: 1, urls: {} };
  }
}

export function writeStaleCache(file: string, cache: StaleCache): void {
  ensureHome(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/**
 * Visible-text fingerprint: scripts, styles, and tags stripped, whitespace
 * collapsed. Two renders of an unchanged pricing page hash the same even when
 * the HTML around the numbers has been rebuilt.
 */
export function fingerprint(body: string): string {
  const text = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    // Machine-generated "now" stamps, which some pages and most JSON payloads
    // embed: NVD's CVE response carries a fresh `timestamp` on every request, so
    // hashing it raw would report "changed" forever. Only full timestamps go --
    // a bare date is left alone, because "prices effective 2026-11-01" IS news.
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, " ")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Every price URL the index claims, one finding target per URL. */
export function staleTargets(entries: ApiEntry[]): StaleTarget[] {
  const targets: StaleTarget[] = [];
  for (const entry of entries) {
    const billing = entry.billing ?? null;
    if (billing?.verified_url != null) {
      targets.push({
        entry: entry.name,
        field: "billing.verified_url",
        url: billing.verified_url,
        verified_date: billing.verified_date ?? null,
        claim: billing.model,
      });
    }
    if (billing?.x402_url != null) {
      targets.push({
        entry: entry.name,
        field: "billing.x402_url",
        url: billing.x402_url,
        verified_date: billing.verified_date ?? null,
        claim: "accepts x402",
      });
    }
    for (const carrier of entry.aggregators ?? []) {
      if (carrier.price_verified_url == null) continue;
      targets.push({
        entry: entry.name,
        field: `aggregators[${carrier.name}].price_verified_url`,
        url: carrier.price_verified_url,
        verified_date: billing?.verified_date ?? entry.checked_date,
        claim:
          carrier.per_call_price === null ? "carries, no price published" : `$${carrier.per_call_price}/call`,
      });
    }
  }
  return targets;
}

export interface StaleCheckOptions {
  entries: ApiEntry[];
  cache: StaleCache;
  /** Omit to skip the network entirely and report dates only. */
  fetchUrl?: UrlFetcher | null;
  maxAgeDays?: number;
  today?: string;
  /** Only check rows whose name contains this (case-insensitive). */
  only?: string | null;
}

export interface StaleCheckResult {
  findings: StaleFinding[];
  cache: StaleCache;
  counts: Record<StaleStatus, number>;
  /** True when something needs a human: a page moved or stopped answering. */
  needs_attention: boolean;
  fetched: boolean;
}

/**
 * Re-checks every target. Pure except for the injected fetcher, so the tests
 * drive it against a local server and the CLI drives it against the internet.
 */
export async function runStaleCheck(options: StaleCheckOptions): Promise<StaleCheckResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const maxAge = options.maxAgeDays ?? DEFAULT_STALE_DAYS;
  const only = options.only?.trim().toLowerCase() ?? "";
  const cache: StaleCache = { version: 1, urls: { ...options.cache.urls } };
  const findings: StaleFinding[] = [];

  const targets = staleTargets(options.entries).filter(
    (target) => only === "" || target.entry.toLowerCase().includes(only),
  );

  // Several rows cite the same page (one aggregator catalog backs every
  // carriage claim). Fetch each URL ONCE: hammering a page seven times is rude,
  // and comparing it against itself mid-run reports "changed" for any page whose
  // text flaps between requests, which is a bug, not a finding.
  const byUrl = new Map<string, FetchResult>();
  if (options.fetchUrl != null) {
    for (const url of new Set(targets.map((target) => target.url))) {
      byUrl.set(url, await options.fetchUrl(url));
    }
  }
  /** Fingerprints from the PREVIOUS run, so the cache we build cannot shadow them. */
  const baseline = new Map(
    Object.entries(options.cache.urls).map(([url, record]) => [url, record.fingerprint]),
  );

  for (const target of targets) {
    const age = ageDays(target.verified_date, today);
    const previous = baseline.get(target.url) ?? null;

    if (options.fetchUrl == null) {
      findings.push({
        ...target,
        status: target.verified_date === null ? "undated" : age !== null && age > maxAge ? "old" : "ok",
        http_status: null,
        age_days: age,
        detail:
          target.verified_date === null
            ? "no verified_date recorded, so staleness cannot be judged"
            : age !== null && age > maxAge
              ? `verified ${age} days ago, older than the ${maxAge}-day window (not re-fetched)`
              : `verified ${age} days ago (not re-fetched)`,
        fingerprint: previous,
        previous_fingerprint: previous,
      });
      continue;
    }

    const response = byUrl.get(target.url) ?? { status: 0, body: "", error: "not fetched" };
    if (response.error !== undefined || response.status < 200 || response.status >= 400) {
      findings.push({
        ...target,
        status: "unreachable",
        http_status: response.error === undefined ? response.status : null,
        age_days: age,
        detail:
          response.error === undefined
            ? `HTTP ${response.status}: the page the price was read from no longer answers`
            : `fetch failed: ${response.error}`,
        fingerprint: null,
        previous_fingerprint: previous,
      });
      continue;
    }

    const current = fingerprint(response.body);
    cache.urls[target.url] = {
      fingerprint: current,
      http_status: response.status,
      checked: today,
      bytes: response.body.length,
    };

    if (previous === null) {
      findings.push({
        ...target,
        status: target.verified_date !== null && age !== null && age > maxAge ? "old" : "new",
        http_status: response.status,
        age_days: age,
        detail:
          `first fingerprint recorded; nothing to compare against yet` +
          (age !== null && age > maxAge ? `, and the row was verified ${age} days ago` : ""),
        fingerprint: current,
        previous_fingerprint: null,
      });
      continue;
    }

    if (previous !== current) {
      findings.push({
        ...target,
        status: "changed",
        http_status: response.status,
        age_days: age,
        detail:
          "the visible text of this page changed since the last check -- re-read the price and " +
          "update billing.verified_date, or set the field back to null",
        fingerprint: current,
        previous_fingerprint: previous,
      });
      continue;
    }

    findings.push({
      ...target,
      status: age !== null && age > maxAge ? "old" : "ok",
      http_status: response.status,
      age_days: age,
      detail:
        age !== null && age > maxAge
          ? `page unchanged, but verified ${age} days ago (older than ${maxAge} days)`
          : "page unchanged since the last check",
      fingerprint: current,
      previous_fingerprint: previous,
    });
  }

  const counts: Record<StaleStatus, number> = {
    ok: 0,
    new: 0,
    changed: 0,
    unreachable: 0,
    old: 0,
    undated: 0,
  };
  for (const finding of findings) counts[finding.status] += 1;

  return {
    findings,
    cache,
    counts,
    needs_attention: counts.changed > 0 || counts.unreachable > 0,
    fetched: options.fetchUrl != null,
  };
}

/** The real fetcher. Follows redirects, identifies itself, never sends a key. */
export function httpFetcher(timeoutMs = 20_000): UrlFetcher {
  return async (url: string): Promise<FetchResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": STALE_CHECK_USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
        signal: controller.signal,
      });
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      return { status: 0, body: "", error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
}
