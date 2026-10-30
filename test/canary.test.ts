/**
 * The HARD RULE, as a test.
 *
 * API keys, account passwords, card numbers, and CVVs never appear in an MCP
 * response, a log line, the ledger, a file under SKELETONKEY_HOME, a page the
 * runner serves, or any CLI output. Every value below is a canary: it is pushed
 * through the real code paths -- the vault, the `bw` rung of the ladder, the
 * Secure Input Popup -- and then every surface an agent (or a human reading a
 * log) can see is swept for it.
 *
 * The second half asserts the other half of D5: an agent can disable a key and
 * cancel a request, and there is no tool, no runner verb, and no argument that
 * lets it enable a key or raise a cap.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callSkeletonKeyTool, SKELETONKEY_TOOLS, type McpContext } from "../src/mcp.js";
import { readKeys } from "../src/keys.js";
import { openLedger } from "../src/ledger.js";
import { readPolicy } from "../src/policy.js";
import { RunnerClient } from "../src/runner/client.js";
import { startRunner, RUNNER_TOKEN_HEADER, type RunnerHandle } from "../src/runner/server.js";
import { BitwardenSecretSource, type BwRunner } from "../src/secrets/bitwarden.js";
import { BoundInboxSource } from "../src/secrets/inbox.js";
import { NoopNotifier } from "../src/notify.js";
import { initWithKey, makeHome, removeHome, REPO_ROOT, runCli } from "./helpers/env.js";

/** Every one of these must be unfindable everywhere an agent can look. */
const CANARIES = {
  api_key: "sk-test-FAKE-canary-APIKEY-0xC0FFEE11",
  password: "FAKE-canary-PASSWORD-0xC0FFEE22",
  card_number: "4242424242424242",
  card_cvv: "321",
  bw_session: "FAKE-canary-BWSESSION-0xC0FFEE33",
  popup_value: "FAKE-canary-TYPED-0xC0FFEE44",
};

/** Fragments that would betray a leak even if something truncated the value. */
const FRAGMENTS = ["0xC0FFEE11", "0xC0FFEE22", "0xC0FFEE33", "0xC0FFEE44", "sk-test-FAKE-canary"];

const APIS_YAML = path.join(REPO_ROOT, "apis.yaml");
const ALIAS = "voyage-personal";
const DOMAIN = "api.voyageai.com";

/** A `bw` holding the card and a vendor login, so rung 1 really answers. */
const fakeBw: BwRunner = async (args) => {
  if (args[0] === "status") {
    return { code: 0, stdout: JSON.stringify({ status: "unlocked" }), stderr: "" };
  }
  if (args[0] === "list" && args[1] === "items") {
    const search = args[3] ?? "";
    const items = [
      {
        name: "skeletonkey: card",
        card: { number: CANARIES.card_number, code: CANARIES.card_cvv, expMonth: "4", expYear: "2031" },
      },
      {
        name: "skeletonkey: tikhub",
        login: { username: "tikhub", password: CANARIES.password },
      },
    ].filter((item) => item.name.includes(search));
    return { code: 0, stdout: JSON.stringify(items), stderr: "" };
  }
  return { code: 1, stdout: "", stderr: `bw session ${CANARIES.bw_session} failed` };
};

interface Harness {
  home: string;
  runner: RunnerHandle;
  ctx: McpContext;
  logs: string[];
  /** Every string an agent (or a human) could read, after the sweep runs. */
  surfaces: { name: string; text: string }[];
}

async function setUp(): Promise<Harness> {
  const home = makeHome();
  await initWithKey(home, { alias: ALIAS, secret: CANARIES.api_key, domain: DOMAIN });
  const logs: string[] = [];
  const runner = await startRunner({
    home,
    port: 0,
    notifier: new NoopNotifier(),
    apisFile: APIS_YAML,
    apiShardDirs: [],
    popupTimeoutMs: 0,
    logger: (line) => logs.push(line),
    // The first two rungs are fakes; the third is the runner's own Secure
    // Input Popup, serving its real page.
    secretSources: (popup) => [new BitwardenSecretSource(fakeBw), new BoundInboxSource(), popup],
  });
  const ctx: McpContext = {
    home,
    apisFile: APIS_YAML,
    apiShardDirs: [],
    allowTtyPrompt: false,
    runner: new RunnerClient(runner.url, runner.token),
  };
  return { home, runner, ctx, logs, surfaces: [] };
}

describe("HARD RULE: no secret reaches the agent, the logs, or the ledger", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setUp();
  });
  afterEach(async () => {
    await h.runner.close();
    removeHome(h.home);
  });

  it("sweeps every MCP tool, every runner surface, and every file for every canary", async () => {
    // --- sanity: the canaries really are in play ------------------------
    expect(fs.readFileSync(path.join(h.home, "dev-vault.json"), "utf8")).toContain(
      CANARIES.api_key,
    );

    // --- push the secrets through the real paths ------------------------
    const card = await h.runner.resolveSecret({
      class: "card_number",
      vendor: "ExampleCo",
      origin: `https://${DOMAIN}/billing`,
      field: "card number",
    });
    expect(card.outcome.source).toBe("bitwarden");
    expect((card.outcome as { value: string }).value).toBe(CANARIES.card_number);

    const cvv = await h.runner.resolveSecret({
      class: "card_cvv",
      vendor: "ExampleCo",
      origin: `https://${DOMAIN}/billing`,
      field: "CVV",
    });
    expect((cvv.outcome as { value: string }).value).toBe(CANARIES.card_cvv);

    const password = await h.runner.resolveSecret({
      class: "password",
      vendor: "ExampleCo",
      origin: `https://${DOMAIN}/signup`,
      field: "password",
      alias: "tikhub",
    });
    expect((password.outcome as { value: string }).value).toBe(CANARIES.password);

    // A value typed into the Secure Input Popup, submitted through the page.
    const typed = h.runner.resolveSecret({
      class: "otp",
      vendor: "ExampleCo",
      origin: `https://${DOMAIN}/verify`,
      field: "email code",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const popup = h.runner.popups.list().at(-1);
    h.runner.popups.submit(popup?.id ?? "", popup?.token ?? "", CANARIES.popup_value);
    expect((await typed).outcome.source).toBe("popup");

    // One proxied-call ledger row, so the ledger has content to sweep.
    const ledger = openLedger(h.home);
    ledger.record({ alias: ALIAS, domain: DOMAIN, status: 200, bytes: 128, cost: 0.0012 });
    ledger.close();

    // --- call every MCP tool, including the v0.3 ones -------------------
    const created = await callSkeletonKeyTool(
      "request_access",
      { platform: "Voyage AI", reason: "embed a corpus", est_budget: 4 },
      h.ctx,
    );
    const requestId =
      (
        JSON.parse(created.content.map((part) => part.text).join("")) as {
          access_request?: { request_id?: string };
        }
      ).access_request?.request_id ?? "req_missing";
    expect(requestId).toMatch(/^req_/);

    const toolArgs: Record<string, Record<string, unknown>> = {
      find_api: { capability: "embeddings" },
      list_keys: {},
      key_status: { alias: ALIAS },
      request_access: { platform: "Voyage AI", reason: "embed", est_budget: 4 },
      access_status: { request_id: requestId },
      cancel_request: { request_id: requestId, reason: "done" },
      spend_policy: {},
      discover_api: { capability: "CVE lookup", vendor: "NVD" },
      propose_entry: {
        name: "probe-vendor",
        url: "https://probe.test/docs",
        domain: "api.probe.test",
        access_mode: "own-account",
        source_urls: ["https://probe.test/docs"],
      },
      register_key: { alias: "new-key", platform: "Apify", domain: "api.apify.com" },
      ledger: { alias: ALIAS, limit: 50 },
      disable: { alias: ALIAS, reason: "sweep" },
    };
    expect(Object.keys(toolArgs).sort()).toEqual(
      SKELETONKEY_TOOLS.map((tool) => tool.name).sort(),
    );

    const surfaces: { name: string; text: string }[] = [
      { name: "request_access (fresh)", text: JSON.stringify(created) },
    ];
    for (const tool of SKELETONKEY_TOOLS) {
      const result = await callSkeletonKeyTool(tool.name, toolArgs[tool.name] ?? {}, h.ctx);
      surfaces.push({ name: `tool:${tool.name}`, text: JSON.stringify(result) });
      // And with hostile arguments, which must not change the answer.
      for (const args of [
        {},
        { alias: "../../etc/passwd", platform: "*", capability: "*", request_id: "*" },
        { alias: ALIAS, reason: CANARIES.api_key, purpose: CANARIES.card_number },
      ]) {
        const junk = await callSkeletonKeyTool(tool.name, args, h.ctx);
        surfaces.push({ name: `tool:${tool.name} (junk)`, text: JSON.stringify(junk) });
      }
    }

    // --- the runner's own surfaces --------------------------------------
    const second = await h.ctx.runner!.createRequest({
      vendor: "Voyage AI",
      domain: DOMAIN,
      purpose: "sweep",
      est_budget_usd: 1,
    });
    for (const route of ["/health", "/", `/approve/${second.request_id}`]) {
      const response = await fetch(`${h.runner.url}${route}`);
      surfaces.push({ name: `page:${route}`, text: await response.text() });
    }
    const popupEntry = h.runner.popups.list().at(-1);
    const popupPage = await fetch(`${h.runner.url}/input/${popupEntry?.id}`);
    surfaces.push({ name: "page:/input/<id>", text: await popupPage.text() });
    for (const route of ["/v1/policy", "/v1/allowlist", `/v1/requests/${second.request_id}`]) {
      const response = await fetch(`${h.runner.url}${route}`, {
        headers: { [RUNNER_TOKEN_HEADER]: h.runner.token },
      });
      surfaces.push({ name: `api:${route}`, text: await response.text() });
    }

    // --- logs, the ledger, and every file under the home ----------------
    surfaces.push({ name: "runner logs", text: h.logs.join("\n") });
    for (const file of filesUnder(h.home)) {
      if (file.endsWith("dev-vault.json")) continue; // the test-only plaintext vault IS the secret store
      surfaces.push({
        name: `file:${path.relative(h.home, file)}`,
        // Read as latin1 so a secret inside the SQLite binary would still show.
        text: fs.readFileSync(file).toString("latin1"),
      });
    }

    // --- CLI output a human (or an agent reading a terminal) sees -------
    for (const argv of [
      ["list"],
      ["list", "--json"],
      ["ledger"],
      ["requests"],
      ["policy", "show"],
      ["key-status-does-not-exist"],
    ]) {
      const result = await runCli(h.home, argv);
      surfaces.push({ name: `cli:${argv.join(" ")}`, text: `${result.stdout}\n${result.stderr}` });
    }

    // --- the sweep ------------------------------------------------------
    expect(surfaces.length).toBeGreaterThan(40);
    for (const surface of surfaces) {
      for (const [name, value] of Object.entries(CANARIES)) {
        // The CVV is three digits, so a bare substring match would hit byte
        // counts and timestamps. Check it where it would actually appear.
        if (name === "card_cvv") {
          expect(surface.text, `${surface.name} leaked a labelled CVV`).not.toMatch(
            /(cvv|cvc|csc)["'\s:=]+321/i,
          );
          continue;
        }
        expect(surface.text, `${surface.name} leaked ${name}`).not.toContain(value);
      }
      for (const fragment of FRAGMENTS) {
        expect(surface.text, `${surface.name} leaked a fragment`).not.toContain(fragment);
      }
    }
  });

  it("gives an agent no way to enable a key or raise a cap (D5)", async () => {
    // Start from a disabled key and zero caps.
    await callSkeletonKeyTool("disable", { alias: ALIAS, reason: "start disabled" }, h.ctx);
    const keysBefore = JSON.stringify(readKeys(h.home));
    const capsBefore = caps(h.home);

    const request = await h.ctx.runner!.createRequest({ vendor: "Voyage AI", est_budget_usd: 2 });

    // Everything an agent could plausibly try, through every tool.
    const hostile: Record<string, unknown>[] = [
      { alias: ALIAS, disabled: false, enable: true },
      { alias: ALIAS, global_monthly_cap_usd: 1000, vendor_cap_usd: 1000 },
      { platform: "Voyage AI", est_budget: 100000, approve: true },
      { request_id: request.request_id, status: "approved", action: "approve" },
      { capability: "embeddings", cap: 999 },
      { name: "x", url: "https://x.test", domain: "x.test", access_mode: "own-account", source_urls: ["https://x.test"], global_monthly_cap_usd: 999 },
    ];
    for (const tool of SKELETONKEY_TOOLS) {
      for (const args of hostile) {
        await callSkeletonKeyTool(tool.name, args, h.ctx);
      }
    }

    expect(JSON.stringify(readKeys(h.home))).toBe(keysBefore);
    expect(caps(h.home)).toEqual(capsBefore);
    expect(readKeys(h.home).keys.find((key) => key.alias === ALIAS)?.disabled).toBe(true);

    // Cancelling is allowed, approving is not: whatever the agent tried, the
    // request never became an approval.
    const after = await h.ctx.runner!.getRequest(request.request_id);
    expect(["pending_approval", "cancelled"]).toContain(after.status);
    expect(after.status).not.toBe("approved");
    expect(after.status).not.toBe("ready");

    // And the runner refuses every write shape an agent might guess at.
    for (const route of ["/v1/policy", "/v1/caps", "/v1/approve", "/v1/enable"]) {
      const response = await fetch(`${h.runner.url}${route}`, {
        method: "POST",
        headers: { [RUNNER_TOKEN_HEADER]: h.runner.token, "content-type": "application/json" },
        body: JSON.stringify({ global_monthly_cap_usd: 999, status: "approved" }),
      });
      expect(response.status, route).toBe(404);
    }
    expect(caps(h.home)).toEqual(capsBefore);
  });
});

/** The parts of the policy a cap change would move. */
function caps(home: string): Record<string, unknown> {
  const policy = readPolicy(home);
  return {
    global: policy.global_monthly_cap_usd,
    vendors: policy.vendor_caps_usd,
    last_change_by: policy.last_change_by,
  };
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}
