/**
 * The MCP server's side of the runner boundary.
 *
 * Everything an agent can reach goes through these four verbs. There is
 * deliberately no `getSecret`, no `readVault`, no screenshot and no DOM: the
 * runner's API has no such verb to call (§9).
 */
import { readRunnerState, RUNNER_TOKEN_HEADER, type RunnerState } from "./server.js";
import { skeletonKeyHome } from "../paths.js";
import type { PublicRequest } from "../requests.js";

export interface RunnerRequestInput {
  vendor: string;
  domain?: string | null;
  purpose?: string | null;
  est_budget_usd?: number | null;
  tos_url?: string | null;
  requires_payment?: boolean | null;
  fallback_aggregator?: string | null;
  fallback_price_usd?: number | null;
}

export interface RunnerPaymentInput {
  vendor: string;
  domain?: string | null;
  purpose?: string | null;
  /** The exact amount, in USD. There is no "unknown amount" payment. */
  amount_usd: number;
  tos_url?: string | null;
}

export type RunnerRequestView = PublicRequest & Record<string, unknown>;

export class RunnerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerUnavailableError";
  }
}

export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  /** Reads `runner.json`; null when no runner has ever written one. */
  static fromHome(home = skeletonKeyHome(), fetchImpl: typeof fetch = fetch): RunnerClient | null {
    const state: RunnerState | null = readRunnerState(home);
    if (state === null) return null;
    return new RunnerClient(state.url, state.token, fetchImpl);
  }

  get url(): string {
    return this.baseUrl;
  }

  async health(): Promise<Record<string, unknown>> {
    return this.call("GET", "/health");
  }

  async createRequest(input: RunnerRequestInput): Promise<RunnerRequestView> {
    return (await this.call("POST", "/v1/requests", input)) as RunnerRequestView;
  }

  async getRequest(id: string): Promise<RunnerRequestView> {
    return (await this.call("GET", `/v1/requests/${encodeURIComponent(id)}`)) as RunnerRequestView;
  }

  async cancelRequest(id: string, reason: string | null): Promise<RunnerRequestView> {
    return (await this.call("POST", `/v1/requests/${encodeURIComponent(id)}/cancel`, {
      reason,
    })) as RunnerRequestView;
  }

  /** Raises a `payment` approval. The human decides; this returns an id. */
  async createPayment(input: RunnerPaymentInput): Promise<RunnerRequestView> {
    return (await this.call("POST", "/v1/payments", input)) as RunnerRequestView;
  }

  /**
   * Submits an approved payment -- but only after the runner re-checks the caps
   * against a freshly read policy and ledger. A payment that no longer fits
   * comes back `{submitted: false, blocked: true, needs_new_approval: true}`
   * with a new request id: the earlier approval has been voided, and only the
   * human can give another one.
   */
  async submitPayment(requestId: string): Promise<Record<string, unknown>> {
    return this.call("POST", `/v1/payments/${encodeURIComponent(requestId)}/submit`);
  }

  async policy(): Promise<Record<string, unknown>> {
    return this.call("GET", "/v1/policy");
  }

  async kill(reason: string): Promise<Record<string, unknown>> {
    return this.call("POST", "/v1/kill", { reason });
  }

  private async call(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        headers: {
          "content-type": "application/json",
          [RUNNER_TOKEN_HEADER]: this.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RunnerUnavailableError(
        `The SkeletonKey runner at ${this.baseUrl} did not answer (${message}). Ask the human to ` +
          "start it with `skeletonkey runner`.",
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      parsed = { error: "bad_runner_response" };
    }
    const payload =
      parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    if (!response.ok) {
      const detail = typeof payload["error"] === "string" ? payload["error"] : response.statusText;
      throw new Error(`runner ${method} ${route} failed: ${response.status} ${detail}`);
    }
    return payload;
  }
}
