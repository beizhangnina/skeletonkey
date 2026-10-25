/**
 * The approval store: every request an agent raises, and what the human decided.
 *
 * The agent never sees anything but an opaque id and a status. The file is
 * written through the redactor, so even a mistake upstream cannot land a secret
 * in it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureHome } from "./config.js";
import { skeletonKeyHome } from "./paths.js";
import { globalRedactor } from "./redact.js";

export const REQUEST_KINDS = [
  "access",
  "set_caps",
  "payment",
  "aggregator_route",
  "human_handoff",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = [
  "pending_approval",
  "approved",
  "denied",
  "cancelled",
  "voided",
  "needs_human",
  "ready",
  "failed",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Statuses nothing can move away from. */
const TERMINAL: readonly RequestStatus[] = ["denied", "cancelled", "voided", "ready", "failed"];

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL.includes(status);
}

export interface RequestEvent {
  at: string;
  status: RequestStatus;
  by: "agent" | "human" | "runner";
  note: string | null;
}

export interface AccessRequest {
  /** Opaque handle. The agent gets this and nothing else. */
  id: string;
  kind: RequestKind;
  vendor: string;
  /** API domain, when one is known. Used for the allowlist check. */
  domain: string | null;
  purpose: string | null;
  /** The agent's own estimate. Never treated as a price. */
  est_budget_usd: number | null;
  /**
   * The exact amount a `payment` request would move, in USD. Not an estimate:
   * it is the number the caps are re-checked against at submit time. Null on
   * every other kind of request.
   */
  amount_usd: number | null;
  status: RequestStatus;
  created: string;
  updated: string;
  decided: string | null;
  /** True when the vendor's domain is on the runner's allowlist. */
  domain_allowlisted: boolean;
  /** True when this request is the one that asks the human to set caps (D11). */
  asks_human_to_set_caps: boolean;
  /** Cap the human approved for this vendor, once they set one. */
  approved_vendor_cap_usd: number | null;
  /** Opaque key handle, set when the flow ends with a usable key. */
  handle: string | null;
  /** Proxy URL for that handle, once there is one. */
  proxy: string | null;
  /** Why it is in its current status, in words a human wrote or the runner chose. */
  reason: string | null;
  /** Vendor terms link shown on the approval page. */
  tos_url: string | null;
  /** What the human is told is shared with the vendor. */
  data_shared: string[];
  /** Whether the flow is expected to need a payment card. */
  requires_payment: boolean | null;
  /** Cheapest aggregator to offer if direct signup fails (D14). */
  fallback_aggregator: string | null;
  fallback_price_usd: number | null;
  /** The follow-up request raised when direct signup failed (D14). */
  follow_up_id: string | null;
  notes: string[];
  history: RequestEvent[];
  /** CSRF token for the approval page's form. Not a credential for anything else. */
  page_token: string;
}

/** What an agent is allowed to see about a request. */
export interface PublicRequest {
  request_id: string;
  kind: RequestKind;
  vendor: string;
  status: RequestStatus;
  created: string;
  updated: string;
  decided: string | null;
  reason: string | null;
  handle: string | null;
  proxy: string | null;
  notes: string[];
  /** Where the human decides. Printed for the human, not for the agent to open. */
  approval_url: string | null;
  cancellable: boolean;
}

export function publicRequest(request: AccessRequest, approvalUrl: string | null): PublicRequest {
  return {
    request_id: request.id,
    kind: request.kind,
    vendor: request.vendor,
    status: request.status,
    created: request.created,
    updated: request.updated,
    decided: request.decided,
    reason: request.reason,
    handle: request.handle,
    proxy: request.proxy,
    notes: request.notes,
    approval_url: request.status === "pending_approval" ? approvalUrl : null,
    cancellable: !isTerminal(request.status),
  };
}

export function requestsPath(home = skeletonKeyHome()): string {
  return path.join(home, "requests.json");
}

/** `req_` plus 16 random hex characters: opaque, unguessable, not a secret. */
export function newRequestId(): string {
  return `req_${crypto.randomBytes(8).toString("hex")}`;
}

export interface CreateRequest {
  kind: RequestKind;
  vendor: string;
  domain?: string | null;
  purpose?: string | null;
  est_budget_usd?: number | null;
  amount_usd?: number | null;
  domain_allowlisted?: boolean;
  asks_human_to_set_caps?: boolean;
  reason?: string | null;
  tos_url?: string | null;
  data_shared?: string[];
  requires_payment?: boolean | null;
  fallback_aggregator?: string | null;
  fallback_price_usd?: number | null;
  notes?: string[];
  status?: RequestStatus;
}

/** A small JSON-file store. One writer (the runner) and a few readers. */
export class RequestStore {
  constructor(private readonly file: string) {}

  static open(home = skeletonKeyHome()): RequestStore {
    return new RequestStore(requestsPath(home));
  }

  list(): AccessRequest[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is AccessRequest => isRequest(item));
    } catch {
      return [];
    }
  }

  get(id: string): AccessRequest | undefined {
    return this.list().find((request) => request.id === id);
  }

  pending(): AccessRequest[] {
    return this.list().filter((request) => request.status === "pending_approval");
  }

  create(input: CreateRequest): AccessRequest {
    const now = new Date().toISOString();
    const status = input.status ?? "pending_approval";
    const request: AccessRequest = {
      id: newRequestId(),
      kind: input.kind,
      vendor: input.vendor,
      domain: input.domain ?? null,
      purpose: input.purpose ?? null,
      est_budget_usd: input.est_budget_usd ?? null,
      amount_usd: input.amount_usd ?? null,
      status,
      created: now,
      updated: now,
      decided: null,
      domain_allowlisted: input.domain_allowlisted ?? false,
      asks_human_to_set_caps: input.asks_human_to_set_caps ?? false,
      approved_vendor_cap_usd: null,
      handle: null,
      proxy: null,
      reason: input.reason ?? null,
      tos_url: input.tos_url ?? null,
      data_shared: input.data_shared ?? [],
      requires_payment: input.requires_payment ?? null,
      fallback_aggregator: input.fallback_aggregator ?? null,
      fallback_price_usd: input.fallback_price_usd ?? null,
      follow_up_id: null,
      notes: input.notes ?? [],
      history: [{ at: now, status, by: "agent", note: input.reason ?? null }],
      page_token: crypto.randomBytes(16).toString("hex"),
    };
    this.save([...this.list(), request]);
    return request;
  }

  /**
   * Moves a request along. Refuses to move one that is already terminal, so a
   * cancelled request cannot be resurrected into an approval.
   */
  update(
    id: string,
    patch: Partial<Omit<AccessRequest, "id" | "created" | "history" | "page_token">>,
    by: RequestEvent["by"],
    note?: string,
  ): AccessRequest {
    const all = this.list();
    const index = all.findIndex((request) => request.id === id);
    const current = all[index];
    if (index < 0 || current === undefined) throw new Error(`Unknown request ${JSON.stringify(id)}.`);
    if (patch.status !== undefined && patch.status !== current.status && isTerminal(current.status)) {
      throw new Error(
        `Request ${id} is already ${current.status}; that is final and cannot become ${patch.status}.`,
      );
    }
    const now = new Date().toISOString();
    // `decided` marks the moment a human (or the kill switch) settled it.
    const decides =
      patch.status !== undefined && (patch.status === "approved" || isTerminal(patch.status));
    const next: AccessRequest = {
      ...current,
      ...patch,
      id: current.id,
      created: current.created,
      page_token: current.page_token,
      updated: now,
      decided: decides ? now : current.decided,
      history: [
        ...current.history,
        { at: now, status: patch.status ?? current.status, by, note: note ?? null },
      ],
    };
    all[index] = next;
    this.save(all);
    return next;
  }

  /** Agents may cancel their own requests (D5). */
  cancel(id: string, reason: string | null, by: RequestEvent["by"] = "agent"): AccessRequest {
    const current = this.get(id);
    if (current === undefined) throw new Error(`Unknown request ${JSON.stringify(id)}.`);
    if (isTerminal(current.status)) return current;
    return this.update(id, { status: "cancelled", reason }, by, reason ?? "cancelled");
  }

  /** Kill switch: every pending approval is voided at once. */
  voidPending(reason: string): AccessRequest[] {
    const voided: AccessRequest[] = [];
    for (const request of this.pending()) {
      voided.push(this.update(request.id, { status: "voided", reason }, "runner", reason));
    }
    return voided;
  }

  private save(requests: AccessRequest[]): void {
    ensureHome(path.dirname(this.file));
    // Belt and braces: the store holds no secrets by construction, and is
    // written through the redactor anyway.
    const safe = globalRedactor.redactDeep(requests);
    fs.writeFileSync(this.file, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // The parent directory is already 0700.
    }
  }
}

function isRequest(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw["id"] === "string" && typeof raw["vendor"] === "string";
}
