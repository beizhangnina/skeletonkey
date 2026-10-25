/**
 * Executing an aggregator route: what happens after the **second** approval (D14).
 *
 * The first approval asks the human about direct signup with the vendor. When
 * that ends in a handoff, the runner raises a second approval -- route this
 * vendor through the cheapest aggregator that publishes a verified per-call
 * price instead? -- and this module is what that second yes actually does.
 *
 * The rules it exists to keep:
 *
 *   - the aggregator endpoints are a fixed catalog **in code**. An agent names
 *     no host here: it can only ever end up at one of the three below (or at a
 *     base URL a human configured locally, which is how the tests point it at a
 *     fake server);
 *   - the aggregator's key is resolved exactly like any other key -- found in
 *     the keys index by domain, read out of the vault by the runner, injected
 *     into the request header by the runner. No verb returns it, no log line
 *     carries it, and the agent never sees it;
 *   - no key, no route. The request ends `needs_human` with the aggregator's
 *     own signup URL, never with a guessed credential and never with a silent
 *     direct call instead;
 *   - a route is only taken at a price that came with a URL somebody read it
 *     off (`per_call_price` + `price_verified_url`). An aggregator that
 *     publishes no comparable per-call price is not routable: unknown is not
 *     zero, and the caps cannot be checked against a number nobody has.
 *
 * Payment is fiat only. Every endpoint here is `rail: "fiat"` and nothing else
 * is routable -- there is no wallet anywhere in SkeletonKey.
 */
import { AGGREGATOR_NAMES, type AggregatorName, type ApiEntry } from "./apis.js";
import { domainMatches, normalizeDomain } from "./keys.js";
import { pricedCarriers, unpricedCarriers } from "./routing.js";
import { globalRedactor } from "./redact.js";
import type { KeyMeta } from "./types.js";

/** One aggregator's call surface, as SkeletonKey reaches it. */
export interface AggregatorEndpoint {
  name: AggregatorName;
  /** Fiat only. A non-fiat rail is not routable and none exists. */
  rail: "fiat";
  /** Where calls go. A human may point this elsewhere locally; an agent cannot. */
  base_url: string;
  /** POST path for one provider call. `{provider}` is substituted. */
  call_path: string;
  /** Header the aggregator's key goes in, and the value template around it. */
  auth_header: string;
  auth_format: string;
  /**
   * Where a human signs up and tops the account up with a card. The site root:
   * SkeletonKey does not guess a deeper signup path it has not read.
   */
  signup_url: string;
  /** The public catalog the index's carriage and prices were read from. */
  catalog_url: string;
}

/**
 * The three catalogs the index records carriage for. Hosts and catalog URLs are
 * the ones `apis.yaml` already cites in `price_verified_url`; `call_path` is the
 * provider-call route SkeletonKey posts to. A catalog that answers a different
 * shape fails as its own 4xx, which the runner reports -- it never turns into a
 * call made somewhere else.
 */
export const AGGREGATOR_ENDPOINTS: Readonly<Record<AggregatorName, AggregatorEndpoint>> = {
  monid: {
    name: "monid",
    rail: "fiat",
    base_url: "https://api.monid.ai",
    call_path: "/v1/call/{provider}",
    auth_header: "Authorization",
    auth_format: "Bearer {key}",
    signup_url: "https://monid.ai/",
    catalog_url: "https://api.monid.ai/public/v1/providers",
  },
  glasser: {
    name: "glasser",
    rail: "fiat",
    base_url: "https://api.glasser.ai",
    call_path: "/v1/run/{provider}",
    auth_header: "Authorization",
    auth_format: "Bearer {key}",
    signup_url: "https://glasser.ai/",
    catalog_url: "https://api.glasser.ai/public/catalog",
  },
  flatkey: {
    name: "flatkey",
    rail: "fiat",
    base_url: "https://api.flatkey.ai",
    call_path: "/v1/call/{provider}",
    auth_header: "Authorization",
    auth_format: "Bearer {key}",
    signup_url: "https://flatkey.ai/",
    catalog_url: "https://flatkey.ai/models",
  },
};

export function isAggregatorName(value: string): value is AggregatorName {
  return (AGGREGATOR_NAMES as readonly string[]).includes(value.trim().toLowerCase());
}

/**
 * The endpoint for a name as the index or an approval spells it ("Monid"), with
 * an optional local base-URL override keyed by the same lowercased name.
 */
export function aggregatorEndpoint(
  name: string | null,
  baseUrls: Record<string, string> = {},
): AggregatorEndpoint | null {
  if (name === null) return null;
  const key = name.trim().toLowerCase();
  if (!isAggregatorName(key)) return null;
  const endpoint = AGGREGATOR_ENDPOINTS[key as AggregatorName];
  const override = baseUrls[key];
  if (override === undefined || override.trim() === "") return endpoint;
  return { ...endpoint, base_url: override.trim().replace(/\/+$/, "") };
}

/** Host the aggregator's key is registered against, override included. */
export function aggregatorDomain(endpoint: AggregatorEndpoint): string {
  try {
    return normalizeDomain(new URL(endpoint.base_url).host);
  } catch {
    return "";
  }
}

/**
 * The provider slug a catalog addresses the vendor by: the vendor's own name in
 * its domain where there is one (`api.apollo.io` -> `apollo`), else the index
 * row's name slugified. A slug the catalog does not know comes back as its 404.
 */
export function providerSlug(vendor: string, domain?: string | null): string {
  const host = domain === null || domain === undefined ? "" : normalizeDomain(domain);
  const labels = host.split(".").filter((label) => label !== "");
  // api.apollo.io -> apollo; apollo.io -> apollo. An IP literal has no name.
  if (labels.length >= 2 && !/^[\d.]+$/.test(host)) {
    const name = labels[labels.length - 2];
    if (name !== undefined && name !== "" && name !== "api") return name;
  }
  return (
    vendor
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/** One routable aggregator: an endpoint plus the verified price behind it. */
export interface AggregatorCandidate {
  name: string;
  endpoint: AggregatorEndpoint;
  /** Verified per-call price in USD. Never null: an unpriced route is not taken. */
  per_call_price_usd: number;
  price_verified_url: string | null;
}

/** The chosen route, with the value the runner will inject. Never leaves it. */
export interface AggregatorChoice {
  candidate: AggregatorCandidate;
  key: KeyMeta;
  /** Read from the vault by the runner. Registered with the redactor by it too. */
  secret: string;
}

export interface AggregatorSelection {
  /** Routable aggregators, cheapest verified price first. */
  candidates: AggregatorCandidate[];
  /** The cheapest candidate a key is configured for, or null when none is. */
  chosen: AggregatorChoice | null;
  /** One line per candidate that was passed over. Never carries a value. */
  notes: string[];
}

export interface SelectAggregatorOptions {
  /** The vendor's index row, or null when the vendor is not in the index. */
  entry: ApiEntry | null;
  /** The keys index, exactly as the proxy reads it. */
  keys: KeyMeta[];
  /** The runner's vault read. Returns null when the vault holds no such value. */
  readSecret(alias: string): Promise<string | null>;
  baseUrls?: Record<string, string>;
}

/**
 * Picks the cheapest configured fiat aggregator for a vendor.
 *
 * Candidates come from the index row's own `aggregators` block, filtered to
 * those that carry the vendor at a verified per-call price (`pricedCarriers`
 * already sorts them cheapest-first with a deterministic tie-break). The
 * approval never substitutes for current carriage and pricing in the API index.
 */
export async function selectAggregator(
  options: SelectAggregatorOptions,
): Promise<AggregatorSelection> {
  const baseUrls = options.baseUrls ?? {};
  const notes: string[] = [];
  const candidates: AggregatorCandidate[] = [];
  const seen = new Set<string>();

  const add = (
    name: string,
    price: number | null,
    verifiedUrl: string | null,
    source: string,
  ): void => {
    const endpoint = aggregatorEndpoint(name, baseUrls);
    if (endpoint === null) {
      notes.push(
        `${name} is not in SkeletonKey's aggregator catalog (${AGGREGATOR_NAMES.join(", ")}), so ` +
          "there is no endpoint to route to.",
      );
      return;
    }
    if (endpoint.rail !== "fiat") {
      notes.push(`${endpoint.name} is not a fiat rail, so it is not routable.`);
      return;
    }
    if (seen.has(endpoint.name)) return;
    if (price === null || !Number.isFinite(price) || price < 0 || !verifiedUrl?.trim()) {
      notes.push(
        `${endpoint.name} (${source}) publishes no comparable per-call price for this vendor, so ` +
          "the caps cannot be checked against it and the route is not taken. Unknown is not zero.",
      );
      return;
    }
    seen.add(endpoint.name);
    candidates.push({
      name: endpoint.name,
      endpoint,
      per_call_price_usd: price,
      price_verified_url: verifiedUrl,
    });
  };

  for (const carrier of pricedCarriers(options.entry)) {
    add(carrier.name, carrier.per_call_price, carrier.price_verified_url ?? null, "API index");
  }
  for (const carrier of unpricedCarriers(options.entry)) {
    // Carried, but with no comparable per-call price, so the caps cannot be
    // checked against it. Said out loud rather than quietly left out.
    notes.push(
      `${carrier.name} carries this vendor but publishes no comparable per-call price ` +
        "(per_call_price: null), so there is no number to check the caps against and the route is " +
        "not taken. Unknown is not zero." +
        (carrier.price_note == null ? "" : ` ${carrier.price_note}`),
    );
  }
  for (const candidate of candidates) {
    const domain = aggregatorDomain(candidate.endpoint);
    const matches = options.keys.filter((key) => domainMatches(key.domain, domain));
    const enabled = matches.find((key) => !key.disabled);
    if (enabled === undefined) {
      notes.push(
        matches.length === 0
          ? `No key for ${candidate.name} is in the keys index for ${domain}, so nothing can be ` +
            "routed through it."
          : `The key for ${candidate.name} (${matches[0]?.alias}) is disabled, so the runner will ` +
            "not use it. Only a human re-enables a key.",
      );
      continue;
    }
    for (const key of matches.filter((item) => !item.disabled)) {
      const secret = await options.readSecret(key.alias);
      if (secret !== null && secret !== "") {
        return { candidates, chosen: { candidate, key, secret }, notes };
      }
      notes.push(
        `${key.alias} is in the keys index for ${candidate.name} but the vault holds no value ` +
          "for it, so there is no key to inject.",
      );
    }
  }

  return { candidates, chosen: null, notes };
}

/**
 * What the human is told when no aggregator key is configured: where to sign up
 * (fiat, their own card) and the one command that puts the key in the vault.
 * The agent is not asked to do any of it, and never sees the key afterwards.
 */
export function signupInstructions(candidates: AggregatorCandidate[]): string[] {
  if (candidates.length === 0) {
    return [
      "No aggregator in SkeletonKey's catalog publishes a verified per-call price for this " +
        "vendor, so there is no aggregator route to configure. The alternatives are the vendor's " +
        "own subscription or dropping the call.",
    ];
  }
  return candidates.map((candidate) => {
    const domain = aggregatorDomain(candidate.endpoint);
    return (
      `${candidate.name}: sign up at ${candidate.endpoint.signup_url} and top it up with your own ` +
      `card (fiat only -- there is no crypto rail), then store the key with \`skeletonkey add ` +
      `${candidate.name} --domain ${domain} --header ${candidate.endpoint.auth_header} --format ` +
      `'${candidate.endpoint.auth_format}'\`. The runner reads it from the vault for every call; ` +
      `the agent never sees it. Published price: $${candidate.per_call_price_usd} per call` +
      (candidate.price_verified_url === null ? "." : ` (verified: ${candidate.price_verified_url}).`)
    );
  });
}

// --- the call itself -------------------------------------------------------

/** The three headers the proxy already accepts as a self-reported price. */
const COST_HEADERS = ["x-skeletonkey-cost-usd", "x-cost-usd", "x-request-cost-usd"];

/** Enough of the aggregator's answer to be useful; never the whole payload. */
export const MAX_RESULT_CHARS = 2000;

export interface AggregatorCallResult {
  /** True on a 2xx. */
  ok: boolean;
  /** Null when the request never got an answer at all. */
  http_status: number | null;
  /** Bytes of body read, for the ledger row. */
  bytes: number;
  /** What the aggregator said the call cost, when it said. Null otherwise. */
  cost_usd: number | null;
  /** The answer, truncated. Written through the runner's redactor. */
  body: string;
  /** One line for the log and the request's reason. Never a credential. */
  reason: string;
}

export interface AggregatorCallOptions {
  endpoint: AggregatorEndpoint;
  /** The value out of the vault. Injected into one header and nothing else. */
  secret: string;
  provider: string;
  vendor: string;
  purpose: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The URL one provider call goes to. Exported so a test can assert it. */
export function aggregatorCallUrl(endpoint: AggregatorEndpoint, provider: string): string {
  const base = endpoint.base_url.replace(/\/+$/, "");
  const path = endpoint.call_path.replace("{provider}", encodeURIComponent(provider));
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Posts one call to the aggregator with the key in its documented header.
 *
 * The key is a parameter and a header value here, and nowhere else: not in the
 * URL, not in the body, not in the returned `reason`, not in a thrown message.
 */
export async function callAggregator(
  options: AggregatorCallOptions,
): Promise<AggregatorCallResult> {
  const { endpoint } = options;
  const url = aggregatorCallUrl(endpoint, options.provider);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  timer.unref?.();

  globalRedactor.add(options.secret);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: {
        [endpoint.auth_header]: endpoint.auth_format.replace("{key}", options.secret),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        provider: options.provider,
        vendor: options.vendor,
        purpose: options.purpose,
      }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    // Transport errors can contain credentials; expose only a fixed message.
    return {
      ok: false,
      http_status: null,
      bytes: 0,
      cost_usd: null,
      body: "",
      reason: `${endpoint.name} did not complete the request. The outcome is unknown.`,
    };
  } finally {
    clearTimeout(timer);
  }

  const bytes = Buffer.byteLength(text);
  const safeText = globalRedactor.redact(text);
  const body =
    safeText.length > MAX_RESULT_CHARS
      ? `${safeText.slice(0, MAX_RESULT_CHARS)}... [truncated, ${bytes} bytes in total]`
      : safeText;
  return {
    ok: response.ok,
    http_status: response.status,
    bytes,
    cost_usd: reportedCost(response, text),
    body,
    reason: `${endpoint.name} answered ${response.status} for ${options.provider}.`,
  };
}

/** A price the aggregator reported: a cost header, else a `cost_usd` in a JSON body. */
function reportedCost(response: Response, text: string): number | null {
  for (const name of COST_HEADERS) {
    const raw = response.headers.get(name);
    if (raw !== null && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  if (text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)["cost_usd"];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
  } catch {
    // A body that is not JSON simply reports no cost.
  }
  return null;
}
