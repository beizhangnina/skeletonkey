import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capsUnset,
  checkSpend,
  defaultPolicy,
  policyPath,
  policyView,
  readPolicy,
  setCaps,
  vendorCap,
  writePolicy,
} from "../src/policy.js";
import { makeHome, removeHome } from "./helpers/env.js";

describe("spend policy", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("defaults to $0 everywhere, with no preset numbers (D11)", () => {
    const policy = readPolicy(home);
    expect(policy.global_monthly_cap_usd).toBe(0);
    expect(policy.vendor_caps_usd).toEqual({});
    expect(capsUnset(policy)).toBe(true);
    // Nothing is written until a human decides something.
    expect(fs.existsSync(policyPath(home))).toBe(false);
  });

  it("round-trips through policy.yaml at mode 0600", () => {
    setCaps({ global_monthly_cap_usd: 25, vendor: "TikHub", vendor_cap_usd: 5 }, { by: "cli" }, home);
    const policy = readPolicy(home);
    expect(policy.global_monthly_cap_usd).toBe(25);
    expect(vendorCap(policy, "tikhub")).toBe(5);
    expect(vendorCap(policy, "TIKHUB")).toBe(5);
    expect(capsUnset(policy)).toBe(false);
    expect(policy.last_change_by).toBe("cli");
    const mode = fs.statSync(policyPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("records which approval raised a cap", () => {
    setCaps(
      { vendor: "Apify", vendor_cap_usd: 10 },
      { by: "approval-page", request_id: "req_abc123" },
      home,
    );
    expect(readPolicy(home).last_change_by).toBe("approval-page (req_abc123)");
  });

  it("refuses a cap change with no human authority behind it", () => {
    // The only way to call this is with `approval-page` or `cli`; anything an
    // agent could reach has to go through one of those two humans-in-the-loop.
    expect(() =>
      writePolicy(defaultPolicy(), { by: "agent" } as unknown as { by: "cli" }, home),
    ).toThrow(/human authority/i);
  });

  it("refuses negative caps", () => {
    expect(() => setCaps({ global_monthly_cap_usd: -1 }, { by: "cli" }, home)).toThrow(/non-negative/);
    expect(() =>
      setCaps({ vendor: "x", vendor_cap_usd: -5 }, { by: "cli" }, home),
    ).toThrow(/non-negative/);
  });

  it("ignores junk in the file rather than trusting it", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "policy.yaml"),
      "global_monthly_cap_usd: not-a-number\nvendor_caps_usd:\n  tikhub: lots\n",
    );
    const policy = readPolicy(home);
    expect(policy.global_monthly_cap_usd).toBe(0);
    expect(policy.vendor_caps_usd).toEqual({});
  });

  describe("checkSpend", () => {
    it("asks the human to set caps on the first paid action", () => {
      const check = checkSpend({ policy: readPolicy(home), vendor: "TikHub", amount_usd: 3 });
      expect(check.allowed).toBe(false);
      expect(check.needs_approval).toBe(true);
      expect(check.asks_human_to_set_caps).toBe(true);
      expect(check.reason).toMatch(/\$0/);
    });

    it("never auto-approves an unknown cost", () => {
      setCaps({ global_monthly_cap_usd: 50, vendor: "TikHub", vendor_cap_usd: 10 }, { by: "cli" }, home);
      const check = checkSpend({ policy: readPolicy(home), vendor: "TikHub", amount_usd: null });
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/unknown is not zero/);
    });

    it("allows a spend inside both caps", () => {
      setCaps({ global_monthly_cap_usd: 50, vendor: "TikHub", vendor_cap_usd: 10 }, { by: "cli" }, home);
      const check = checkSpend({
        policy: readPolicy(home),
        vendor: "tikhub",
        amount_usd: 2,
        month_to_date_usd: 3,
        vendor_to_date_usd: 1,
      });
      expect(check.allowed).toBe(true);
      expect(check.needs_approval).toBe(false);
    });

    it("refuses a vendor with a cap of $0 even when the global cap is generous", () => {
      setCaps({ global_monthly_cap_usd: 100 }, { by: "cli" }, home);
      const check = checkSpend({ policy: readPolicy(home), vendor: "Apollo", amount_usd: 1 });
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/No cap is set for Apollo/);
    });

    it("refuses what would cross the vendor cap, and then the global cap", () => {
      setCaps({ global_monthly_cap_usd: 12, vendor: "TikHub", vendor_cap_usd: 10 }, { by: "cli" }, home);
      const policy = readPolicy(home);
      const overVendor = checkSpend({
        policy,
        vendor: "TikHub",
        amount_usd: 4,
        vendor_to_date_usd: 8,
      });
      expect(overVendor.allowed).toBe(false);
      expect(overVendor.reason).toMatch(/\$10 cap/);

      const overGlobal = checkSpend({
        policy,
        vendor: "TikHub",
        amount_usd: 4,
        month_to_date_usd: 11,
      });
      expect(overGlobal.allowed).toBe(false);
      expect(overGlobal.reason).toMatch(/global monthly cap/);
    });
  });

  it("tells an agent, in the view, that it may not raise a cap or enable a key", () => {
    const view = policyView(readPolicy(home)) as {
      agent_permissions: Record<string, unknown>;
    };
    expect(view.agent_permissions).toMatchObject({
      may_disable_keys: true,
      may_cancel_requests: true,
      may_enable_keys: false,
      may_raise_caps: false,
    });
  });
});
