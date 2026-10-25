import fs from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAllowlist } from "../src/allowlist.js";
import { killSwitchState, releaseKillSwitch } from "../src/killswitch.js";
import { NoopNotifier, type Notification, type Notifier } from "../src/notify.js";
import { readPolicy, vendorCap } from "../src/policy.js";
import { RequestStore } from "../src/requests.js";
import { RunnerClient } from "../src/runner/client.js";
import {
  readRunnerState,
  RUNNER_TOKEN_HEADER,
  startRunner,
  type RunnerHandle,
} from "../src/runner/server.js";
import type { SignupContext, SignupOutcome, SignupRunner } from "../src/signup/types.js";
import { initWithKey, makeHome, removeHome, REPO_ROOT } from "./helpers/env.js";

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const SECRET = "sk-test-FAKE-runner-canary-0xFEEDFACE";

/** Captures notifications instead of calling notify-send. */
class RecordingNotifier implements Notifier {
  readonly id = "recording";
  readonly sent: Notification[] = [];
  async notify(notification: Notification): Promise<boolean> {
    this.sent.push(notification);
    return true;
  }
}

/** A signup runner that reports success, so the ready path is exercised too. */
class ReadySignupRunner implements SignupRunner {
  readonly id = "fake-ready";
  playbookFor(): null {
    return null;
  }
  async run(context: SignupContext): Promise<SignupOutcome> {
    context.log("fake playbook finished");
    return { status: "ready", handle: "key_fake_01", reason: "playbook_complete", log: [] };
  }
}

interface Started {
  home: string;
  runner: RunnerHandle;
  client: RunnerClient;
  notifier: RecordingNotifier;
  logs: string[];
}

async function start(
  options: { signupRunner?: SignupRunner; home?: string } = {},
): Promise<Started> {
  const home = options.home ?? makeHome();
  await initWithKey(home, { secret: SECRET, domain: "api.voyageai.com" });
  const notifier = new RecordingNotifier();
  const logs: string[] = [];
  const runner = await startRunner({
    home,
    port: 0,
    notifier,
    apisFile: APIS_YAML,
    apiShardDirs: [],
    popupTimeoutMs: 0,
    logger: (line) => logs.push(line),
    ...(options.signupRunner === undefined ? {} : { signupRunner: options.signupRunner }),
  });
  return { home, runner, notifier, logs, client: new RunnerClient(runner.url, runner.token) };
}

/** A GET with a Host header of our choosing, which `fetch` refuses to send. */
function rawGet(port: number, route: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${route} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

/** Posts an approval-page form the way a browser would. */
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

describe("the trusted local runner", () => {
  let started: Started;

  beforeEach(async () => {
    started = await start();
  });

  afterEach(async () => {
    await started.runner.close();
    removeHome(started.home);
  });

  it("writes runner.json with a token, at mode 0600", () => {
    const state = readRunnerState(started.home);
    expect(state?.url).toBe(started.runner.url);
    expect(state?.token).toBe(started.runner.token);
    expect(state?.pid).toBe(process.pid);
    const mode = fs.statSync(path.join(started.home, "runner.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("answers /health without a token and says nothing secret", async () => {
    const response = await fetch(`${started.runner.url}/health`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, kill_switch: false });
    expect(JSON.stringify(body)).not.toContain(started.runner.token);
  });

  it("refuses the agent API without the right token", async () => {
    for (const headers of [
      {},
      { [RUNNER_TOKEN_HEADER]: "wrong" },
      { [RUNNER_TOKEN_HEADER]: started.runner.token.slice(0, -1) },
    ]) {
      const response = await fetch(`${started.runner.url}/v1/policy`, { headers });
      expect(response.status).toBe(401);
    }
    const ok = await fetch(`${started.runner.url}/v1/policy`, {
      headers: { [RUNNER_TOKEN_HEADER]: started.runner.token },
    });
    expect(ok.status).toBe(200);
  });

  it("has no verb that returns a secret value", async () => {
    for (const route of ["/v1/secret", "/v1/secrets", "/v1/vault", "/v1/keys", "/v1/screenshot"]) {
      const response = await fetch(`${started.runner.url}${route}`, {
        headers: { [RUNNER_TOKEN_HEADER]: started.runner.token },
      });
      expect(response.status, route).toBe(404);
    }
  });

  it("creates a request, notifies the human, and hands back only an id and a status", async () => {
    const created = await started.client.createRequest({
      vendor: "TikHub",
      domain: "api.tikhub.io",
      purpose: "search 200 TikTok posts",
      est_budget_usd: 3,
    });
    expect(created.request_id).toMatch(/^req_[0-9a-f]{16}$/);
    expect(created.status).toBe("pending_approval");
    expect(created.approval_url).toBe(`${started.runner.url}/approve/${created.request_id}`);
    // Nothing that could be mistaken for a credential crosses the boundary.
    expect(Object.keys(created)).not.toContain("page_token");
    expect(JSON.stringify(created)).not.toContain(SECRET);

    expect(started.notifier.sent).toHaveLength(1);
    expect(started.notifier.sent[0]?.title).toMatch(/approve access to TikHub/i);
    expect(started.notifier.sent[0]?.url).toContain("/approve/req_");
  });

  it("tells the human on the first paid action that no caps are set (D11)", async () => {
    const created = await started.client.createRequest({
      vendor: "TikHub",
      est_budget_usd: 3,
    });
    const page = await (await fetch(created.approval_url ?? "")).text();
    expect(page).toMatch(/No spend caps are set yet/);
    // No preset numbers anywhere in the form.
    expect(page).toMatch(/placeholder="you decide"/);
    await expect(started.client.getRequest(created.request_id)).resolves.toMatchObject({
      status: "pending_approval",
    });
  });

  it("approves on the page, writes the caps the human typed, and records who did it", async () => {
    const created = await started.client.createRequest({
      vendor: "TikHub",
      domain: "api.tikhub.io",
      est_budget_usd: 3,
    });
    const request = started.runner.requests.get(created.request_id);
    const result = await postForm(created.approval_url ?? "", {
      page_token: request?.page_token ?? "",
      action: "approve",
      global_cap: "25",
      vendor_cap: "5",
    });
    expect(result.status).toBe(200);

    const policy = readPolicy(started.home);
    expect(policy.global_monthly_cap_usd).toBe(25);
    expect(vendorCap(policy, "TikHub")).toBe(5);
    expect(policy.last_change_by).toBe(`approval-page (${created.request_id})`);

    // v0.3 has no playbooks, so the approved request lands on a human handoff.
    const status = await started.client.getRequest(created.request_id);
    expect(status.status).toBe("needs_human");
    expect(status.reason).toBe("no_playbook");
  });

  it("will not approve the first paid action with every cap still $0 (D11)", async () => {
    const created = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 3 });
    const request = started.runner.requests.get(created.request_id);
    const result = await postForm(created.approval_url ?? "", {
      page_token: request?.page_token ?? "",
      action: "approve",
      global_cap: "",
      vendor_cap: "",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatch(/Nothing was approved/);
    expect(result.body).toMatch(/no suggested numbers/);
    expect((await started.client.getRequest(created.request_id)).status).toBe("pending_approval");
    expect(readPolicy(started.home).global_monthly_cap_usd).toBe(0);
  });

  it("settles an aggregator-route approval without re-running signup (D14)", async () => {
    const created = await started.client.createRequest({
      vendor: "TikHub",
      est_budget_usd: 2,
      fallback_aggregator: "Monid",
      fallback_price_usd: 0.004,
    });
    const first = started.runner.requests.get(created.request_id);
    await postForm(created.approval_url ?? "", {
      page_token: first?.page_token ?? "",
      action: "approve",
      global_cap: "20",
      vendor_cap: "5",
    });
    const followUpId = started.runner.requests.get(created.request_id)?.follow_up_id ?? "";
    const followUp = started.runner.requests.get(followUpId);
    const decided = await postForm(`${started.runner.url}/approve/${followUpId}`, {
      page_token: followUp?.page_token ?? "",
      action: "approve",
    });
    expect(decided.status).toBe(200);
    const settled = started.runner.requests.get(followUpId);
    expect(settled?.status).toBe("approved");
    // No second handoff was raised off the back of the fallback decision.
    expect(settled?.follow_up_id).toBeNull();
  });

  it("refuses a form post with a stale token, and changes nothing", async () => {
    const created = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    const result = await postForm(created.approval_url ?? "", {
      page_token: "stale",
      action: "approve",
      global_cap: "100",
    });
    expect(result.status).toBe(403);
    expect(readPolicy(started.home).global_monthly_cap_usd).toBe(0);
    expect((await started.client.getRequest(created.request_id)).status).toBe("pending_approval");
  });

  it("denies on the page", async () => {
    const created = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    const request = started.runner.requests.get(created.request_id);
    await postForm(created.approval_url ?? "", {
      page_token: request?.page_token ?? "",
      action: "deny",
    });
    const status = await started.client.getRequest(created.request_id);
    expect(status.status).toBe("denied");
    expect(status.cancellable).toBe(false);
    // A denied request cannot be talked back into an approval.
    expect(() =>
      started.runner.requests.update(created.request_id, { status: "approved" }, "human"),
    ).toThrow(/already denied/);
  });

  it("reuses the pending approval instead of piling up notifications", async () => {
    const first = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    const second = await started.client.createRequest({
      vendor: "tikhub",
      est_budget_usd: 1,
      purpose: "polling again",
    });
    expect(second.request_id).toBe(first.request_id);
    expect(started.notifier.sent).toHaveLength(1);
    expect(started.runner.requests.list()).toHaveLength(1);

    // A different vendor is a different decision.
    const other = await started.client.createRequest({ vendor: "Apify", est_budget_usd: 1 });
    expect(other.request_id).not.toBe(first.request_id);
    expect(started.notifier.sent).toHaveLength(2);

    // And once the human (or the agent) settles one, a fresh ask is new again.
    await started.client.cancelRequest(first.request_id, "no longer needed");
    const third = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    expect(third.request_id).not.toBe(first.request_id);
  });

  it("lets the agent cancel its own request, and only cancel it", async () => {
    const created = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    const cancelled = await started.client.cancelRequest(created.request_id, "no longer needed");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.reason).toBe("no longer needed");
    // Cancelling twice is harmless, and never becomes an approval.
    const again = await started.client.cancelRequest(created.request_id, "again");
    expect(again.status).toBe("cancelled");
    expect(readPolicy(started.home).global_monthly_cap_usd).toBe(0);
  });

  it("serves the policy read-only: there is no POST to raise a cap", async () => {
    const response = await fetch(`${started.runner.url}/v1/policy`, {
      method: "POST",
      headers: { [RUNNER_TOKEN_HEADER]: started.runner.token },
      body: JSON.stringify({ global_monthly_cap_usd: 1000 }),
    });
    expect(response.status).toBe(404);
    expect(readPolicy(started.home).global_monthly_cap_usd).toBe(0);
  });

  it("voids every pending approval when the kill switch is engaged", async () => {
    const first = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    const second = await started.client.createRequest({ vendor: "Apify", est_budget_usd: 1 });
    const result = await started.client.kill("test");
    expect(result["voided_requests"]).toEqual([first.request_id, second.request_id]);
    expect(killSwitchState(started.home).engaged).toBe(true);

    // And nothing new is raised while it is engaged.
    const third = await started.client.createRequest({ vendor: "Apollo", est_budget_usd: 1 });
    expect(third.status).toBe("voided");
    expect(third.reason).toMatch(/kill switch/i);
    releaseKillSwitch(started.home);
  });

  it("serves the Secure Input Popup with the origin verified and the field masked", async () => {
    const pending = started.runner.resolveSecret({
      class: "card_cvv",
      vendor: "example-apify-scraping",
      origin: "https://api.apify.com/billing",
      field: "CVV",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const entry = started.runner.popups.list().at(-1);
    expect(entry?.status).toBe("pending");

    const page = await (await fetch(`${started.runner.url}/input/${entry?.id}`)).text();
    expect(page).toContain("api.apify.com/billing");
    expect(page).toMatch(/verified against the API index allowlist/);
    expect(page).toMatch(/type="password"/);
    expect(page).toMatch(/autocomplete="off"/);

    const result = await postForm(`${started.runner.url}/input/${entry?.id}`, {
      token: entry?.token ?? "",
      value: "321",
      action: "submit",
    });
    // The response confirms receipt without echoing the value.
    expect(result.body).toMatch(/went straight to the SkeletonKey runner/);
    expect(result.body).not.toContain("321");

    const resolved = await pending;
    expect(resolved.outcome.source).toBe("popup");
    expect((resolved.outcome as { value: string }).value).toBe("321");
    // And the log never carries it.
    expect(started.logs.join("\n")).not.toContain("321");
    expect(started.logs.join("\n")).toMatch(/value not logged/);
  });

  it("asks no rung at all, and opens no popup, for an origin off the allowlist", async () => {
    const result = await started.runner.resolveSecret({
      class: "card_number",
      vendor: "example-apify-scraping",
      origin: "https://api.apify.com.evil.example/billing",
      field: "card number",
    });
    expect(result.outcome).toMatchObject({ source: null, kind: "blocked" });
    expect(result.attempts).toEqual([]);
    // No Secure Input Popup is even offered for a lookalike domain.
    expect(started.runner.popups.list()).toHaveLength(0);
    expect(started.notifier.sent.at(-1)?.title).toMatch(/blocked a secret request/i);
    expect(started.logs.join("\n")).toMatch(/origin not allowlisted/);
  });

  it("serves the human pages only to a loopback Host header", async () => {
    const created = await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    // `fetch` will not let a caller set Host, so ask over a raw socket.
    const response = await rawGet(
      started.runner.port,
      `/approve/${created.request_id}`,
      "skeletonkey.example.com",
    );
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(response).toMatch(/localhost only/);
    const ok = await rawGet(started.runner.port, `/approve/${created.request_id}`, "127.0.0.1");
    expect(ok).toMatch(/^HTTP\/1\.1 200/);
  });

  it("raises a second approval for the aggregator fallback when direct signup fails (D14)", async () => {
    const created = await started.client.createRequest({
      vendor: "TikHub",
      domain: "api.tikhub.io",
      est_budget_usd: 2,
      fallback_aggregator: "Monid",
      fallback_price_usd: 0.004,
    });
    const request = started.runner.requests.get(created.request_id);
    await postForm(created.approval_url ?? "", {
      page_token: request?.page_token ?? "",
      action: "approve",
      global_cap: "20",
      vendor_cap: "5",
    });
    const settled = started.runner.requests.get(created.request_id);
    expect(settled?.status).toBe("needs_human");
    expect(settled?.follow_up_id).toMatch(/^req_/);

    const followUp = started.runner.requests.get(settled?.follow_up_id ?? "");
    expect(followUp?.kind).toBe("aggregator_route");
    expect(followUp?.status).toBe("pending_approval");
    expect(followUp?.reason).toMatch(/Monid/);
    expect(followUp?.reason).toMatch(/\$0\.004 per call/);
    expect(followUp?.reason).toMatch(/Nothing is routed without this approval/);
  });

  it("marks a request ready when a playbook completes", async () => {
    const other = await start({ signupRunner: new ReadySignupRunner() });
    try {
      const created = await other.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
      const request = other.runner.requests.get(created.request_id);
      await postForm(created.approval_url ?? "", {
        page_token: request?.page_token ?? "",
        action: "approve",
        global_cap: "10",
        vendor_cap: "2",
      });
      const status = await other.client.getRequest(created.request_id);
      expect(status.status).toBe("ready");
      expect(status.handle).toBe("key_fake_01");
    } finally {
      await other.runner.close();
      removeHome(other.home);
    }
  });

  it("lists pending approvals on the index page", async () => {
    await started.client.createRequest({ vendor: "TikHub", purpose: "search posts" });
    const page = await (await fetch(`${started.runner.url}/`)).text();
    expect(page).toMatch(/TikHub/);
    expect(page).toMatch(/search posts/);
  });

  it("persists requests to a 0600 file that holds no secret", async () => {
    await started.client.createRequest({ vendor: "TikHub", est_budget_usd: 1 });
    const file = path.join(started.home, "requests.json");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const body = fs.readFileSync(file, "utf8");
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(started.runner.token);
    expect(RequestStore.open(started.home).list()).toHaveLength(1);
  });
});

describe("the runner client", () => {
  it("reports a missing runner as unavailable rather than throwing a stack", async () => {
    const home = makeHome();
    try {
      expect(RunnerClient.fromHome(home)).toBeNull();
      // A state file pointing at nothing: the client says so in words.
      fs.writeFileSync(
        path.join(home, "runner.json"),
        JSON.stringify({ url: "http://127.0.0.1:1", token: "x".repeat(48) }),
      );
      const client = RunnerClient.fromHome(home);
      await expect(client?.health()).rejects.toThrow(/did not answer/);
    } finally {
      removeHome(home);
    }
  });
});

describe("the domain allowlist", () => {
  it("is built from the API index and the vault, and covers subdomains", async () => {
    const home = makeHome();
    try {
      await initWithKey(home, { secret: SECRET, domain: "api.voyageai.com" });
      const allowlist = buildAllowlist({ home, apisFile: APIS_YAML, shardDirs: [] });
      expect(allowlist.size).toBeGreaterThan(0);
      // From the vault.
      expect(allowlist.check("api.voyageai.com").allowed).toBe(true);
      expect(allowlist.check("v2.api.voyageai.com").allowed).toBe(true);
      // Not from anywhere.
      expect(allowlist.check("api.voyageai.com.evil.example").allowed).toBe(false);
      expect(allowlist.check("").allowed).toBe(false);
      expect(allowlist.check("not a host").allowed).toBe(false);
    } finally {
      removeHome(home);
    }
  });

  it("refuses to vouch for one vendor's domain under another vendor's name", async () => {
    const home = makeHome();
    try {
      await initWithKey(home, { secret: SECRET, domain: "api.voyageai.com" });
      const allowlist = buildAllowlist({ home, apisFile: APIS_YAML, shardDirs: [] });
      expect(allowlist.check("api.voyageai.com", { vendor: "TikHub" }).allowed).toBe(false);
    } finally {
      removeHome(home);
    }
  });
});

describe("notifications", () => {
  it("are best effort: a missing notifier is not an error", async () => {
    expect(await new NoopNotifier().notify({ title: "x", body: "y" })).toBe(false);
  });
});
