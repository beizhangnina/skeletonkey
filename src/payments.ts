/**
 * The payment chokepoint: the caps are checked **again, immediately before a
 * payment is submitted**, not only when the approval was raised.
 *
 * An approval is a decision about the world as it was when the human clicked.
 * Between that click and the submit, two things can change underneath it: the
 * human can lower a cap, and the ledger can grow (an earlier payment, or calls
 * whose cost an upstream reported). So the numbers are read again here -- fresh
 * `policy.yaml`, fresh ledger -- and a payment that no longer fits is blocked.
 *
 * When it is blocked the stale approval is **voided**, which is terminal, so it
 * can never be reused; a new `payment` approval is raised for the human in its
 * place. An agent must never be able to spend past a cap by holding on to an
 * old yes.
 */
import { checkSpend, type SpendCheck, type SpendPolicy } from "./policy.js";
import type { AccessRequest, CreateRequest, RequestStore } from "./requests.js";

/** Why a submit was refused. */
export type PaymentBlockedCode =
  /** The id belongs to some other kind of request; there is nothing to submit. */
  | "not_a_payment"
  /** No live human approval: still pending, already settled, or voided. */
  | "not_approved"
  /** The request carries no amount, and unknown is not zero. */
  | "amount_unknown"
  /** The caps no longer allow it, because a cap moved or the ledger grew. */
  | "over_cap"
  /** The kill switch is engaged. */
  | "kill_switch"
  /** A submit for this same approval is already running. */
  | "in_flight";

export interface PaymentSubmitAllowed {
  allowed: true;
  request: AccessRequest;
  amount_usd: number;
  check: SpendCheck;
}

export interface PaymentSubmitBlocked {
  allowed: false;
  code: PaymentBlockedCode;
  /** The request as it stands after the gate ran: voided, when it was voided. */
  request: AccessRequest;
  /** The fresh approval the human now has to decide, when one was raised. */
  replacement: AccessRequest | null;
  reason: string;
  /** The re-check that refused it, or null when it never got that far. */
  check: SpendCheck | null;
}

export type PaymentSubmitDecision = PaymentSubmitAllowed | PaymentSubmitBlocked;

export interface PaymentGateOptions {
  request: AccessRequest;
  /** Read fresh, at submit time. Never the copy the approval was raised with. */
  policy: SpendPolicy;
  requests: RequestStore;
  /** Spend this calendar month from the ledger, read fresh at submit time. */
  month_to_date_usd: number;
  vendor_to_date_usd: number;
  /**
   * Raises the replacement approval. The runner passes its own
   * `createRequest`, so the human gets the same notification and page they get
   * for every other approval.
   */
  raise(input: CreateRequest): AccessRequest;
  /** True while the kill switch is engaged. Checked before anything else. */
  killed?: boolean;
  log?(line: string): void;
}

/**
 * The only way a payment may be submitted. Call it immediately before the
 * submit -- nothing may happen between this returning `allowed` and the money
 * moving -- and submit only on `{allowed: true}`.
 */
export function gatePaymentSubmit(options: PaymentGateOptions): PaymentSubmitDecision {
  const { request, requests, policy } = options;
  const log = options.log ?? ((): void => {});

  if (request.kind !== "payment") {
    return {
      allowed: false,
      code: "not_a_payment",
      request,
      replacement: null,
      check: null,
      reason:
        `Request ${request.id} is a ${request.kind} request, not a payment, so there is nothing ` +
        "to submit.",
    };
  }

  if (options.killed === true) {
    // The kill switch voids pending approvals when it is engaged; an approved
    // payment that has not been submitted yet is voided here, on the way past.
    const voided = voidStale(
      requests,
      request,
      "The SkeletonKey kill switch was engaged after this payment was approved, so the approval " +
        "is void. A human clears the kill switch with `skeletonkey resume` and approves again.",
    );
    log(`payment ${request.id}: submit refused -- kill switch engaged; approval voided`);
    return {
      allowed: false,
      code: "kill_switch",
      request: voided,
      replacement: null,
      check: null,
      reason: voided.reason ?? "kill switch",
    };
  }

  if (request.status !== "approved") {
    return {
      allowed: false,
      code: "not_approved",
      request,
      replacement: null,
      check: null,
      reason:
        `Request ${request.id} is \`${request.status}\`, not \`approved\`, so no human has said ` +
        "yes to this payment. Only the local approval page can change that.",
    };
  }

  // The re-check. Fresh policy, fresh ledger totals, and the amount this
  // submit would actually move. A store written by an older version may carry
  // no amount at all, which is "unknown", not zero.
  const amount = request.amount_usd ?? null;
  const check = checkSpend({
    policy,
    vendor: request.vendor,
    amount_usd: amount,
    month_to_date_usd: options.month_to_date_usd,
    vendor_to_date_usd: options.vendor_to_date_usd,
  });

  if (check.allowed && amount !== null) {
    log(
      `payment ${request.id}: submit allowed -- $${amount} for ${request.vendor} re-checked at ` +
        `submit (${check.reason})`,
    );
    return { allowed: true, request, amount_usd: amount, check };
  }

  const code: PaymentBlockedCode = amount === null ? "amount_unknown" : "over_cap";
  const reason =
    `Blocked at submit: the caps were checked again and ${check.reason} The approval the human ` +
    "gave earlier was for the numbers as they stood then, so it is void and a new approval is " +
    "needed. Nothing was submitted and nothing was charged.";
  const voided = voidStale(requests, request, reason);
  const replacement = options.raise({
    kind: "payment",
    vendor: request.vendor,
    domain: request.domain,
    purpose: request.purpose,
    amount_usd: amount,
    est_budget_usd: amount,
    requires_payment: true,
    reason,
    tos_url: request.tos_url,
    data_shared: request.data_shared,
    notes: [
      `Raised from ${request.id}, whose approval was voided by the submit-time cap re-check.`,
      `At submit: $${round(options.month_to_date_usd)} spent this month against the ` +
        `$${check.global_cap_usd} global cap, $${round(options.vendor_to_date_usd)} with ` +
        `${request.vendor} against its $${check.vendor_cap_usd} cap.`,
    ],
  });
  log(
    `payment ${request.id}: submit BLOCKED (${code}) -- approval voided, ${replacement.id} raised ` +
      "for a fresh human decision",
  );
  return { allowed: false, code, request: voided, replacement, reason, check };
}

function voidStale(requests: RequestStore, request: AccessRequest, reason: string): AccessRequest {
  return requests.update(request.id, { status: "voided", reason }, "runner", "submit-time re-check");
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// --- the submit itself -----------------------------------------------------

export interface PaymentSubmitContext {
  request_id: string;
  vendor: string;
  domain: string | null;
  /** The amount the gate just re-checked. Not an estimate. */
  amount_usd: number;
  /** Appends to the request's log. Redacted by the caller. */
  log(line: string): void;
}

export interface PaymentSubmitOutcome {
  status: "paid" | "needs_human" | "failed";
  /** `no_card_automation`, `declined`, `receipt_parsed`, ... */
  reason: string;
  /** What the vendor actually charged, when a receipt said so. */
  charged_usd?: number | null;
}

/** One way of paying a vendor. Card autofill from the vault lands in v1.0. */
export interface PaymentSubmitter {
  readonly id: string;
  submit(context: PaymentSubmitContext): Promise<PaymentSubmitOutcome>;
}

/**
 * v0.3's submitter: SkeletonKey pays for nothing by itself, so an approved
 * payment ends as a human handoff. The gate above still runs first, which is
 * the point -- every future submit path has to come through it.
 */
export class HumanHandoffPaymentSubmitter implements PaymentSubmitter {
  readonly id = "human-handoff";

  async submit(context: PaymentSubmitContext): Promise<PaymentSubmitOutcome> {
    context.log(
      `SkeletonKey submits no payment itself in v0.3: the human pays $${context.amount_usd} to ` +
        `${context.vendor} on the vendor's own checkout, with their own card. Card autofill from ` +
        "the vault lands in v1.0 (fiat only, one card, no virtual cards).",
    );
    return { status: "needs_human", reason: "no_card_automation", charged_usd: null };
  }
}
