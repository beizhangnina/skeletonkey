import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AutoSignupExecutor, type SignupDriver, type SignupStep } from "../src/signup/executor.js";
import { BitwardenVault } from "../src/vault/bitwarden.js";
import { PopupRegistry, PopupSecretSource } from "../src/secrets/popup.js";
import { installFakeBw } from "./helpers/fake-bw.js";
import { makeHome, removeHome } from "./helpers/env.js";
import { spawn } from "node:child_process";
import type { SignupContext } from "../src/signup/types.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(vendor: string, steps: SignupStep[]) {
  const home = makeHome();
  cleanups.push(() => removeHome(home));
  const fake = installFakeBw(home, { userEmail: "dev@example.test" });
  const writes: { alias: string; value: string }[] = [];
  const bw = async (args: string[], stdin?: string) => {
    // Absolute fake binary and explicit environment; real bw is unreachable.
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(`${fake.dir}/bw`, args, { env: {
        ...fake.env, HOME: home, BITWARDENCLI_APPDATA_DIR: home,
      }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(stdin);
    });
    if (args[0] === "create" && stdin) {
      const item = JSON.parse(Buffer.from(stdin, "base64").toString());
      writes.push({ alias: item.name, value: item.login.password });
    }
    return result;
  };
  const vault = new BitwardenVault(undefined, "dev@example.test", bw);
  const calls: { action: string; body: any; writes: number }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ action: req.url!, body: body ? JSON.parse(body) : null, writes: writes.length });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(steps.shift()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const send = async (action: string, body?: unknown): Promise<SignupStep> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/${action}`, {
      method: "POST", body: JSON.stringify(body), redirect: "error",
    });
    return await response.json() as SignupStep;
  };
  const driver: SignupDriver = {
    open: () => send("open"), oauth: provider => send("oauth", { provider }),
    password: (email, password) => send("password", { email, password }),
    otp: value => send("otp", { value }),
  };
  const registry = new PopupRegistry();
  const popup = new PopupSecretSource({ registry, urlFor: id => `http://localhost/input/${id}`,
    checkOrigin: () => ({ allowed: true, host: "vendor.test", reason: "test" }),
    notifier: { id: "fake-popup-human", notify: async () => {
      const entry = registry.list().at(-1)!;
      registry.submit(entry.id, entry.token, "fake-email-otp");
      return true;
    } },
  });
  const logs: string[] = [];
  const context: SignupContext = { vendor, domain: null, signupUrl: null, email: "dev@example.test",
    resolveSecret: async () => { throw new Error("Signup must bypass inbox ladder"); },
    resolvePopup: request => popup.resolve(request), log: line => logs.push(line),
  };
  return { executor: new AutoSignupExecutor({ vault, driverFor: () => driver }), context,
    writes, calls, logs, fake, registry };
}

describe("signup executor (fake vendors and fake bw only)", () => {
  it.each(["Apify", "TikHub", "Apollo", "DropLeads"])("%s saves password before POST and collects OTP via popup", async vendor => {
    const f = await fixture(vendor, [
      { kind: "methods", google: false, oauth: false, password: true },
      { kind: "email_otp" }, { kind: "complete", apiKey: "fake-vendor-key" },
    ]);
    const outcome = await f.executor.run(f.context);
    expect(outcome.reason).toBe("key_binding_required");
    expect(f.calls.map(c => c.action)).toEqual(["/open", "/password", "/otp"]);
    expect(f.calls[1].writes).toBe(1);
    expect(f.writes[0].value).toBe(f.calls[1].body.password);
    expect(f.writes[0].value.length).toBeGreaterThan(40);
    expect(f.writes[1].value).toBe("fake-vendor-key");
    expect(f.registry.list()[0].status).toBe("filled");
    const publicOutput = JSON.stringify([outcome, f.logs, f.fake.calls()]);
    for (const secret of [f.writes[0].value, "fake-vendor-key", "fake-email-otp"]) {
      expect(publicOutput.includes(secret)).toBe(false);
    }
  });
  it.each([true, false])("prefers Google then generic OAuth (google=%s)", async google => {
    const f = await fixture("Apify", [{ kind: "methods", google, oauth: true, password: true }, { kind: "captcha" }]);
    const outcome = await f.executor.run(f.context);
    expect(f.calls[1].body.provider).toBe(google ? "google" : "oauth");
    expect(f.writes).toEqual([]);
    expect(outcome.reason).toBe("captcha");
    expect(outcome.vendorUrl).toBe("https://console.apify.com/sign-up");
  });
  it.each(["captcha", "phone", "payment", "oauth_consent"] as const)("records %s and stops for human", async kind => {
    const f = await fixture("Apollo", [{ kind }]);
    const result = await f.executor.run(f.context);
    expect(result.status).toBe("needs_human");
    expect(result.reason).toBe(kind);
    expect(result.log).toContain(`Signup stopped: ${kind}.`);
    expect(result.vendorUrl).toBe("https://app.apollo.io/#/signup");
    expect(f.calls).toHaveLength(1);
    expect(f.writes).toEqual([]);
  });
  it("does not submit a password when Bitwarden is locked", async () => {
    const f = await fixture("TikHub", [{ kind: "methods", google: false, oauth: false, password: true }]);
    f.fake.setStatus("locked", "dev@example.test");
    expect((await f.executor.run(f.context)).reason).toBe("signup_failed");
    expect(f.calls).toHaveLength(1);
  });
  it("does not use the ladder when the popup is unavailable", async () => {
    const f = await fixture("DropLeads", [{ kind: "email_otp" }]);
    delete f.context.resolvePopup;
    expect((await f.executor.run(f.context)).reason).toBe("otp_unavailable");
    expect(f.calls).toHaveLength(1);
  });
  it("suppresses arbitrary driver exception contents", async () => {
    const f = await fixture("Apify", []);
    const executor = new AutoSignupExecutor({ driverFor: () => { throw new Error("password=secret card=4111111111111111"); } });
    const result = await executor.run(f.context);
    expect(JSON.stringify(result)).not.toContain("4111111111111111");
    expect(result.reason).toBe("signup_failed");
  });
  it("hands off without a live driver", async () => {
    const f = await fixture("Apify", []);
    expect((await new AutoSignupExecutor().run(f.context)).reason).toBe("live_driver_unavailable");
    expect(f.calls).toEqual([]);
  });
});
