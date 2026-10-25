/**
 * The trusted local runner (§6.2, option B).
 *
 * A separate process from the MCP server. It holds the secrets: the `bw`
 * session, anything the ladder resolves, anything a human types into the Secure
 * Input Popup. The MCP server talks to it over loopback with a shared token and
 * gets back nothing but opaque ids and statuses.
 *
 * Two surfaces, deliberately different:
 *
 *   - `/v1/*` -- the agent-facing API, token-authed. There is **no verb here
 *     that returns a secret value**; the only shape that crosses this boundary
 *     is `{request_id, status, ...}`.
 *   - `/approve/<id>` and `/input/<id>` -- the human's pages, served to loopback
 *     only, with no token (the human cannot be asked to paste one) and a
 *     per-request form token so another page cannot post for them.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildAllowlist, type Allowlist } from "../allowlist.js";
import { ensureHome, readConfig } from "../config.js";
import { engageKillSwitch, killSwitchState } from "../killswitch.js";
import { openLedger, type Ledger } from "../ledger.js";
import { OsNotifier, type Notifier } from "../notify.js";
import { skeletonKeyHome } from "../paths.js";
import {
  capsUnset,
  checkSpend,
  policyView,
  readPolicy,
  setCaps,
  vendorCap,
  type SpendPolicy,
} from "../policy.js";
import {
  gatePaymentSubmit,
  HumanHandoffPaymentSubmitter,
  type PaymentSubmitDecision,
  type PaymentSubmitter,
} from "../payments.js";
import { globalRedactor, Redactor } from "../redact.js";
import {
  publicRequest,
  RequestStore,
  type AccessRequest,
  type CreateRequest,
  type PublicRequest,
} from "../requests.js";
import { BitwardenSecretSource } from "../secrets/bitwarden.js";
import { childProcessBw } from "../vault/bw-account.js";
import { BoundInboxSource } from "../secrets/inbox.js";
import { resolveSecret, type LadderResult } from "../secrets/ladder.js";
import { PopupRegistry, PopupSecretSource } from "../secrets/popup.js";
import type { SecretRequest, SecretSource } from "../secrets/types.js";
import { HumanHandoffSignupRunner, type SignupRunner } from "../signup/types.js";
import type { LedgerRow } from "../types.js";
import crypto from "node:crypto";

/** Header the MCP server authenticates to the runner with. */
export const RUNNER_TOKEN_HEADER = "x-skeletonkey-runner-token";

/** Default port. The proxy owns 8787; the runner sits next to it. */
export const DEFAULT_RUNNER_PORT = 8788;

export interface RunnerState {
  url: string;
  token: string;
  pid: number;
  started: string;
  port: number;
}

export function runnerStatePath(home = skeletonKeyHome()): string {
  return path.join(home, "runner.json");
}

export function readRunnerState(home = skeletonKeyHome()): RunnerState | null {
  const file = runnerStatePath(home);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof raw["url"] !== "string" || typeof raw["token"] !== "string") return null;
    return {
      url: raw["url"],
      token: raw["token"],
      pid: Number(raw["pid"] ?? 0),
      started: typeof raw["started"] === "string" ? raw["started"] : "",
      port: Number(raw["port"] ?? 0),
    };
  } catch {
    return null;
  }
}

export interface RunnerOptions {
  home?: string;
  port?: number;
  /** Loopback only. There is no option to bind anything else. */
  host?: string;
  token?: string;
  notifier?: Notifier;
  /**
   * Ladder rungs, in order. Defaults to bitwarden -> inbox -> popup. A
   * function receives the runner's own Secure Input Popup rung, so a test can
   * replace the first two rungs and keep the real third one.
   */
  secretSources?: SecretSource[] | ((popup: PopupSecretSource) => SecretSource[]);
  signupRunner?: SignupRunner;
  /** How an approved payment is submitted. Defaults to a human handoff. */
  paymentSubmitter?: PaymentSubmitter;
  allowlist?: Allowlist;
  /** Where log lines go, after redaction. Defaults to a file plus stderr. */
  logger?: (line: string) => void;
  /** Overridable so tests can point the index at a fixture. */
  apisFile?: string;
  apiShardDirs?: string[];
  userIndexFile?: string | null;
  ledger?: Ledger;
  /** Popup timeout in ms. 0 disables the timer (tests). */
  popupTimeoutMs?: number;
}

export interface RunnerHandle {
  url: string;
  port: number;
  token: string;
  home: string;
  requests: RequestStore;
  popups: PopupRegistry;
  allowlist: Allowlist;
  /** In-process only. Returns values, so it never crosses the HTTP boundary. */
  resolveSecret(request: SecretRequest): Promise<LadderResult>;
  /** The redactor every log line and file write goes through. */
  redactor: Redactor;
  log(line: string): void;
  close(): Promise<void>;
}

export async function startRunner(options: RunnerOptions = {}): Promise<RunnerHandle> {
  const home = options.home ?? skeletonKeyHome();
  ensureHome(home);
  const host = "127.0.0.1";
  const token = options.token ?? crypto.randomBytes(24).toString("hex");
  const redactor = globalRedactor;
  // The runner's own token is a credential: never print it.
  redactor.add(token);

  const logFile = path.join(home, "runner.log");
  const sink =
    options.logger ??
    ((line: string): void => {
      const stamped = `${new Date().toISOString()} ${line}\n`;
      try {
        fs.appendFileSync(logFile, stamped, { mode: 0o600 });
      } catch {
        // A log that cannot be written is not a reason to stop.
      }
      process.stderr.write(stamped);
    });
  const log = redactor.logger(sink);

  const requests = RequestStore.open(home);
  const popups = new PopupRegistry();
  const notifier = options.notifier ?? new OsNotifier();
  const ledger = options.ledger ?? openLedger(home);
  const ownLedger = options.ledger === undefined;
  const signup = options.signupRunner ?? new HumanHandoffSignupRunner();
  const payments = options.paymentSubmitter ?? new HumanHandoffPaymentSubmitter();

  const allowlist =
    options.allowlist ??
    buildAllowlist({
      home,
      ...(options.apisFile === undefined ? {} : { apisFile: options.apisFile }),
      ...(options.apiShardDirs === undefined ? {} : { shardDirs: options.apiShardDirs }),
      ...(options.userIndexFile === undefined ? {} : { userIndexFile: options.userIndexFile }),
    });

  /** The bound email from config.yaml, when `init` has run. */
  const email = (): string | null => {
    try {
      return readConfig(home).email;
    } catch {
      return null;
    }
  };

  let baseUrl = `http://${host}:${options.port ?? DEFAULT_RUNNER_PORT}`;
  const approvalUrl = (id: string): string => `${baseUrl}/approve/${id}`;
  const inputUrl = (id: string): string => `${baseUrl}/input/${id}`;

  const popupSource = new PopupSecretSource({
    registry: popups,
    urlFor: inputUrl,
    checkOrigin: (request) => allowlist.checkOrigin(request.origin, { vendor: request.vendor }),
    notifier,
    ...(options.popupTimeoutMs === undefined ? {} : { timeoutMs: options.popupTimeoutMs }),
    log,
  });
  /**
   * First secret use: if `bw` is missing, logged out or locked, the human gets
   * the steps (in the log and as one notification) instead of the agent being
   * asked to work around it. The master password is never part of this.
   */
  const bwGuidanceSink = (lines: string[]): void => {
    log("! Bitwarden cannot answer the first secret request of this session:");
    for (const line of lines) log(`  bitwarden: ${line}`);
    void notifier
      .notify({
        title: "SkeletonKey: Bitwarden needs you",
        body:
          "`bw` is not installed, not logged in, or locked, so SkeletonKey cannot read a secret " +
          "from it. The steps are in the runner log; SkeletonKey never asks for your master " +
          "password.",
      })
      .catch(() => {
        // A missing notifier is never a reason to stop; the log has the steps.
      });
  };

  const sources: SecretSource[] =
    options.secretSources === undefined
      ? [
          new BitwardenSecretSource(childProcessBw(), {
            boundEmail: email(),
            onGuidance: bwGuidanceSink,
          }),
          new BoundInboxSource(),
          popupSource,
        ]
      : typeof options.secretSources === "function"
        ? options.secretSources(popupSource)
        : options.secretSources;

  const resolve = (request: SecretRequest): Promise<LadderResult> =>
    resolveSecret(request, { sources, allowlist, redactor, log, notifier });

  // --- the flow ----------------------------------------------------------

  /**
   * Rows from this calendar month that carry a reported cost. Read on every
   * call rather than cached: the submit-time re-check has to see a ledger that
   * grew after the human approved something.
   */
  const costedRowsThisMonth = (): LedgerRow[] => {
    const prefix = new Date().toISOString().slice(0, 7);
    return ledger.all().filter((row) => row.timestamp.startsWith(prefix) && row.cost !== null);
  };

  /** Spend so far this calendar month, from the ledger's reported costs. */
  const monthToDate = (): number =>
    costedRowsThisMonth().reduce((total, row) => total + (row.cost ?? 0), 0);

  /**
   * Spend so far this month with one vendor. The ledger holds no vendor column,
   * so a row counts when its domain or alias matches the vendor's name or its
   * API domain -- which is what both the proxy and this file write.
   */
  const vendorToDate = (vendor: string, domain: string | null): number => {
    const names = new Set([vendor.toLowerCase(), ...(domain === null ? [] : [domain.toLowerCase()])]);
    return costedRowsThisMonth()
      .filter(
        (row) =>
          names.has(row.domain.toLowerCase()) ||
          (row.alias !== null && names.has(row.alias.toLowerCase())),
      )
      .reduce((total, row) => total + (row.cost ?? 0), 0);
  };

  function createRequest(input: CreateRequest): AccessRequest {
    const kill = killSwitchState(home);
    if (kill.engaged) {
      const refused = requests.create({
        ...input,
        status: "voided",
        reason:
          "The SkeletonKey kill switch is engaged, so no new request is raised. A human clears it " +
          "with `skeletonkey resume`.",
      });
      log(`! refused new request for ${input.vendor}: kill switch engaged`);
      return refused;
    }

    // An agent that polls `request_access` must not pile up approvals: one
    // pending request per vendor and kind is enough, and the human sees one
    // notification rather than ten.
    const open = requests
      .pending()
      .find(
        (request) =>
          request.kind === input.kind &&
          request.vendor.toLowerCase() === input.vendor.toLowerCase() &&
          // Two payments for the same vendor are only the same decision when
          // they are for the same money.
          (input.kind !== "payment" || (request.amount_usd ?? null) === (input.amount_usd ?? null)),
      );
    if (open !== undefined) {
      log(`request ${open.id}: reusing the pending approval for ${open.vendor}`);
      return open;
    }

    const policy = readPolicy(home);
    const spend = checkSpend({
      policy,
      vendor: input.vendor,
      amount_usd: input.amount_usd ?? input.est_budget_usd ?? null,
      month_to_date_usd: monthToDate(),
      vendor_to_date_usd: vendorToDate(input.vendor, input.domain ?? null),
    });
    const domainCheck =
      input.domain === undefined || input.domain === null
        ? null
        : allowlist.check(input.domain, {});
    const request = requests.create({
      ...input,
      domain_allowlisted: domainCheck?.allowed ?? false,
      asks_human_to_set_caps: spend.asks_human_to_set_caps,
      notes: [
        ...(input.notes ?? []),
        spend.reason,
        ...(domainCheck === null
          ? ["No API domain is known for this vendor yet, so no secret may be filled anywhere."]
          : [domainCheck.reason]),
      ],
    });
    log(
      `request ${request.id}: ${request.kind} for ${request.vendor} ` +
        `(est $${request.est_budget_usd ?? "unknown"}, caps_unset=${capsUnset(policy)}) -> ` +
        `${approvalUrl(request.id)}`,
    );
    void notifier
      .notify({
        title: `SkeletonKey: approve access to ${request.vendor}?`,
        body:
          `${request.purpose ?? "An agent asked for API access"}. ` +
          (spend.asks_human_to_set_caps
            ? "No spend caps are set yet -- you will be asked to set them."
            : `Estimated $${request.est_budget_usd ?? "unknown"}.`),
        url: approvalUrl(request.id),
      })
      .then((sent) => {
        if (!sent) {
          log(
            `(no OS notifier available; the approval URL is the line above) request ${request.id}`,
          );
        }
      })
      .catch(() => {
        // Notification failures are never fatal: the URL is in the log.
      });
    return request;
  }

  /**
   * What happens after a human clicks Approve: v0.3 hands straight to the
   * signup runner, which has no playbooks yet and so reports a human handoff.
   * On that outcome D14 applies -- the human is asked whether to route via the
   * cheapest aggregator instead, as a *new* approval.
   */
  async function runApproved(request: AccessRequest): Promise<AccessRequest> {
    if (request.kind !== "access") {
      // A cap change or an aggregator-route decision is complete the moment the
      // human makes it; there is no signup to drive.
      log(`request ${request.id}: ${request.kind} approved by human; nothing to run`);
      return request;
    }
    const lines: string[] = [];
    const outcome = await signup.run({
      vendor: request.vendor,
      domain: request.domain,
      signupUrl: null,
      email: email(),
      resolveSecret: async (secretRequest) => {
        const result = await resolve(secretRequest);
        return result.outcome.source === null ? null : result.outcome;
      },
      log: (line) => lines.push(redactor.redact(line)),
    });
    for (const line of lines) log(`request ${request.id}: ${line}`);

    if (outcome.status === "ready" && outcome.handle !== null) {
      return requests.update(
        request.id,
        { status: "ready", handle: outcome.handle, reason: outcome.reason },
        "runner",
        "signup completed",
      );
    }

    // Log the handoff to the ledger (D4: captcha/phone handoffs are logged).
    ledger.record({
      alias: null,
      domain: request.domain ?? request.vendor,
      status: null,
      bytes: 0,
      cost: null,
    });

    let followUp: AccessRequest | null = null;
    if (request.fallback_aggregator !== null && request.kind === "access") {
      followUp = requests.create({
        kind: "aggregator_route",
        vendor: request.vendor,
        domain: request.domain,
        purpose: request.purpose,
        est_budget_usd: request.est_budget_usd,
        fallback_aggregator: request.fallback_aggregator,
        fallback_price_usd: request.fallback_price_usd,
        reason:
          `Direct signup for ${request.vendor} did not complete (${outcome.reason}). Route via ` +
          `${request.fallback_aggregator}` +
          (request.fallback_price_usd === null
            ? " (no verified per-call price)"
            : ` at ~$${request.fallback_price_usd} per call`) +
          "? Nothing is routed without this approval (D14).",
        notes: [`Raised from ${request.id} after a direct-signup failure.`],
      });
      log(`request ${request.id}: raised ${followUp.id} to ask about the aggregator fallback (D14)`);
    }

    return requests.update(
      request.id,
      {
        status: outcome.status === "failed" ? "failed" : "needs_human",
        reason: outcome.reason,
        ...(followUp === null ? {} : { follow_up_id: followUp.id }),
      },
      "runner",
      outcome.reason,
    );
  }

  function approve(
    request: AccessRequest,
    decision: {
      globalCap?: number | undefined;
      vendorCap?: number | undefined;
    },
  ): { request: AccessRequest; policy: SpendPolicy } {
    let policy = readPolicy(home);
    if (decision.globalCap !== undefined || decision.vendorCap !== undefined) {
      // The one place caps move. `approval-page` authority, with the id of the
      // approval the human clicked.
      policy = setCaps(
        {
          ...(decision.globalCap === undefined
            ? {}
            : { global_monthly_cap_usd: decision.globalCap }),
          ...(decision.vendorCap === undefined
            ? {}
            : { vendor: request.vendor, vendor_cap_usd: decision.vendorCap }),
        },
        { by: "approval-page", request_id: request.id },
        home,
      );
      log(
        `request ${request.id}: human set caps -- global $${policy.global_monthly_cap_usd}, ` +
          `${request.vendor} $${vendorCap(policy, request.vendor)}`,
      );
    }
    const updated = requests.update(
      request.id,
      {
        status: "approved",
        approved_vendor_cap_usd: vendorCap(policy, request.vendor),
        reason: `Approved by the human on the local approval page.`,
      },
      "human",
      "approved",
    );
    log(`request ${request.id}: approved by human`);
    return { request: updated, policy };
  }

  /**
   * The payment chokepoint (B). The caps are re-checked here, immediately
   * before the submitter is called, against a freshly read policy and a freshly
   * read ledger -- because both can have moved since the human approved. A
   * payment that no longer fits is blocked, its approval is voided, and a new
   * approval is raised; nothing is submitted and nothing is charged.
   */
  async function submitPayment(request: AccessRequest): Promise<Record<string, unknown>> {
    if (submitting.has(request.id)) {
      // The store is a file, not a transaction log: two submits racing on one
      // approval could both pass the gate and charge twice. One at a time.
      log(`payment ${request.id}: refused -- a submit for it is already running`);
      return {
        submitted: false,
        blocked: true,
        blocked_code: "in_flight",
        reason: `A submit for ${request.id} is already running. Wait for it rather than retrying.`,
        needs_new_approval: false,
        request: view(request),
        new_request: null,
        spend_check: null,
      };
    }
    submitting.add(request.id);
    try {
      return await runSubmit(request);
    } finally {
      submitting.delete(request.id);
    }
  }

  /** One payment id at a time; `submitPayment` holds the lock. */
  const submitting = new Set<string>();

  async function runSubmit(request: AccessRequest): Promise<Record<string, unknown>> {
    const decision: PaymentSubmitDecision = gatePaymentSubmit({
      request,
      policy: readPolicy(home),
      requests,
      month_to_date_usd: monthToDate(),
      vendor_to_date_usd: vendorToDate(request.vendor, request.domain),
      killed: killSwitchState(home).engaged,
      raise: (input) => createRequest(input),
      log,
    });

    if (!decision.allowed) {
      if (decision.replacement !== null) {
        log(
          `payment ${request.id}: the human must decide again -> ` +
            `${approvalUrl(decision.replacement.id)}`,
        );
      }
      return {
        submitted: false,
        blocked: true,
        blocked_code: decision.code,
        reason: decision.reason,
        needs_new_approval: decision.replacement !== null,
        request: view(decision.request),
        new_request: decision.replacement === null ? null : view(decision.replacement),
        spend_check:
          decision.check === null
            ? null
            : {
                global_cap_usd: decision.check.global_cap_usd,
                vendor_cap_usd: decision.check.vendor_cap_usd,
                month_to_date_usd: decision.check.month_to_date_usd,
                vendor_to_date_usd: decision.check.vendor_to_date_usd,
                reason: decision.check.reason,
              },
        note:
          "The caps are checked when the approval is raised and again here, immediately before " +
          "the submit. The earlier approval is void; only the human can give a new one, on the " +
          "local approval page. You cannot raise a cap.",
      };
    }

    // Allowed: nothing happens between the gate and the submit.
    const lines: string[] = [];
    const outcome = await payments.submit({
      request_id: request.id,
      vendor: request.vendor,
      domain: request.domain,
      amount_usd: decision.amount_usd,
      log: (line) => lines.push(redactor.redact(line)),
    });
    for (const line of lines) log(`payment ${request.id}: ${line}`);

    // One ledger row per submit: the amount charged when there was one, null
    // when a human still has to finish it (unknown is not zero).
    const charged =
      outcome.status === "paid" ? (outcome.charged_usd ?? decision.amount_usd) : null;
    ledger.record({
      alias: null,
      domain: request.domain ?? request.vendor,
      status: null,
      bytes: 0,
      cost: charged,
    });

    const status = outcome.status === "paid" ? "ready" : outcome.status;
    const settled = requests.update(
      request.id,
      { status, reason: outcome.reason },
      "runner",
      `payment ${outcome.status}`,
    );
    log(
      `payment ${request.id}: ${outcome.status} (${outcome.reason})` +
        (charged === null ? ", nothing recorded as charged" : `, $${charged} recorded in the ledger`),
    );
    return {
      submitted: outcome.status === "paid",
      blocked: false,
      amount_usd: decision.amount_usd,
      charged_usd: charged,
      outcome: outcome.status,
      reason: outcome.reason,
      request: view(settled),
      submitter: payments.id,
      spend_check: {
        global_cap_usd: decision.check.global_cap_usd,
        vendor_cap_usd: decision.check.vendor_cap_usd,
        month_to_date_usd: decision.check.month_to_date_usd,
        vendor_to_date_usd: decision.check.vendor_to_date_usd,
        reason: decision.check.reason,
      },
    };
  }

  // --- HTTP --------------------------------------------------------------

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`! runner error: ${redactor.redact(message)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "runner_error" });
      else if (!res.writableEnded) res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? "";
    if (!isLoopbackAddress(remote)) {
      // Cannot happen while bound to 127.0.0.1, but the runner holds secrets:
      // check anyway rather than rely on the bind.
      sendJson(res, 403, { error: "loopback_only" });
      return;
    }
    const url = new URL(req.url ?? "/", baseUrl);
    const route = url.pathname;
    const method = req.method ?? "GET";

    if (route === "/health") {
      const kill = killSwitchState(home);
      sendJson(res, 200, {
        ok: true,
        runner: "skeletonkey",
        version: RUNNER_VERSION,
        kill_switch: kill.engaged,
        pending_requests: requests.pending().length,
      });
      return;
    }

    // --- human pages (loopback, no token, Host must be loopback) ---------
    if (route === "/" || route.startsWith("/approve/") || route.startsWith("/input/")) {
      if (!hostIsLoopback(req.headers.host)) {
        sendHtml(res, 403, page("Blocked", "<p>This page is served to localhost only.</p>"));
        return;
      }
      if (route === "/") {
        sendHtml(res, 200, indexPage(requests.pending(), killSwitchState(home).engaged));
        return;
      }
      const id = decodeURIComponent(route.split("/")[2] ?? "");
      if (route.startsWith("/approve/")) {
        await handleApprovalPage(req, res, id, method);
        return;
      }
      await handleInputPage(req, res, id, method);
      return;
    }

    // --- agent-facing API (token required) ------------------------------
    if (route.startsWith("/v1/")) {
      if (!tokenOk(req.headers[RUNNER_TOKEN_HEADER])) {
        sendJson(res, 401, {
          error: "unauthorized",
          hint: `Send the runner token as the ${RUNNER_TOKEN_HEADER} header. It is written to runner.json by \`skeletonkey runner\`.`,
        });
        return;
      }
      await handleApi(req, res, route, method);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    method: string,
  ): Promise<void> {
    if (route === "/v1/requests" && method === "POST") {
      const body = await readJson(req);
      const vendor = typeof body["vendor"] === "string" ? body["vendor"].trim() : "";
      if (vendor === "") {
        sendJson(res, 400, { error: "vendor_required" });
        return;
      }
      const request = createRequest({
        kind: "access",
        vendor,
        domain: typeof body["domain"] === "string" ? body["domain"] : null,
        purpose: typeof body["purpose"] === "string" ? body["purpose"] : null,
        est_budget_usd:
          typeof body["est_budget_usd"] === "number" && Number.isFinite(body["est_budget_usd"])
            ? body["est_budget_usd"]
            : null,
        tos_url: typeof body["tos_url"] === "string" ? body["tos_url"] : null,
        requires_payment: typeof body["requires_payment"] === "boolean" ? body["requires_payment"] : null,
        fallback_aggregator:
          typeof body["fallback_aggregator"] === "string" ? body["fallback_aggregator"] : null,
        fallback_price_usd:
          typeof body["fallback_price_usd"] === "number" ? body["fallback_price_usd"] : null,
        data_shared: ["the bound email address"],
      });
      sendJson(res, 200, view(request));
      return;
    }

    const match = /^\/v1\/requests\/([^/]+)(\/cancel)?$/.exec(route);
    if (match !== null) {
      const id = decodeURIComponent(match[1] ?? "");
      const request = requests.get(id);
      if (request === undefined) {
        sendJson(res, 404, { error: "unknown_request", request_id: id });
        return;
      }
      if (match[2] === "/cancel" && method === "POST") {
        const body = await readJson(req);
        const reason = typeof body["reason"] === "string" ? body["reason"] : null;
        const cancelled = requests.cancel(id, reason, "agent");
        log(`request ${id}: cancelled by agent${reason === null ? "" : ` (${reason})`}`);
        popups.cancelAll();
        sendJson(res, 200, view(cancelled));
        return;
      }
      if (method === "GET") {
        sendJson(res, 200, view(request));
        return;
      }
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (route === "/v1/payments" && method === "POST") {
      const body = await readJson(req);
      const vendor = typeof body["vendor"] === "string" ? body["vendor"].trim() : "";
      if (vendor === "") {
        sendJson(res, 400, { error: "vendor_required" });
        return;
      }
      const amount = typeof body["amount_usd"] === "number" ? body["amount_usd"] : Number.NaN;
      if (!Number.isFinite(amount) || amount <= 0) {
        sendJson(res, 400, {
          error: "amount_required",
          hint:
            "A payment needs an exact `amount_usd` greater than 0. An unknown amount is never " +
            "approved: unknown is not zero.",
        });
        return;
      }
      const request = createRequest({
        kind: "payment",
        vendor,
        domain: typeof body["domain"] === "string" ? body["domain"] : null,
        purpose: typeof body["purpose"] === "string" ? body["purpose"] : null,
        amount_usd: amount,
        // The request-time check reads the same number the submit-time one will.
        est_budget_usd: amount,
        requires_payment: true,
        tos_url: typeof body["tos_url"] === "string" ? body["tos_url"] : null,
        data_shared: ["the bound email address", "the card the human enters on the vendor's checkout"],
        notes: [
          "The caps are checked now and again immediately before the submit. If a cap has been " +
            "lowered or the ledger has grown by then, this approval is voided and the human is " +
            "asked again.",
        ],
      });
      sendJson(res, 200, view(request));
      return;
    }

    const submit = /^\/v1\/payments\/([^/]+)\/submit$/.exec(route);
    if (submit !== null) {
      if (method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const id = decodeURIComponent(submit[1] ?? "");
      const request = requests.get(id);
      if (request === undefined) {
        sendJson(res, 404, { error: "unknown_request", request_id: id });
        return;
      }
      sendJson(res, 200, await submitPayment(request));
      return;
    }

    if (route === "/v1/policy" && method === "GET") {
      // Read-only on purpose: there is no POST here. Caps move on the
      // approval page or in the CLI, never through the agent's channel (D5).
      sendJson(res, 200, policyView(readPolicy(home)));
      return;
    }

    if (route === "/v1/allowlist" && method === "GET") {
      sendJson(res, 200, { domains: allowlist.domains().length, sample: allowlist.domains().slice(0, 20) });
      return;
    }

    if (route === "/v1/kill" && method === "POST") {
      const body = await readJson(req);
      const reason = typeof body["reason"] === "string" ? body["reason"] : "kill switch";
      sendJson(res, 200, engage(reason, "agent"));
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  function engage(reason: string, by: string): Record<string, unknown> {
    const state = engageKillSwitch({ reason, by }, home);
    const voided = requests.voidPending("Voided by the SkeletonKey kill switch.");
    const popupsCancelled = popups.cancelAll();
    log(
      `! kill switch engaged by ${by}: ${reason} -- ${voided.length} pending approval(s) voided, ` +
        `${popupsCancelled} secure input(s) cancelled`,
    );
    return {
      kill_switch: state.engaged,
      engaged_at: state.at,
      reason: state.reason,
      voided_requests: voided.map((request) => request.id),
      secure_inputs_cancelled: popupsCancelled,
      note:
        "The proxy now refuses every call locally and the runner accepts no new requests. Only a " +
        "human clears this, with `skeletonkey resume`.",
    };
  }

  async function handleApprovalPage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    method: string,
  ): Promise<void> {
    const request = requests.get(id);
    if (request === undefined) {
      sendHtml(res, 404, page("Unknown request", `<p>No request <code>${escapeHtml(id)}</code>.</p>`));
      return;
    }
    if (method === "GET") {
      sendHtml(res, 200, approvalPage(request, readPolicy(home)));
      return;
    }
    if (method !== "POST") {
      sendHtml(res, 405, page("Not allowed", "<p>Use the buttons on the approval page.</p>"));
      return;
    }
    const form = await readForm(req);
    if (form["page_token"] !== request.page_token) {
      sendHtml(res, 403, page("Blocked", "<p>Stale or missing form token. Reload the page.</p>"));
      return;
    }
    const action = form["action"] ?? "";

    if (action === "kill") {
      const result = engage("Kill switch pressed on the approval page.", "approval-page");
      sendHtml(
        res,
        200,
        page(
          "Kill switch engaged",
          `<p>Every pending approval is voided and the proxy refuses calls. ` +
            `Clear it with <code>skeletonkey resume</code>.</p><pre>${escapeHtml(
              JSON.stringify(result, null, 2),
            )}</pre>`,
        ),
      );
      return;
    }

    if (action === "deny") {
      const updated = requests.update(
        request.id,
        { status: "denied", reason: "Denied by the human on the local approval page." },
        "human",
        "denied",
      );
      log(`request ${request.id}: denied by human`);
      sendHtml(
        res,
        200,
        page("Denied", `<p>${escapeHtml(updated.vendor)} was denied. The agent sees <code>denied</code>.</p>`),
      );
      return;
    }

    if (action !== "approve") {
      sendHtml(res, 400, page("Unknown action", "<p>Use Approve, Deny, or the kill switch.</p>"));
      return;
    }

    const globalCap = parseMoney(form["global_cap"]);
    const vendorCapInput = parseMoney(form["vendor_cap"]);
    if (request.asks_human_to_set_caps && globalCap === undefined && vendorCapInput === undefined) {
      // D11: the first paid action asks for both caps. Approving with every cap
      // still at $0 would be an approval that cannot be acted on, so say so
      // rather than record a decision that means nothing.
      sendHtml(
        res,
        200,
        approvalPage(
          request,
          readPolicy(home),
          "Nothing was approved: every cap is still $0, so set a cap for this vendor and a global " +
            "monthly cap first. There are no suggested numbers -- they are yours to choose.",
        ),
      );
      return;
    }
    const { request: approved, policy } = approve(request, {
      globalCap,
      vendorCap: vendorCapInput,
    });
    const settled = await runApproved(approved);
    sendHtml(
      res,
      200,
      page(
        "Approved",
        `<p>${escapeHtml(settled.vendor)} approved. The agent now sees ` +
          `<code>${escapeHtml(settled.status)}</code>` +
          (settled.reason === null ? "" : ` (${escapeHtml(settled.reason)})`) +
          `.</p><p>Caps now: global <strong>$${policy.global_monthly_cap_usd}</strong>, ` +
          `${escapeHtml(settled.vendor)} <strong>$${vendorCap(policy, settled.vendor)}</strong>.</p>` +
          (settled.follow_up_id === null
            ? ""
            : `<p>Direct signup did not complete, so a second approval asks about the aggregator ` +
              `fallback: <a href="/approve/${escapeHtml(settled.follow_up_id)}">decide that one</a>.</p>`),
      ),
    );
  }

  async function handleInputPage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    method: string,
  ): Promise<void> {
    const entry = popups.get(id);
    if (entry === undefined) {
      sendHtml(res, 404, page("Unknown input request", "<p>Nothing is waiting for a value.</p>"));
      return;
    }
    if (method === "GET") {
      sendHtml(res, 200, inputPage(entry));
      return;
    }
    if (method !== "POST") {
      sendHtml(res, 405, page("Not allowed", "<p>Use the form.</p>"));
      return;
    }
    const form = await readForm(req);
    if (form["action"] === "cancel") {
      popups.cancel(id);
      log(`secure-input ${id}: cancelled by the human`);
      sendHtml(res, 200, page("Cancelled", "<p>Nothing was submitted.</p>"));
      return;
    }
    const value = form["value"] ?? "";
    const ok = popups.submit(id, form["token"] ?? "", value);
    // Never log, echo, or store the value. Length only.
    log(
      `secure-input ${id}: ${ok ? "filled" : "rejected"} (${entry.secret_class} for ${entry.vendor}, ` +
        `${value.length} chars, value not logged)`,
    );
    sendHtml(
      res,
      200,
      ok
        ? page(
            "Received",
            "<p>The value went straight to the SkeletonKey runner. It was not logged, not stored " +
              "outside your vault, and never shown to the agent.</p>",
          )
        : page(
            "Not accepted",
            "<p>That input request is no longer pending, the form token did not match, or the " +
              "field was empty. Nothing was submitted.</p>",
          ),
    );
  }

  function view(request: AccessRequest): PublicRequest & Record<string, unknown> {
    return {
      ...publicRequest(request, approvalUrl(request.id)),
      // Extra context an agent may safely see: never a secret, never a cap it
      // could act on.
      kind: request.kind,
      amount_usd: request.amount_usd,
      asks_human_to_set_caps: request.asks_human_to_set_caps,
      domain_allowlisted: request.domain_allowlisted,
      follow_up_request_id: request.follow_up_id,
    };
  }

  function tokenOk(provided: string | string[] | undefined): boolean {
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (typeof value !== "string" || value.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value, "utf8"), Buffer.from(token, "utf8"));
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_RUNNER_PORT, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://${host}:${address.port}`;

  const state: RunnerState = {
    url: baseUrl,
    token,
    pid: process.pid,
    started: new Date().toISOString(),
    port: address.port,
  };
  const stateFile = runnerStatePath(home);
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
  log(`runner listening on ${baseUrl} (home: ${home}, allowlist: ${allowlist.size} domains)`);

  return {
    url: baseUrl,
    port: address.port,
    token,
    home,
    requests,
    popups,
    allowlist,
    resolveSecret: resolve,
    redactor,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        popups.cancelAll();
        server.closeAllConnections();
        server.close(() => {
          if (ownLedger) ledger.close();
          try {
            if (fs.existsSync(stateFile)) fs.rmSync(stateFile);
          } catch {
            // Leaving a stale state file behind is survivable; the client
            // health-checks before trusting it.
          }
          resolve();
        });
      }),
  };
}

export const RUNNER_VERSION = "0.3.0";

// --- helpers --------------------------------------------------------------

function isLoopbackAddress(address: string): boolean {
  const value = address.replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value.startsWith("127.");
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1" || name.startsWith("127.");
}

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (body.trim() === "") return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [name, value] of params) out[name] = value;
  return out;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "cache-control": "no-store",
    // The pages carry no secrets, but they do carry decisions.
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(html);
}

function parseMoney(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.replace(/[$,]/g, "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { width: 12rem; color: #444; font-weight: 600; }
  .warn { background: #fff6d6; border: 1px solid #e0c86a; padding: .6rem .8rem; border-radius: 6px; }
  .bad { background: #ffe9e9; border: 1px solid #e09a9a; padding: .6rem .8rem; border-radius: 6px; }
  button { font: inherit; padding: .45rem .9rem; margin-right: .5rem; }
  input[type=number], input[type=password] { font: inherit; padding: .35rem; width: 12rem; }
  code { background: #f3f3f3; padding: 0 .2rem; }
  footer { margin-top: 2rem; color: #666; font-size: .85rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>SkeletonKey — ${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}
<footer>SkeletonKey runner, localhost only. Nothing on this page is shown to the agent.</footer>
</body></html>`;
}

function indexPage(pending: AccessRequest[], killed: boolean): string {
  const rows =
    pending.length === 0
      ? "<p>Nothing is waiting for you.</p>"
      : `<ul>${pending
          .map(
            (request) =>
              `<li><a href="/approve/${escapeHtml(request.id)}">${escapeHtml(request.vendor)}</a> — ` +
              `${escapeHtml(request.purpose ?? "no purpose given")}</li>`,
          )
          .join("")}</ul>`;
  return page(
    "Pending approvals",
    (killed
      ? `<p class="bad">The kill switch is engaged. Clear it with <code>skeletonkey resume</code>.</p>`
      : "") + rows,
  );
}

function approvalPage(request: AccessRequest, policy: SpendPolicy, problem?: string): string {
  const settled = request.status !== "pending_approval";
  const capsAreUnset = capsUnset(policy);
  const vendorCapNow = vendorCap(policy, request.vendor);
  const details = `
    <table>
      <tr><th>Vendor</th><td>${escapeHtml(request.vendor)}</td></tr>
      <tr><th>What for</th><td>${escapeHtml(request.purpose ?? "not stated")}</td></tr>
      <tr><th>Agent's estimate</th><td>${
        request.est_budget_usd === null
          ? "unknown (and unknown is not zero)"
          : `$${request.est_budget_usd}`
      }</td></tr>
      ${
        request.amount_usd === null
          ? ""
          : `<tr><th>Payment amount</th><td><strong>$${request.amount_usd}</strong> — checked
              against the caps now <em>and again immediately before it is submitted</em>. If a cap
              is lower or more has been spent by then, this approval is voided and you are asked
              again.</td></tr>`
      }
      <tr><th>Terms of service</th><td>${
        request.tos_url === null
          ? "no link recorded in the index — read the vendor's own terms"
          : `<a href="${escapeHtml(request.tos_url)}" rel="noreferrer noopener">${escapeHtml(request.tos_url)}</a>`
      }</td></tr>
      <tr><th>Data shared</th><td>${
        request.data_shared.length === 0 ? "nothing" : escapeHtml(request.data_shared.join(", "))
      }</td></tr>
      <tr><th>Payment expected</th><td>${
        request.requires_payment === null ? "unknown" : request.requires_payment ? "yes" : "no"
      }</td></tr>
      <tr><th>API domain</th><td>${escapeHtml(request.domain ?? "unknown")} ${
        request.domain_allowlisted ? "(allowlisted)" : "(<strong>not</strong> allowlisted)"
      }</td></tr>
      <tr><th>Aggregator fallback</th><td>${
        request.fallback_aggregator === null
          ? "none offered"
          : `${escapeHtml(request.fallback_aggregator)}${
              request.fallback_price_usd === null
                ? " (no verified per-call price)"
                : ` at ~$${request.fallback_price_usd} per call`
            }`
      }</td></tr>
      <tr><th>Status</th><td><code>${escapeHtml(request.status)}</code></td></tr>
      <tr><th>Request id</th><td><code>${escapeHtml(request.id)}</code></td></tr>
    </table>
    ${
      request.notes.length === 0
        ? ""
        : `<ul>${request.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    }`;

  if (settled) {
    return page(
      `${request.vendor} — ${request.status}`,
      `${details}<p>This request is settled. Agents can cancel a request; only you can approve one.</p>
       <form method="post"><input type="hidden" name="page_token" value="${escapeHtml(request.page_token)}">
       <button name="action" value="kill">Engage kill switch</button></form>`,
    );
  }

  const problemBlock = problem === undefined ? "" : `<p class="bad">${escapeHtml(problem)}</p>`;
  const capBlock = capsAreUnset
    ? `<p class="warn"><strong>No spend caps are set yet.</strong> Every cap defaults to $0, so
        nothing can be spent until you set one here. There are no preset numbers: pick your own.</p>`
    : `<p>Current caps: global <strong>$${policy.global_monthly_cap_usd}</strong> per month,
        ${escapeHtml(request.vendor)} <strong>$${vendorCapNow}</strong>. Raising them is only
        possible here — an agent can never do it.</p>`;

  return page(
    `Approve access to ${request.vendor}?`,
    `${details}
     ${problemBlock}
     ${capBlock}
     <form method="post">
       <input type="hidden" name="page_token" value="${escapeHtml(request.page_token)}">
       <p><label>Global monthly cap (USD)<br>
         <input type="number" name="global_cap" min="0" step="0.01"
           value="${policy.global_monthly_cap_usd > 0 ? policy.global_monthly_cap_usd : ""}"
           placeholder="you decide"></label></p>
       <p><label>Cap for ${escapeHtml(request.vendor)} (USD)<br>
         <input type="number" name="vendor_cap" min="0" step="0.01"
           value="${vendorCapNow > 0 ? vendorCapNow : ""}" placeholder="you decide"></label></p>
       <p>
         <button name="action" value="approve">Approve</button>
         <button name="action" value="deny">Deny</button>
         <button name="action" value="kill">Engage kill switch</button>
       </p>
     </form>
     <p>You are the only one who presses these. The agent sees a status, never this page.</p>`,
  );
}

function inputPage(entry: {
  id: string;
  vendor: string;
  field: string;
  origin: string;
  secret_class: string;
  reason: string | null;
  origin_verified: boolean;
  origin_detail: string;
  status: string;
  token: string;
}): string {
  if (entry.status !== "pending") {
    return page(
      "Secure input",
      `<p>This request is <code>${escapeHtml(entry.status)}</code>.</p>
       <p class="${entry.origin_verified ? "warn" : "bad"}">${escapeHtml(entry.origin_detail)}</p>`,
    );
  }
  return page(
    `Secure input — ${entry.field}`,
    `<table>
       <tr><th>Vendor</th><td>${escapeHtml(entry.vendor)}</td></tr>
       <tr><th>Requested</th><td>${escapeHtml(entry.field)} (<code>${escapeHtml(entry.secret_class)}</code>)</td></tr>
       <tr><th>Goes to</th><td><code>${escapeHtml(entry.origin)}</code></td></tr>
       <tr><th>Origin check</th><td>${
         entry.origin_verified ? "verified against the API index allowlist" : "<strong>FAILED</strong>"
       }<br>${escapeHtml(entry.origin_detail)}</td></tr>
       ${entry.reason === null ? "" : `<tr><th>Why</th><td>${escapeHtml(entry.reason)}</td></tr>`}
     </table>
     <p class="warn">Check the domain above before typing. SkeletonKey only fills values on domains
       the API index vouches for, and this value goes to the runner only: not to the agent, not to a
       log, not to this page's response.</p>
     <form method="post" autocomplete="off">
       <input type="hidden" name="token" value="${escapeHtml(entry.token)}">
       <p><label>${escapeHtml(entry.field)}<br>
         <input type="password" name="value" autocomplete="off" autocapitalize="off"
           spellcheck="false" autofocus></label></p>
       <p><button name="action" value="submit">Send to the runner</button>
          <button name="action" value="cancel">Cancel</button></p>
     </form>`,
  );
}
