/**
 * The first-wave checker registry (ND-5): one entry per vendor whose official
 * usage/quota API this tool knows how to call and parse.
 *
 * A vendor with `usage_api.available: true` but no entry here is reported as
 * "no checker implemented yet", never silently skipped -- see
 * `src/monitor/run.ts`. Every checker sends the key to exactly one
 * hardcoded host; the caller asserts `usage_api.path`'s host matches before
 * ever constructing a request (defense in depth against an edited index
 * redirecting a key to a different host).
 */
import type { CheckerInput, CheckerOutcome, HttpTransport, NormalizedUsage, VendorChecker } from "./types.js";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The real transport: a `fetch` wrapper that follows redirects itself instead
 * of letting `fetch` auto-follow them.
 *
 * `fetch`'s own redirect-follow strips `Authorization`/`Cookie`/
 * `Proxy-Authorization` on a cross-origin hop, but leaves any other header --
 * including the custom `x-api-key` apollo and exa send the account's key in
 * -- untouched, so it travels straight to whatever host the redirect names.
 * Following manually lets every header be dropped on a cross-origin hop,
 * whatever it is named.
 */
export const defaultTransport: HttpTransport = async (url, init) => {
  let currentUrl = url;
  let currentInit: RequestInit = { ...(init as RequestInit) };
  let currentOrigin = new URL(url).origin;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(currentUrl, { ...currentInit, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { status: response.status, text: () => response.text() };
    }
    const location = response.headers.get("location");
    if (location === null) {
      return { status: response.status, text: () => response.text() };
    }
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== currentOrigin) {
      // Never forward credentials (or anything else) to a different origin.
      currentInit = { method: currentInit.method };
    }
    currentUrl = nextUrl.toString();
    currentOrigin = nextUrl.origin;
  }
  throw new Error(`too many redirects fetching ${new URL(url).host}`);
};

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

// --- apify: GET /v2/users/me/usage/monthly, Authorization: Bearer <key> ---

function parseApify(body: string): NormalizedUsage | null {
  const json = parseJson(body);
  if (json === null) return null;
  const data = (json["data"] as Record<string, unknown> | undefined) ?? {};
  const used = num(data["monthlyUsageUsd"]) ?? num(data["totalUsageUsd"]);
  const cycle = data["usageCycle"] as Record<string, unknown> | undefined;
  const startAt = cycle?.["startAt"];
  const endAt = cycle?.["endAt"];
  const period =
    typeof startAt === "string" && typeof endAt === "string" ? `${startAt}..${endAt}` : null;
  return { used, limit: null, remaining: null, unit: used === null ? null : "USD", period };
}

async function runApify(input: CheckerInput): Promise<CheckerOutcome> {
  const response = await input.transport(input.url, {
    method: input.method,
    headers: { Authorization: `Bearer ${input.key}` },
  });
  const body = await response.text();
  return {
    httpStatus: response.status,
    usage: ok2xx(response.status) ? parseApify(body) : null,
    note: null,
  };
}

// --- serpapi: GET /account.json?api_key=<key> (the key is a query param) --

function parseSerpapi(body: string): NormalizedUsage | null {
  const json = parseJson(body);
  if (json === null) return null;
  return {
    used: num(json["this_month_usage"]),
    limit: num(json["searches_per_month"]),
    remaining: num(json["plan_searches_left"]),
    unit: "searches",
    period: "month",
  };
}

async function runSerpapi(input: CheckerInput): Promise<CheckerOutcome> {
  const url = new URL(input.url);
  url.searchParams.set("api_key", input.key);
  const response = await input.transport(url.toString(), { method: input.method });
  const body = await response.text();
  return {
    httpStatus: response.status,
    usage: ok2xx(response.status) ? parseSerpapi(body) : null,
    note: null,
  };
}

// --- firecrawl: GET /v2/team/credit-usage, Authorization: Bearer <key> ----

function parseFirecrawl(body: string): NormalizedUsage | null {
  const json = parseJson(body);
  if (json === null) return null;
  const data = (json["data"] as Record<string, unknown> | undefined) ?? json;
  const remaining = num(data["remainingCredits"]);
  const limit = num(data["planCredits"]);
  const used = remaining !== null && limit !== null ? limit - remaining : null;
  return { used, limit, remaining, unit: "credits", period: null };
}

async function runFirecrawl(input: CheckerInput): Promise<CheckerOutcome> {
  const response = await input.transport(input.url, {
    method: input.method,
    headers: { Authorization: `Bearer ${input.key}` },
  });
  const body = await response.text();
  return {
    httpStatus: response.status,
    usage: ok2xx(response.status) ? parseFirecrawl(body) : null,
    note: null,
  };
}

// --- apollo: POST /api/v1/usage_stats/credit_usage_stats, x-api-key -------

function parseApollo(body: string): NormalizedUsage | null {
  const json = parseJson(body);
  if (json === null) return null;
  return {
    used: num(json["used_credits"]),
    limit: null,
    remaining: num(json["available_credits"]),
    unit: "credits",
    period: null,
  };
}

async function runApollo(input: CheckerInput): Promise<CheckerOutcome> {
  const response = await input.transport(input.url, {
    method: input.method,
    headers: { "x-api-key": input.key, "content-type": "application/json" },
    body: "{}",
  });
  const body = await response.text();
  return {
    httpStatus: response.status,
    usage: ok2xx(response.status) ? parseApollo(body) : null,
    note: null,
  };
}

// --- exa: GET /team-management/credits, x-api-key: <SERVICE key> ----------

function parseExa(body: string): NormalizedUsage | null {
  const json = parseJson(body);
  if (json === null) return null;
  return {
    used: num(json["credits_used"]),
    limit: num(json["credits_limit"]),
    remaining: num(json["credits_remaining"]),
    unit: "credits",
    period: null,
  };
}

async function runExa(input: CheckerInput): Promise<CheckerOutcome> {
  if (input.serviceKey === null || input.serviceKey === undefined) {
    return {
      httpStatus: 0,
      usage: null,
      note: "requires Team Management service key",
    };
  }
  const response = await input.transport(input.url, {
    method: input.method,
    headers: { "x-api-key": input.serviceKey },
  });
  const body = await response.text();
  return {
    httpStatus: response.status,
    usage: ok2xx(response.status) ? parseExa(body) : null,
    note: null,
  };
}

// --- github: GET /rate_limit, Authorization: Bearer <key> -----------------

function parseGithub(body: string): NormalizedUsage | null {
  const json = parseJson(body);
  if (json === null) return null;
  const rate = (json["rate"] as Record<string, unknown> | undefined) ?? {};
  const limit = num(rate["limit"]);
  const remaining = num(rate["remaining"]);
  const used = num(rate["used"]) ?? (limit !== null && remaining !== null ? limit - remaining : null);
  return { used, limit, remaining, unit: "requests", period: "hour" };
}

async function runGithub(input: CheckerInput): Promise<CheckerOutcome> {
  const response = await input.transport(input.url, {
    method: input.method,
    headers: { Authorization: `Bearer ${input.key}`, "user-agent": "SkeletonKey-monitor" },
  });
  const body = await response.text();
  return {
    httpStatus: response.status,
    usage: ok2xx(response.status) ? parseGithub(body) : null,
    note: null,
  };
}

/** Vendor id (matching an account's `vendor` field, lower-case) -> checker. */
export const CHECKERS: Record<string, VendorChecker> = {
  apify: { host: "api.apify.com", run: runApify },
  serpapi: { host: "serpapi.com", run: runSerpapi },
  firecrawl: { host: "api.firecrawl.dev", run: runFirecrawl },
  apollo: { host: "api.apollo.io", run: runApollo },
  exa: { host: "admin-api.exa.ai", needsServiceKey: true, run: runExa },
  github: { host: "api.github.com", run: runGithub },
};
