import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateApisFile, type ApiEntry } from "../src/apis.js";
import { PRICE_UNVERIFIED, pricedCarriers, routeAccess, routeSummary } from "../src/routing.js";
import { REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");

function row(overrides: Partial<ApiEntry> = {}): ApiEntry {
  return {
    name: "vendor",
    url: "https://example.com",
    access_mode: "own-account",
    min_topup: null,
    billing_unit: null,
    signup_automatable: null,
    tos_notes: null,
    source: null,
    checked_date: null,
    ...overrides,
  };
}

const CARRIER = {
  name: "glasser" as const,
  carries: true,
  per_call_price: 0.01,
  price_verified_url: "https://api.glasser.ai/public/catalog",
};

describe("routeAccess", () => {
  it("routes an unindexed vendor to unknown, and says price unverified", () => {
    const decision = routeAccess(null);
    expect(decision.route).toBe("unknown");
    expect(decision.reason).toContain(PRICE_UNVERIFIED);
    expect(decision.reason).toMatch(/discover_api/);
    expect(decision.price_unverified).toBe(true);
  });

  it("routes to unknown when no billing model is recorded, never to free", () => {
    const decision = routeAccess(row());
    expect(decision.route).toBe("unknown");
    expect(decision.billing_model).toBeNull();
    expect(decision.reason).toContain(PRICE_UNVERIFIED);
    expect(decision.reason).toMatch(/nobody checked, not free/);
  });

  it("routes payg direct", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "payg",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    expect(decision.price_unverified).toBe(false);
    expect(decision.reason).toMatch(/no subscription/);
    expect(decision.reason).not.toContain(PRICE_UNVERIFIED);
  });

  it("routes free_tier+payg direct and quotes the free tier", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "free_tier+payg",
          free_tier_note: "first 200 million tokens free",
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    expect(decision.reason).toContain("first 200 million tokens free");
  });

  it("routes `free` direct and says a key only raises the rate limit", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "free",
          free_tier_note: "no paid tier at all",
          verified_url: "https://vendor.test/api",
          verified_date: "2026-10-24",
        },
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    expect(decision.reason).toMatch(/no paid tier at all/);
    expect(decision.reason).toMatch(/raises the rate limit/);
  });

  it("goes direct when a free tier verifiably covers the API, keeping the aggregator as a fallback", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "free_tier+subscription",
          free_tier_note: "100 credits/month, API access included",
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
          free_tier_covers_api: true,
        },
        aggregators: [CARRIER],
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    expect(decision.reason).toMatch(/free tier covers API access/);
    expect(decision.alternatives.map((option) => option.route)).toContain("aggregator");
  });

  it("routes a subscription vendor through the cheapest VERIFIED aggregator", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "subscription",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
        aggregators: [
          { name: "monid", carries: true, per_call_price: 0.05, price_verified_url: "https://monid.test/p" },
          { name: "glasser", carries: true, per_call_price: 0.02, price_verified_url: "https://glasser.test/p" },
          { name: "flatkey", carries: false, per_call_price: null, price_verified_url: null },
        ],
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("aggregator");
    expect(decision.via).toBe("glasser");
    expect(decision.per_call_price_usd).toBe(0.02);
    expect(decision.price_verified_url).toBe("https://glasser.test/p");
    expect(decision.price_unverified).toBe(false);
    expect(routeSummary(decision).route).toBe("aggregator:glasser");
    // the dearer carrier and the direct subscription both stay on the table
    expect(decision.alternatives.some((option) => option.via === "monid")).toBe(true);
    expect(decision.alternatives.some((option) => option.route === "direct")).toBe(true);
  });

  it("will not route through an aggregator whose price has no verified URL", () => {
    const entry = row({
      billing: {
        model: "subscription",
        free_tier_note: null,
        verified_url: "https://vendor.test/pricing",
        verified_date: "2026-10-24",
      },
      aggregators: [
        { name: "monid", carries: true, per_call_price: 0.001, price_verified_url: null },
      ],
    });
    expect(pricedCarriers(entry)).toEqual([]);
    const decision = routeAccess(entry, { today: "2026-10-25" });
    expect(decision.route).toBe("direct");
    expect(decision.reason).toContain(PRICE_UNVERIFIED);
  });

  it("says price unverified when a subscription vendor has no priced carrier at all", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "free_tier+subscription",
          free_tier_note: "a free plan exists",
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
          free_tier_covers_api: null,
        },
        aggregators: [
          {
            name: "monid",
            carries: true,
            per_call_price: null,
            price_verified_url: null,
            price_note: "prices per result, not per call",
          },
        ],
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    expect(decision.reason).toContain(PRICE_UNVERIFIED);
    expect(decision.notes.join(" ")).toMatch(/publishes no comparable per-call price/);
  });

  it("treats an unestablished free tier as not usable", () => {
    const base = {
      model: "free_tier+subscription" as const,
      free_tier_note: "a free plan exists, API access unclear",
      verified_url: "https://vendor.test/pricing",
      verified_date: "2026-10-24",
    };
    for (const covers of [null, false] as const) {
      const decision = routeAccess(
        row({ billing: { ...base, free_tier_covers_api: covers }, aggregators: [CARRIER] }),
        { today: "2026-10-25" },
      );
      expect(decision.route, String(covers)).toBe("aggregator");
    }
  });

  it("breaks a price tie by catalog order, and says so", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "subscription",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
        aggregators: [
          { name: "glasser", carries: true, per_call_price: 0.026, price_verified_url: "https://g.test/p" },
          { name: "monid", carries: true, per_call_price: 0.026, price_verified_url: "https://m.test/p" },
        ],
      }),
      { today: "2026-10-25" },
    );
    expect(decision.via).toBe("monid");
    expect(decision.reason).toMatch(/tie at that price, broken by catalog order/);
  });

  it("prefers x402 when that is the vendor's own access mode", () => {
    const decision = routeAccess(row({ access_mode: "x402" }));
    expect(decision.route).toBe("x402");
    expect(decision.reason).toMatch(/no account/);
  });

  it("offers x402 as an alternative when the vendor documents accepting it", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "free_tier+subscription",
          free_tier_note: "$5/month of usage",
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
          free_tier_covers_api: true,
          x402_url: "https://vendor.test/pricing",
        },
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    const x402 = decision.alternatives.find((option) => option.route === "x402");
    expect(x402?.reason).toMatch(/documents accepting x402/);
    expect(x402?.reason).toContain(PRICE_UNVERIFIED);
  });

  it("offers x402 through an aggregator that accepts it", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "subscription",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
        aggregators: [{ ...CARRIER, x402: true }],
      }),
      { today: "2026-10-25" },
    );
    expect(decision.route).toBe("aggregator");
    expect(decision.alternatives.some((option) => option.route === "x402")).toBe(true);
  });

  it("routes to the proxy when a key already exists, whatever the billing says", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "subscription",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-10-24",
        },
        aggregators: [CARRIER],
      }),
      { hasKey: true, today: "2026-10-25" },
    );
    expect(decision.route).toBe("direct");
    expect(decision.reason).toMatch(/already in the vault/);
  });

  it("flags billing verified outside the staleness window", () => {
    const decision = routeAccess(
      row({
        billing: {
          model: "payg",
          free_tier_note: null,
          verified_url: "https://vendor.test/pricing",
          verified_date: "2026-01-01",
        },
      }),
      { today: "2026-10-25", maxAgeDays: 90 },
    );
    expect(decision.notes.join(" ")).toMatch(/stale-check/);
    expect(decision.notes.join(" ")).toMatch(/297 days ago/);
  });

  it("flags a billing model that was never read off a page", () => {
    const decision = routeAccess(
      row({ billing: { model: "payg", free_tier_note: null, verified_url: null, verified_date: null } }),
    );
    expect(decision.notes.join(" ")).toContain(PRICE_UNVERIFIED);
    expect(decision.price_unverified).toBe(true);
  });
});

describe("the routes the shipped apis.yaml actually produces", () => {
  const entries = validateApisFile(APIS_YAML).document?.entries ?? [];
  const byName = new Map(entries.map((row) => [row.name, row]));
  const decide = (name: string) => routeAccess(byName.get(name) ?? null, { today: "2026-10-24" });

  it("sends Apollo through the cheapest aggregator, because its free tier is not established", () => {
    const decision = decide("example-apollo-contacts");
    expect(decision.route).toBe("aggregator");
    expect(decision.via).toBe("monid");
    expect(decision.per_call_price_usd).toBe(0.026);
    expect(decision.price_verified_url).toMatch(/^https:\/\/api\.monid\.ai\//);
    expect(decision.reason).toMatch(/requires a monthly subscription/);
  });

  it("sends Apify direct on its free tier, with glasser as the cheaper per-call fallback", () => {
    const decision = decide("example-apify-scraping");
    expect(decision.route).toBe("direct");
    const cheapest = decision.alternatives.find((option) => option.route === "aggregator");
    expect(cheapest?.via).toBe("glasser");
    expect(cheapest?.per_call_price_usd).toBe(0.001);
    expect(decision.alternatives.some((option) => option.route === "x402")).toBe(true);
  });

  it("sends X direct as pay-per-use, and Voyage direct on its free tokens", () => {
    expect(decide("example-x-twitter-api").route).toBe("direct");
    expect(decide("example-x-twitter-api").billing_model).toBe("payg");
    expect(decide("example-voyage-embeddings").route).toBe("direct");
    expect(decide("example-voyage-embeddings").billing_model).toBe("free_tier+payg");
  });

  it("sends DropLeads direct on its 100 free credits", () => {
    const decision = decide("example-dropleads-contacts");
    expect(decision.route).toBe("direct");
    expect(decision.reason).toMatch(/free tier covers API access/);
  });

  it("never claims a price for a vendor no aggregator carries", () => {
    for (const name of ["example-x-twitter-api", "example-voyage-embeddings", "example-dropleads-contacts"]) {
      const decision = decide(name);
      expect(decision.per_call_price_usd, name).toBeNull();
      expect(
        decision.alternatives.filter((option) => option.route === "aggregator"),
        name,
      ).toEqual([]);
    }
  });
});
