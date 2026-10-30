/**
 * The submit-time cap re-check (B).
 *
 * Nothing here touches a real vault, a real card, or a real vendor: the vault
 * is the test-only `file` backend inside a temp SKELETONKEY_HOME, and the
 * payment submitter is a fake that reports an outcome without moving money.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killSwitchState, releaseKillSwitch } from "../src/killswitch.js";
import { openLedger } from "../src/ledger.js";
import type { Notification, Notifier } from "../src/notify.js";
import {
  gatePaymentSubmit,
  HumanHandoffPaymentSubmitter,
  type PaymentSubmitContext,
  type PaymentSubmitOutcome,
  type PaymentSubmitter,
} from "../src/payments.js";
import { readPolicy, setCaps, vendorCap } from "../src/policy.js";
import { RequestStore } from "../src/requests.js";
import { RunnerClient } from "../src/runner/client.js";
import { startRunner, type RunnerHandle } from "../src/runner/server.js";
import { initWithKey, makeHome, removeHome, REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");

class RecordingNotifier implements Notifier {
  readonly id = "recording";
  readonly sent: Notification[] = [];
  async notify(notification: Notification): Promise<boolean> {
    this.sent.push(notification);
    return true;
  }
}

/** Reports a payment as paid without going anywhere near a card. */
class FakePaidSubmitter implements PaymentSubmitter {
  readonly id = "fake-paid";
  readonly submitted: PaymentSubmitContext[] = [];
  /** Set to hold a submit open, so a second one can race it. */
  hold: Promise<void> | null = null;
  async submit(context: PaymentSubmitContext): Promise<PaymentSubmitOutcome> {
    this.submitted.push(context);
    if (this.hold !== null) await this.hold;
    context.log(`fake submitter charged $${context.amount_usd}`);
    return { status: "paid", reason: "fake_receipt", charged_usd: context.amount_usd };
  }
}

interface Started {
  home: string;
  runner: RunnerHandle;
  client: RunnerClient;
  notifier: RecordingNotifier;
  submitter: FakePaidSubmitter;
  logs: string[];
}

async function start(): Promise<Started> {
  const home = makeHome();
  await initWithKey(home, { secret: "sk-test-FAKE-payment-0001", domain: "api.tikhub.io" });
  const notifier = new RecordingNotifier();
  const submitter = new FakePaidSubmitter();
  const logs: string[] = [];
  const runner = await startRunner({
    home,
    port: 0,
    notifier,
    apisFile: APIS_YAML,
    apiShardDirs: [],
    popupTimeoutMs: 0,
    paymentSubmitter: submitter,
    logger: (line) => logs.push(line),
  });
  return { home, runner, notifier, submitter, logs, client: new RunnerClient(runner.url, runner.token) };
}

async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: await response.text() };
}

describe("the submit-time spend cap re-check", () => {
  let started: Started;

  beforeEach(async () => {
    started = await start();
  });

  afterEach(async () => {
    await started.runner.close();
    removeHome(started.home);
  });

  /** Raises a payment approval and has the human approve it on the page. */
  async function approvedPayment(
    amount: number,
    caps: { global?: string; vendor?: string } = {},
  ): Promise<string> {
    const created = await started.client.createPayment({
      vendor: "TikHub",
      domain: "api.tikhub.io",
      purpose: "top up the TikHub balance",
      amount_usd: amount,
    });
    const request = started.runner.requests.get(created.request_id);
    const result = await postForm(created.approval_url ?? "", {
      page_token: request?.page_token ?? "",
      action: "approve",
      ...(caps.global === undefined ? {} : { global_cap: caps.global }),
      ...(caps.vendor === undefined ? {} : { vendor_cap: caps.vendor }),
    });
    expect(result.status).toBe(200);
    expect(started.runner.requests.get(created.request_id)?.status).toBe("approved");
    return created.request_id;
  }

  it("checks the caps when the payment is raised, before any approval exists", async () => {
    const created = await started.client.createPayment({
      vendor: "TikHub",
      domain: "api.tikhub.io",
      amount_usd: 4,
    });
    expect(created.kind).toBe("payment");
    expect(created.status).toBe("pending_approval");
    expect(created["amount_usd"]).toBe(4);
    expect(created["asks_human_to_set_caps"]).toBe(true);
    expect(created.notes.join(" ")).toMatch(/again immediately before the submit/);
    // The page tells the human the amount is re-checked at submit.
    const page = await (await fetch(created.approval_url ?? "")).text();
    expect(page).toMatch(/Payment amount/);
    expect(page).toMatch(/again immediately before it is submitted/);
  });

  it("refuses to raise a payment with no exact amount", async () => {
    for (const body of [{}, { amount_usd: 0 }, { amount_usd: -3 }, { amount_usd: "5" }]) {
      const response = await fetch(`${started.runner.url}/v1/payments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-skeletonkey-runner-token": started.runner.token,
        },
        body: JSON.stringify({ vendor: "TikHub", ...body }),
      });
      expect(response.status).toBe(400);
      expect((await response.json())["error"]).toBe("amount_required");
    }
    expect(started.runner.requests.list()).toHaveLength(0);
  });

  it("submits when the caps still allow it at submit time", async () => {
    const id = await approvedPayment(5, { global: "25", vendor: "10" });
    const result = await started.client.submitPayment(id);
    expect(result["submitted"]).toBe(true);
    expect(result["blocked"]).toBe(false);
    expect(result["charged_usd"]).toBe(5);
    expect(started.submitter.submitted).toHaveLength(1);
    expect(started.submitter.submitted[0]?.amount_usd).toBe(5);
    expect((await started.client.getRequest(id)).status).toBe("ready");
    // The charge lands in the ledger, which is what the next re-check reads.
    const ledger = openLedger(started.home);
    expect(ledger.summary().cost_usd).toBe(5);
    ledger.close();
  });

  it("blocks the submit when a cap was lowered after the approval, and asks again", async () => {
    const id = await approvedPayment(8, { global: "25", vendor: "10" });
    // The human changes their mind on the caps -- the one place caps move.
    setCaps({ vendor: "TikHub", vendor_cap_usd: 5 }, { by: "cli" }, started.home);

    const result = await started.client.submitPayment(id);
    expect(result["submitted"]).toBe(false);
    expect(result["blocked"]).toBe(true);
    expect(result["blocked_code"]).toBe("over_cap");
    expect(result["needs_new_approval"]).toBe(true);
    expect(String(result["reason"])).toMatch(/\$5 cap/);
    // Nothing was submitted and nothing was charged.
    expect(started.submitter.submitted).toHaveLength(0);
    const ledger = openLedger(started.home);
    expect(ledger.summary().cost_usd).toBeNull();
    ledger.close();

    // The prior approval is void -- terminal, so it cannot be submitted again.
    const prior = await started.client.getRequest(id);
    expect(prior.status).toBe("voided");
    const again = await started.client.submitPayment(id);
    expect(again["blocked"]).toBe(true);
    expect(again["blocked_code"]).toBe("not_approved");
    expect(started.submitter.submitted).toHaveLength(0);

    // And a fresh approval is waiting for the human, with the same amount.
    const replacement = result["new_request"] as Record<string, unknown>;
    expect(replacement["status"]).toBe("pending_approval");
    expect(replacement["amount_usd"]).toBe(8);
    expect(replacement["request_id"]).not.toBe(id);
    expect(started.runner.requests.get(String(replacement["request_id"]))?.notes.join(" ")).toMatch(
      /voided by the submit-time cap re-check/,
    );
    expect(started.notifier.sent.at(-1)?.url).toContain(String(replacement["request_id"]));
  });

  it("blocks the submit when the ledger grew past the cap after the approval", async () => {
    // Two payments of $6 each are approved while the vendor cap is $10: the
    // first fits, and the second no longer does once the first is recorded.
    const first = await approvedPayment(6, { global: "25", vendor: "10" });
    const firstResult = await started.client.submitPayment(first);
    expect(firstResult["submitted"]).toBe(true);

    const second = await approvedPayment(6);
    const blocked = await started.client.submitPayment(second);
    expect(blocked["submitted"]).toBe(false);
    expect(blocked["blocked_code"]).toBe("over_cap");
    expect(blocked["needs_new_approval"]).toBe(true);
    expect(started.submitter.submitted).toHaveLength(1);
    expect((blocked["spend_check"] as Record<string, unknown>)["vendor_to_date_usd"]).toBe(6);
    expect((await started.client.getRequest(second)).status).toBe("voided");
    // The caps themselves did not move: only the ledger did.
    expect(vendorCap(readPolicy(started.home), "TikHub")).toBe(10);
  });

  it("blocks the submit when the ledger grew past the global monthly cap", async () => {
    const id = await approvedPayment(4, { global: "10", vendor: "50" });
    // Spend recorded elsewhere this month -- a proxied call whose cost the
    // upstream reported, under a different alias and domain.
    const ledger = openLedger(started.home);
    ledger.record({ alias: "other-personal", domain: "api.other.test", status: 200, bytes: 10, cost: 7 });
    ledger.close();

    const result = await started.client.submitPayment(id);
    expect(result["blocked"]).toBe(true);
    expect(result["blocked_code"]).toBe("over_cap");
    expect(String(result["reason"])).toMatch(/global monthly cap/);
    const check = result["spend_check"] as Record<string, unknown>;
    expect(check["month_to_date_usd"]).toBe(7);
    // That spend was someone else's vendor, so the vendor total is untouched.
    expect(check["vendor_to_date_usd"]).toBe(0);
    expect(started.submitter.submitted).toHaveLength(0);
  });

  it("re-approving the replacement with a cap that fits lets the submit through", async () => {
    const id = await approvedPayment(8, { global: "25", vendor: "10" });
    setCaps({ vendor: "TikHub", vendor_cap_usd: 5 }, { by: "cli" }, started.home);
    const blocked = await started.client.submitPayment(id);
    const replacementId = String(
      (blocked["new_request"] as Record<string, unknown>)["request_id"],
    );

    // The human decides again, on their own page, and raises the cap there.
    const replacement = started.runner.requests.get(replacementId);
    await postForm(`${started.runner.url}/approve/${replacementId}`, {
      page_token: replacement?.page_token ?? "",
      action: "approve",
      global_cap: "25",
      vendor_cap: "20",
    });
    const result = await started.client.submitPayment(replacementId);
    expect(result["submitted"]).toBe(true);
    expect(result["charged_usd"]).toBe(8);
    expect(started.submitter.submitted).toHaveLength(1);
  });

  it("will not submit a payment the human has not approved yet", async () => {
    const created = await started.client.createPayment({ vendor: "TikHub", amount_usd: 3 });
    const result = await started.client.submitPayment(created.request_id);
    expect(result["blocked"]).toBe(true);
    expect(result["blocked_code"]).toBe("not_approved");
    expect(result["needs_new_approval"]).toBe(false);
    expect(started.submitter.submitted).toHaveLength(0);
    // The pending approval is left exactly as it was.
    expect((await started.client.getRequest(created.request_id)).status).toBe("pending_approval");
  });

  it("will not submit an access request as if it were a payment", async () => {
    const created = await started.client.createRequest({ vendor: "Apify", est_budget_usd: 2 });
    const result = await started.client.submitPayment(created.request_id);
    expect(result["blocked_code"]).toBe("not_a_payment");
    expect(started.submitter.submitted).toHaveLength(0);
  });

  it("voids an approved payment, and submits nothing, once the kill switch is engaged", async () => {
    const id = await approvedPayment(5, { global: "25", vendor: "10" });
    await started.client.kill("test");
    expect(killSwitchState(started.home).engaged).toBe(true);

    const result = await started.client.submitPayment(id);
    expect(result["blocked_code"]).toBe("kill_switch");
    expect(result["needs_new_approval"]).toBe(false);
    expect(started.submitter.submitted).toHaveLength(0);
    expect((await started.client.getRequest(id)).status).toBe("voided");
    releaseKillSwitch(started.home);
  });

  it("runs one submit at a time, so a racing retry cannot charge twice", async () => {
    const id = await approvedPayment(5, { global: "25", vendor: "10" });
    let release = (): void => {};
    started.submitter.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = started.client.submitPayment(id);
    // Let the first submit reach the (held) submitter before racing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await started.client.submitPayment(id);
    expect(second["blocked_code"]).toBe("in_flight");
    expect(second["submitted"]).toBe(false);

    release();
    expect((await first)["submitted"]).toBe(true);
    expect(started.submitter.submitted).toHaveLength(1);
    const ledger = openLedger(started.home);
    expect(ledger.summary().cost_usd).toBe(5);
    ledger.close();
  });

  it("answers 404 for an unknown payment id and 405 for the wrong method", async () => {
    const unknown = await fetch(`${started.runner.url}/v1/payments/req_nope/submit`, {
      method: "POST",
      headers: { "x-skeletonkey-runner-token": started.runner.token },
    });
    expect(unknown.status).toBe(404);
    const wrongMethod = await fetch(`${started.runner.url}/v1/payments/req_nope/submit`, {
      headers: { "x-skeletonkey-runner-token": started.runner.token },
    });
    expect(wrongMethod.status).toBe(405);
    // And the whole payment surface is behind the runner token.
    const noToken = await fetch(`${started.runner.url}/v1/payments`, { method: "POST" });
    expect(noToken.status).toBe(401);
  });

  it("logs the re-check without ever logging a card or a token", async () => {
    const id = await approvedPayment(5, { global: "25", vendor: "10" });
    await started.client.submitPayment(id);
    const log = started.logs.join("\n");
    expect(log).toMatch(/submit allowed/);
    expect(log).not.toContain(started.runner.token);
  });
});

describe("the payment gate on its own", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("blocks a payment whose amount is unknown, because unknown is not zero", () => {
    setCaps({ global_monthly_cap_usd: 50, vendor: "TikHub", vendor_cap_usd: 20 }, { by: "cli" }, home);
    const requests = RequestStore.open(home);
    // A store written before amounts existed: no amount at all on the request.
    const request = requests.create({ kind: "payment", vendor: "TikHub" });
    const approved = requests.update(request.id, { status: "approved" }, "human");
    const raised: string[] = [];
    const decision = gatePaymentSubmit({
      request: approved,
      policy: readPolicy(home),
      requests,
      month_to_date_usd: 0,
      vendor_to_date_usd: 0,
      raise: (input) => {
        raised.push(input.kind);
        return requests.create(input);
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("amount_unknown");
    expect(requests.get(request.id)?.status).toBe("voided");
    expect(raised).toEqual(["payment"]);
  });

  it("v0.3 submits nothing itself: the default submitter is a human handoff", async () => {
    const outcome = await new HumanHandoffPaymentSubmitter().submit({
      request_id: "req_0000000000000000",
      vendor: "TikHub",
      domain: "api.tikhub.io",
      amount_usd: 5,
      log: () => {},
    });
    expect(outcome.status).toBe("needs_human");
    expect(outcome.reason).toBe("no_card_automation");
    expect(outcome.charged_usd).toBeNull();
  });
});
