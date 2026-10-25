/**
 * The spend policy: one global monthly cap plus per-vendor caps, in
 * `~/.skeletonkey/policy.yaml`.
 *
 * Both default to **$0** and no number is preset (D11). The first action that
 * could cost money therefore fails the check and the runner raises an approval
 * asking the human to set the caps, on the approval page, outside the agent's
 * context.
 *
 * Caps only ever move on a human decision: `writePolicy` demands a
 * `CapChangeAuthority`, and the only thing that can mint one is the approval
 * page or the CLI (D5: an agent may disable a key and cancel a request; it may
 * never enable a key or raise a cap).
 */
import fs from "node:fs";
import YAML from "yaml";
import { ensureHome } from "./config.js";
import { skeletonKeyHome } from "./paths.js";
import path from "node:path";

export interface SpendPolicy {
  version: 1;
  /** Global cap for the calendar month, in USD. 0 means "nothing is approved". */
  global_monthly_cap_usd: number;
  /** Per-vendor caps, keyed by lowercased vendor name. */
  vendor_caps_usd: Record<string, number>;
  created: string;
  updated: string | null;
  /** How the current caps were set, for the human reading the file. */
  last_change_by: string | null;
}

export function policyPath(home = skeletonKeyHome()): string {
  return path.join(home, "policy.yaml");
}

/** $0 everywhere, no preset numbers (D11). */
export function defaultPolicy(now = new Date().toISOString()): SpendPolicy {
  return {
    version: 1,
    global_monthly_cap_usd: 0,
    vendor_caps_usd: {},
    created: now,
    updated: null,
    last_change_by: null,
  };
}

const HEADER = `# SkeletonKey spend policy. Caps are in USD and default to 0.
# An agent can never raise these: the approval page and the \`skeletonkey policy\`
# command are the only writers, and both require a human.
`;

export function readPolicy(home = skeletonKeyHome()): SpendPolicy {
  const file = policyPath(home);
  if (!fs.existsSync(file)) return defaultPolicy();
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return defaultPolicy();
  }
  if (parsed === null || typeof parsed !== "object") return defaultPolicy();
  const raw = parsed as Record<string, unknown>;
  const base = defaultPolicy();
  const caps: Record<string, number> = {};
  const rawCaps = raw["vendor_caps_usd"];
  if (rawCaps !== null && typeof rawCaps === "object" && !Array.isArray(rawCaps)) {
    for (const [vendor, value] of Object.entries(rawCaps as Record<string, unknown>)) {
      const amount = coerceCap(value);
      if (amount !== null) caps[normalizeVendor(vendor)] = amount;
    }
  }
  return {
    version: 1,
    global_monthly_cap_usd: coerceCap(raw["global_monthly_cap_usd"]) ?? 0,
    vendor_caps_usd: caps,
    created: typeof raw["created"] === "string" ? raw["created"] : base.created,
    updated: typeof raw["updated"] === "string" ? raw["updated"] : null,
    last_change_by: typeof raw["last_change_by"] === "string" ? raw["last_change_by"] : null,
  };
}

/**
 * Proof that a human decided a cap change. Minted by the approval page (with
 * the id of the approval the human clicked) or by the CLI (where the human is
 * the one typing). There is no MCP tool that can produce one.
 */
export interface CapChangeAuthority {
  /** `approval-page` or `cli`. Recorded in the file as `last_change_by`. */
  readonly by: "approval-page" | "cli";
  /** The approval request the human acted on, when there was one. */
  readonly request_id?: string;
}

export function writePolicy(
  policy: SpendPolicy,
  authority: CapChangeAuthority,
  home = skeletonKeyHome(),
): SpendPolicy {
  if (authority.by !== "approval-page" && authority.by !== "cli") {
    throw new Error("A cap change needs a human authority (`approval-page` or `cli`).");
  }
  ensureHome(home);
  const file = policyPath(home);
  const stored: SpendPolicy = {
    ...policy,
    version: 1,
    global_monthly_cap_usd: Math.max(0, policy.global_monthly_cap_usd),
    vendor_caps_usd: Object.fromEntries(
      Object.entries(policy.vendor_caps_usd).map(([vendor, cap]) => [
        normalizeVendor(vendor),
        Math.max(0, cap),
      ]),
    ),
    updated: new Date().toISOString(),
    last_change_by:
      authority.request_id === undefined ? authority.by : `${authority.by} (${authority.request_id})`,
  };
  fs.writeFileSync(file, HEADER + YAML.stringify(stored), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return stored;
}

/** Sets the global cap, a vendor cap, or both. Human authority required. */
export function setCaps(
  options: {
    global_monthly_cap_usd?: number;
    vendor?: string;
    vendor_cap_usd?: number;
  },
  authority: CapChangeAuthority,
  home = skeletonKeyHome(),
): SpendPolicy {
  const policy = readPolicy(home);
  const next: SpendPolicy = {
    ...policy,
    vendor_caps_usd: { ...policy.vendor_caps_usd },
  };
  if (options.global_monthly_cap_usd !== undefined) {
    if (!Number.isFinite(options.global_monthly_cap_usd) || options.global_monthly_cap_usd < 0) {
      throw new Error("The global monthly cap must be a non-negative number of dollars.");
    }
    next.global_monthly_cap_usd = options.global_monthly_cap_usd;
  }
  if (options.vendor !== undefined && options.vendor_cap_usd !== undefined) {
    if (!Number.isFinite(options.vendor_cap_usd) || options.vendor_cap_usd < 0) {
      throw new Error("A vendor cap must be a non-negative number of dollars.");
    }
    next.vendor_caps_usd[normalizeVendor(options.vendor)] = options.vendor_cap_usd;
  }
  return writePolicy(next, authority, home);
}

/** A cap is a non-negative finite number of dollars, or nothing at all. */
function coerceCap(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function normalizeVendor(vendor: string): string {
  return vendor.trim().toLowerCase();
}

/** True while nothing at all has been approved: every cap is still $0. */
export function capsUnset(policy: SpendPolicy): boolean {
  if (policy.global_monthly_cap_usd > 0) return false;
  return Object.values(policy.vendor_caps_usd).every((cap) => cap <= 0);
}

export function vendorCap(policy: SpendPolicy, vendor: string): number {
  return policy.vendor_caps_usd[normalizeVendor(vendor)] ?? 0;
}

export interface SpendCheck {
  /** True only when the amount fits inside both caps. */
  allowed: boolean;
  /** True when a human has to decide before anything is spent. */
  needs_approval: boolean;
  /** True when no cap has ever been set, so this is the first paid action. */
  caps_unset: boolean;
  reason: string;
  global_cap_usd: number;
  vendor_cap_usd: number;
  month_to_date_usd: number;
  vendor_to_date_usd: number;
  /** What the approval page should propose, when it has to ask. */
  asks_human_to_set_caps: boolean;
}

/**
 * Would spending `amount_usd` with `vendor` stay inside the policy?
 *
 * A `null` amount means "cost unknown", which is never approved automatically:
 * unknown is not zero anywhere in this codebase.
 */
export function checkSpend(options: {
  policy: SpendPolicy;
  vendor: string;
  amount_usd: number | null;
  month_to_date_usd?: number;
  vendor_to_date_usd?: number;
}): SpendCheck {
  const { policy, vendor } = options;
  const globalCap = policy.global_monthly_cap_usd;
  const cap = vendorCap(policy, vendor);
  const monthToDate = options.month_to_date_usd ?? 0;
  const vendorToDate = options.vendor_to_date_usd ?? 0;
  const unset = capsUnset(policy);
  const base = {
    caps_unset: unset,
    global_cap_usd: globalCap,
    vendor_cap_usd: cap,
    month_to_date_usd: monthToDate,
    vendor_to_date_usd: vendorToDate,
  };

  if (unset) {
    return {
      ...base,
      allowed: false,
      needs_approval: true,
      asks_human_to_set_caps: true,
      reason:
        "No spend caps are set yet: the global monthly cap and every vendor cap default to $0 " +
        "(D11). This is the first paid action, so the human is asked to set a per-vendor cap and " +
        "a global monthly cap on the approval page before anything is spent.",
    };
  }

  if (options.amount_usd === null) {
    return {
      ...base,
      allowed: false,
      needs_approval: true,
      asks_human_to_set_caps: false,
      reason:
        `The cost of this action with ${vendor} is unknown (null), and unknown is not zero. A human ` +
        "approves it, or a verified price is found first.",
    };
  }

  const amount = options.amount_usd;
  if (amount < 0) {
    return {
      ...base,
      allowed: false,
      needs_approval: true,
      asks_human_to_set_caps: false,
      reason: "A negative amount is not a spend; refusing rather than guessing what was meant.",
    };
  }

  if (cap <= 0) {
    return {
      ...base,
      allowed: false,
      needs_approval: true,
      asks_human_to_set_caps: true,
      reason:
        `No cap is set for ${vendor} (vendor cap $0), so nothing may be spent there yet. The human ` +
        "sets a per-vendor cap on the approval page.",
    };
  }

  if (vendorToDate + amount > cap) {
    return {
      ...base,
      allowed: false,
      needs_approval: true,
      asks_human_to_set_caps: false,
      reason:
        `$${amount} would take ${vendor} to $${round(vendorToDate + amount)} against its $${cap} cap, ` +
        "so it needs a fresh human approval. An agent can never raise a cap.",
    };
  }

  if (monthToDate + amount > globalCap) {
    return {
      ...base,
      allowed: false,
      needs_approval: true,
      asks_human_to_set_caps: false,
      reason:
        `$${amount} would take this month to $${round(monthToDate + amount)} against the $${globalCap} ` +
        "global monthly cap, so it needs a fresh human approval.",
    };
  }

  return {
    ...base,
    allowed: true,
    needs_approval: false,
    asks_human_to_set_caps: false,
    reason:
      `$${amount} fits inside the $${cap} cap for ${vendor} ($${round(vendorToDate)} spent) and the ` +
      `$${globalCap} global monthly cap ($${round(monthToDate)} spent).`,
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The caps as a tool reports them: numbers plus what an agent may not do. */
export function policyView(policy: SpendPolicy): Record<string, unknown> {
  return {
    policy_file_note: "Caps live in policy.yaml and are only writable by a human.",
    global_monthly_cap_usd: policy.global_monthly_cap_usd,
    vendor_caps_usd: policy.vendor_caps_usd,
    caps_unset: capsUnset(policy),
    updated: policy.updated,
    last_change_by: policy.last_change_by,
    agent_permissions: {
      may_disable_keys: true,
      may_cancel_requests: true,
      may_enable_keys: false,
      may_raise_caps: false,
      note:
        "D5: an agent may disable a key and cancel its own request. Enabling a key and raising a " +
        "cap are human-only, and there is no tool here that can do either.",
    },
  };
}
