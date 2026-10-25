/**
 * Rung 3 of the ladder: the Secure Input Popup (§5a).
 *
 * A localhost-only page, spawned by the runner and announced by an OS
 * notification. The value the human types goes straight from that page into the
 * runner's browser DOM (or into `bw` when it should persist). It never reaches
 * the agent's terminal, the MCP stream, or a log.
 *
 * This file holds the state machine; `src/runner/server.ts` serves the page.
 * The registry never *stores* a submitted value: `submit` hands it to the
 * waiting resolver and keeps only the fact that something was filled.
 */
import crypto from "node:crypto";
import type { OriginCheck } from "../allowlist.js";
import type { Notifier } from "../notify.js";
import type {
  SecretClass,
  SecretRequest,
  SecretResolution,
  SecretSource,
} from "./types.js";

export type PopupStatus = "pending" | "filled" | "cancelled" | "blocked" | "expired";

export interface PopupEntry {
  id: string;
  vendor: string;
  field: string;
  /** Origin the value will be typed into, shown to the human verbatim. */
  origin: string;
  secret_class: SecretClass;
  reason: string | null;
  /** Result of the allowlist/origin check, shown on the page (phishing defence). */
  origin_verified: boolean;
  origin_detail: string;
  status: PopupStatus;
  created: string;
  /** Form token, so a page on another origin cannot post to this popup. */
  token: string;
}

/** What anything outside the runner may see about a popup: never a value. */
export interface PopupView {
  secret_input_id: string;
  vendor: string;
  field: string;
  secret_class: SecretClass;
  status: PopupStatus;
  origin_verified: boolean;
  created: string;
  /** Length only, so a flow can be debugged without the value. */
  filled_length: number | null;
}

interface Waiter {
  resolve: (value: string | null) => void;
  timer: NodeJS.Timeout | null;
}

export class PopupRegistry {
  private readonly entries = new Map<string, PopupEntry>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly lengths = new Map<string, number>();

  open(request: SecretRequest, check: OriginCheck): PopupEntry {
    const entry: PopupEntry = {
      id: `sec_${crypto.randomBytes(8).toString("hex")}`,
      vendor: request.vendor,
      field: request.field,
      origin: request.origin,
      secret_class: request.class,
      reason: request.reason ?? null,
      origin_verified: check.allowed,
      origin_detail: check.reason,
      // An origin that failed the check is created as `blocked`, so the page
      // can explain itself instead of quietly accepting a secret for a
      // lookalike domain.
      status: check.allowed ? "pending" : "blocked",
      created: new Date().toISOString(),
      token: crypto.randomBytes(16).toString("hex"),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): PopupEntry | undefined {
    return this.entries.get(id);
  }

  list(): PopupEntry[] {
    return [...this.entries.values()];
  }

  view(id: string): PopupView | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    return {
      secret_input_id: entry.id,
      vendor: entry.vendor,
      field: entry.field,
      secret_class: entry.secret_class,
      status: entry.status,
      origin_verified: entry.origin_verified,
      created: entry.created,
      filled_length: this.lengths.get(id) ?? null,
    };
  }

  /**
   * Hands a typed value to whoever is waiting for it. Returns false when the
   * popup is unknown, already settled, blocked, or the form token is wrong.
   */
  submit(id: string, token: string, value: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.status !== "pending") return false;
    if (!tokenEqual(entry.token, token)) return false;
    if (value === "") return false;
    entry.status = "filled";
    this.lengths.set(id, value.length);
    this.settle(id, value);
    return true;
  }

  cancel(id: string, status: Exclude<PopupStatus, "pending" | "filled"> = "cancelled"): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.status !== "pending") return false;
    entry.status = status;
    this.settle(id, null);
    return true;
  }

  /** Cancels every pending popup. Used by the kill switch. */
  cancelAll(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "pending" && this.cancel(entry.id)) count += 1;
    }
    return count;
  }

  /** Resolves with the typed value, or null on cancel/timeout/block. */
  wait(id: string, timeoutMs: number): Promise<string | null> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.status !== "pending") return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const current = this.entries.get(id);
              if (current !== undefined && current.status === "pending") current.status = "expired";
              this.settle(id, null);
            }, timeoutMs)
          : null;
      if (timer !== null) timer.unref?.();
      this.waiters.set(id, { resolve, timer });
    });
  }

  private settle(id: string, value: string | null): void {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return;
    this.waiters.delete(id);
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.resolve(value);
  }
}

function tokenEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface PopupSourceOptions {
  registry: PopupRegistry;
  /** Builds the page URL the human opens. */
  urlFor: (id: string) => string;
  /** Checks the origin before the popup is even shown. */
  checkOrigin: (request: SecretRequest) => OriginCheck;
  notifier?: Notifier;
  /** How long the human has. Default 5 minutes. */
  timeoutMs?: number;
  /** Where the runner prints the URL when no OS notifier exists. */
  log?: (line: string) => void;
}

export class PopupSecretSource implements SecretSource {
  readonly id = "popup" as const;
  private detail: string | null = null;

  constructor(private readonly options: PopupSourceOptions) {}

  handles(): boolean {
    // The popup is the last rung for every class, including OTPs.
    return true;
  }

  lastDetail(): string | null {
    return this.detail;
  }

  async resolve(request: SecretRequest): Promise<SecretResolution | null> {
    this.detail = null;
    const check = this.options.checkOrigin(request);
    const entry = this.options.registry.open(request, check);
    const url = this.options.urlFor(entry.id);

    if (!check.allowed) {
      this.detail = `Blocked: ${check.reason}`;
      await this.options.notifier?.notify({
        title: "SkeletonKey blocked a secret request",
        body: `${request.vendor} asked for ${request.field} on an origin that is not allowlisted.`,
        url,
      });
      this.options.log?.(
        `! secure-input blocked for ${request.vendor} (${request.field}): ${check.reason}`,
      );
      return null;
    }

    const waiting = this.options.registry.wait(entry.id, this.options.timeoutMs ?? 300_000);
    await this.options.notifier?.notify({
      title: `SkeletonKey needs ${request.field}`,
      body: `${request.vendor} (${check.host}) -- open the Secure Input Popup to type it. It is not shown to the agent.`,
      url,
    });
    this.options.log?.(
      `secure-input ${entry.id}: ${request.class} for ${request.vendor} on ${check.host} -> ${url}`,
    );

    const value = await waiting;
    if (value === null) {
      const status = this.options.registry.get(entry.id)?.status ?? "cancelled";
      this.detail = `The Secure Input Popup was ${status} without a value.`;
      return null;
    }
    return {
      source: "popup",
      value,
      detail:
        `A human typed ${request.field} into the Secure Input Popup for ${check.host} ` +
        `(${value.length} characters). It went to the runner only.`,
    };
  }
}
