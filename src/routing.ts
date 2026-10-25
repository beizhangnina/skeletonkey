/**
 * Which way to reach a vendor: the vendor directly, through an aggregator that
 * resells it per call, or over x402 with no account at all.
 *
 * Every number this module reasons about has to have come with a URL it was
 * read from (`billing.verified_url`, `aggregators[].price_verified_url`). When
 * one does not, the decision still gets made but the reason says the words
 * **price unverified** -- an agent is never handed a confident route backed by a
 * number nobody checked.
 */
import {
  AGGREGATOR_NAMES,
  type AggregatorCarriage,
  type ApiEntry,
  type BillingModel,
} from "./apis.js";

export type RouteKind = "direct" | "aggregator" | "x402" | "unknown";

export interface RouteOption {
  route: RouteKind;
  /** Aggregator name for `aggregator`, else null. */
  via: string | null;
  per_call_price_usd: number | null;
  price_verified_url: string | null;
  reason: string;
}

export interface RoutingDecision extends RouteOption {
  /** Other routes that exist, cheapest-verified first. */
  alternatives: RouteOption[];
  billing_model: BillingModel | null;
  billing_verified_url: string | null;
  billing_verified_date: string | null;
  /** True when no verified price backs the chosen route. */
  price_unverified: boolean;
  notes: string[];
}

/** The literal an agent can grep for. Also asserted by the test suite. */
export const PRICE_UNVERIFIED = "price unverified";

/** Days after which a verified billing fact is reported as worth re-checking. */
export const DEFAULT_MAX_AGE_DAYS = 90;

/** Carrying aggregators that publish a per-call price with a URL behind it. */
export function pricedCarriers(entry: ApiEntry | null): AggregatorCarriage[] {
  const list = entry?.aggregators ?? [];
  return list
    .filter(
      (item) =>
        item.carries &&
        item.per_call_price !== null &&
        item.per_call_price !== undefined &&
        typeof item.price_verified_url === "string",
    )
    .sort((a, b) => {
      const byPrice = (a.per_call_price ?? 0) - (b.per_call_price ?? 0);
      if (byPrice !== 0) return byPrice;
      // Deterministic tie-break: catalog order as declared in AGGREGATOR_NAMES.
      return AGGREGATOR_NAMES.indexOf(a.name) - AGGREGATOR_NAMES.indexOf(b.name);
    });
}

/** Aggregators that carry the provider but publish no comparable price. */
export function unpricedCarriers(entry: ApiEntry | null): AggregatorCarriage[] {
  return (entry?.aggregators ?? []).filter(
    (item) => item.carries && (item.per_call_price === null || item.per_call_price === undefined),
  );
}

/** Prints the price exactly as recorded: these are genuinely tiny numbers and
 * rounding $0.026 to $0.03 would overstate it by 15 %. */
function money(value: number): string {
  return `$${value}`;
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function aggregatorOption(carrier: AggregatorCarriage, why: string): RouteOption {
  return {
    route: "aggregator",
    via: carrier.name,
    per_call_price_usd: carrier.per_call_price,
    price_verified_url: carrier.price_verified_url,
    reason: why,
  };
}

function x402Option(entry: ApiEntry, carriers: AggregatorCarriage[]): RouteOption | null {
  const vendorUrl = entry.billing?.x402_url ?? null;
  const viaCarrier = carriers.find((item) => item.carries && item.x402 === true);
  if (entry.billing?.model === "x402" || entry.access_mode === "x402") {
    return {
      route: "x402",
      via: null,
      per_call_price_usd: null,
      price_verified_url: vendorUrl,
      reason:
        `The index records ${entry.name} as an x402 endpoint, so a wallet can pay per call with no ` +
        "account and no key for SkeletonKey to hold. Nothing to sign up for; nothing to inject.",
    };
  }
  if (vendorUrl !== null) {
    return {
      route: "x402",
      via: null,
      per_call_price_usd: null,
      price_verified_url: vendorUrl,
      reason:
        `${entry.name} documents accepting x402/agentic payment on its own page (${vendorUrl}), so an ` +
        "agent with a wallet can pay per call instead of holding a key. Per-call cost not published " +
        `there, so ${PRICE_UNVERIFIED}.`,
    };
  }
  if (viaCarrier !== undefined) {
    return {
      route: "x402",
      via: viaCarrier.name,
      per_call_price_usd: viaCarrier.per_call_price,
      price_verified_url: viaCarrier.price_verified_url,
      reason:
        `${viaCarrier.name} accepts x402 for ${entry.name}, so a wallet can pay per call through the ` +
        "aggregator with no vendor account.",
    };
  }
  return null;
}

/**
 * Picks a route for one index row.
 *
 * The rules, in order:
 *   1. a key already in the vault wins -- the route is the proxy;
 *   2. x402 as the vendor's own access mode or model => x402, which needs no
 *      account and so no verified subscription price at all;
 *   3. no billing model recorded => `unknown` (null is "nobody checked");
 *   4. `free`, `payg`, `free_tier+payg` => direct;
 *   5. a free tier that verifiably covers the API => direct;
 *   6. otherwise direct needs a monthly subscription => the cheapest carrying
 *      aggregator with a VERIFIED per-call price;
 *   7. no such aggregator => direct, flagged `price unverified`.
 */
export function routeAccess(
  entry: ApiEntry | null,
  options: { hasKey?: boolean; today?: string; maxAgeDays?: number } = {},
): RoutingDecision {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const maxAge = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const notes: string[] = [];

  if (entry === null) {
    return {
      route: "unknown",
      via: null,
      per_call_price_usd: null,
      price_verified_url: null,
      reason:
        "Not in the API index, so there is no billing model, no aggregator carriage, and no " +
        `${PRICE_UNVERIFIED}. Call discover_api to research the vendor, then propose_entry.`,
      alternatives: [],
      billing_model: null,
      billing_verified_url: null,
      billing_verified_date: null,
      price_unverified: true,
      notes: ["A missing row is not a free API. Treat every cost as unknown."],
    };
  }

  const billing = entry.billing ?? null;
  const model = billing?.model ?? null;
  const priced = pricedCarriers(entry);
  const unpriced = unpricedCarriers(entry);
  const x402 = x402Option(entry, [...priced, ...unpriced]);

  if (billing?.verified_date != null && billing.verified_url != null) {
    const age = daysBetween(billing.verified_date, today);
    if (age !== null && age > maxAge) {
      notes.push(
        `Billing was verified ${age} days ago (${billing.verified_date}) on ${billing.verified_url}; ` +
          "that is older than the " +
          `${maxAge}-day window. Run \`skeletonkey stale-check\` before trusting it.`,
      );
    }
  }
  if (billing !== null && billing.model !== null && billing.verified_url === null) {
    notes.push(
      `billing.model is ${billing.model} but billing.verified_url is null: the model was never read ` +
        `off a vendor page, so ${PRICE_UNVERIFIED}.`,
    );
  }
  for (const carrier of unpriced) {
    notes.push(
      `${carrier.name} carries ${entry.name} but publishes no comparable per-call price ` +
        `(per_call_price: null), so ${PRICE_UNVERIFIED} for that route.` +
        (carrier.price_note == null ? "" : ` ${carrier.price_note}`),
    );
  }

  const directOption = (reason: string): RouteOption => ({
    route: "direct",
    via: null,
    per_call_price_usd: null,
    price_verified_url: billing?.verified_url ?? null,
    reason,
  });

  const finish = (chosen: RouteOption, rest: (RouteOption | null)[]): RoutingDecision => ({
    ...chosen,
    alternatives: rest.filter((item): item is RouteOption => item !== null),
    billing_model: model,
    billing_verified_url: billing?.verified_url ?? null,
    billing_verified_date: billing?.verified_date ?? null,
    price_unverified:
      chosen.price_verified_url === null ||
      (chosen.route === "aggregator" && chosen.per_call_price_usd === null),
    notes,
  });

  if (options.hasKey === true) {
    return finish(
      directOption(
        `A key for ${entry.name} is already in the vault, so the route is the SkeletonKey proxy: ` +
          "send the request with no credential of your own. No signup, no aggregator, no new spend " +
          "decision.",
      ),
      [...priced.map((c) => aggregatorOption(c, `${c.name} also resells ${entry.name} per call.`)), x402],
    );
  }

  if (model === "x402" || entry.access_mode === "x402") {
    const option = x402 ?? {
      route: "x402" as const,
      via: null,
      per_call_price_usd: null,
      price_verified_url: billing?.verified_url ?? null,
      reason: `billing.model is x402 for ${entry.name}: pay per call from a wallet, no account.`,
    };
    return finish(option, priced.map((c) => aggregatorOption(c, `${c.name} also resells it per call.`)));
  }

  if (model === null) {
    return finish(
      {
        route: "unknown",
        via: null,
        per_call_price_usd: null,
        price_verified_url: null,
        reason:
          `No billing model is recorded for ${entry.name} (billing${billing === null ? "" : ".model"}: ` +
          `null = nobody checked, not free), so ${PRICE_UNVERIFIED}. Read the vendor's own pricing ` +
          "page, then fill billing.model with its verified_url before spending anything.",
      },
      [
        ...priced.map((c) =>
          aggregatorOption(
            c,
            `${c.name} resells ${entry.name} at ${money(c.per_call_price ?? 0)} per call ` +
              `(verified: ${c.price_verified_url}), which needs no vendor account.`,
          ),
        ),
        x402,
      ],
    );
  }


  const freeTier = model.startsWith("free_tier") || model === "free";
  const coversApi = billing?.free_tier_covers_api ?? null;

  if (model === "free") {
    return finish(
      directOption(
        `${entry.name} has no paid tier at all (billing.model: free, verified: ${billing?.verified_url}). ` +
          "Go direct. A key, where one exists, only raises the rate limit." +
          (billing?.free_tier_note == null ? "" : ` Free tier: ${billing.free_tier_note}`),
      ),
      [x402],
    );
  }

  if (model === "payg" || model === "free_tier+payg") {
    const prefix =
      model === "free_tier+payg"
        ? `${entry.name} has a free allowance and then meters usage`
        : `${entry.name} is pay-as-you-go with no subscription`;
    return finish(
      directOption(
        `${prefix} (billing.model: ${model}, verified: ${billing?.verified_url} on ` +
          `${billing?.verified_date}), so go direct -- no monthly plan stands between the agent and the ` +
          "API." +
          (billing?.free_tier_note == null ? "" : ` Free tier: ${billing.free_tier_note}`),
      ),
      [
        ...priced.map((c) =>
          aggregatorOption(
            c,
            `${c.name} resells ${entry.name} at ${money(c.per_call_price ?? 0)} per call ` +
              `(verified: ${c.price_verified_url}) if you would rather not hold an account at all.`,
          ),
        ),
        x402,
      ],
    );
  }

  // model is subscription or free_tier+subscription from here on.
  if (freeTier && coversApi === true) {
    return finish(
      directOption(
        `${entry.name} needs a monthly plan for volume, but its free tier covers API access ` +
          `(billing.free_tier_covers_api: true, verified: ${billing?.verified_url} on ` +
          `${billing?.verified_date}), so go direct and stay inside it. Free tier: ` +
          `${billing?.free_tier_note}`,
      ),
      [
        ...priced.map((c) =>
          aggregatorOption(
            c,
            `Past the free tier, direct access costs a monthly subscription; ${c.name} resells ` +
              `${entry.name} at ${money(c.per_call_price ?? 0)} per call with no subscription ` +
              `(verified: ${c.price_verified_url}).`,
          ),
        ),
        x402,
      ],
    );
  }

  const cheapest = priced[0];
  if (cheapest !== undefined) {
    const tie = priced.filter((c) => c.per_call_price === cheapest.per_call_price);
    const why =
      `Direct access to ${entry.name} requires a monthly subscription (billing.model: ${model}` +
      (freeTier
        ? `, and free_tier_covers_api: ${String(coversApi)} -- the free tier is not established to ` +
          "cover the API"
        : "") +
      `, verified: ${billing?.verified_url} on ${billing?.verified_date}). ${cheapest.name} carries it ` +
      `at ${money(cheapest.per_call_price ?? 0)} per call with no subscription (verified: ` +
      `${cheapest.price_verified_url}), which is the cheapest verified per-call price of the ` +
      `${priced.length} aggregator(s) that publish one` +
      (tie.length > 1
        ? `; ${tie.map((c) => c.name).join(" and ")} tie at that price, broken by catalog order.`
        : ".");
    return finish(aggregatorOption(cheapest, why), [
      ...priced.slice(1).map((c) =>
        aggregatorOption(
          c,
          `${c.name} also carries it, at ${money(c.per_call_price ?? 0)} per call (verified: ` +
            `${c.price_verified_url}).`,
        ),
      ),
      directOption(
        `Direct, accepting the monthly subscription${
          freeTier && billing?.free_tier_note != null ? ` (free tier: ${billing.free_tier_note})` : ""
        }. A human decides on any recurring charge.`,
      ),
      x402,
    ]);
  }

  return finish(
    directOption(
      `Direct access to ${entry.name} requires a monthly subscription (billing.model: ${model}, ` +
        `verified: ${billing?.verified_url} on ${billing?.verified_date}) and no aggregator publishes a ` +
        `per-call price for it, so ${PRICE_UNVERIFIED} for every alternative route. A human decides on ` +
        "the subscription." +
        (billing?.free_tier_note == null ? "" : ` Free tier: ${billing.free_tier_note}`),
    ),
    [x402],
  );
}

/** The compact `{route, reason}` pair `find_api` reports per match. */
export function routeSummary(decision: RoutingDecision): {
  route: string;
  reason: string;
  via: string | null;
  per_call_price_usd: number | null;
  price_unverified: boolean;
} {
  return {
    route: decision.route === "aggregator" ? `aggregator:${decision.via}` : decision.route,
    reason: decision.reason,
    via: decision.via,
    per_call_price_usd: decision.per_call_price_usd,
    price_unverified: decision.price_unverified,
  };
}
