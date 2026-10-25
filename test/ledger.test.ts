import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, openLedger } from "../src/ledger.js";
import { makeHome, removeHome } from "./helpers/env.js";

describe("ledger", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("records rows and returns them newest-first", () => {
    const ledger = openLedger(home);
    try {
      ledger.record({ alias: "a", domain: "api.example.com", status: 200, bytes: 10 });
      ledger.record({ alias: "b", domain: "api.other.test", status: 429, bytes: 0, cost: 0.01 });
      const rows = ledger.recent(10);
      expect(rows.map((row) => row.alias)).toEqual(["b", "a"]);
      expect(rows[0]?.cost).toBeCloseTo(0.01);
      expect(rows[1]?.cost).toBeNull();
      expect(rows[1]?.status).toBe(200);
    } finally {
      ledger.close();
    }
  });

  it("defaults cost to null and never stores a negative byte count", () => {
    const ledger = new Ledger(path.join(home, "ledger.db"));
    try {
      ledger.record({ alias: null, domain: "api.example.com", status: null, bytes: -5 });
      const row = ledger.recent(1)[0];
      expect(row?.cost).toBeNull();
      expect(row?.alias).toBeNull();
      expect(row?.bytes).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("reports the newest call per alias for idle detection", () => {
    const ledger = openLedger(home);
    try {
      ledger.record({
        alias: "a",
        domain: "d",
        status: 200,
        bytes: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      ledger.record({
        alias: "a",
        domain: "d",
        status: 200,
        bytes: 1,
        timestamp: "2026-06-01T00:00:00.000Z",
      });
      ledger.record({ alias: null, domain: "d", status: 200, bytes: 1 });
      const map = ledger.lastUsedByAlias();
      expect(map.get("a")).toBe("2026-06-01T00:00:00.000Z");
      expect(map.size).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("persists across reopens", () => {
    const first = openLedger(home);
    first.record({ alias: "a", domain: "d", status: 200, bytes: 3 });
    first.close();

    const second = openLedger(home);
    try {
      expect(second.all()).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("reports only the domains that actually answered 2xx", () => {
    const ledger = openLedger(home);
    try {
      ledger.record({ alias: null, domain: "ok.test", status: 200, bytes: 1, timestamp: "2026-10-24T01:00:00.000Z" });
      ledger.record({ alias: null, domain: "ok.test", status: 204, bytes: 0, timestamp: "2026-10-24T02:00:00.000Z" });
      ledger.record({ alias: null, domain: "denied.test", status: 401, bytes: 1 });
      ledger.record({ alias: null, domain: "broken.test", status: 500, bytes: 1 });
      ledger.record({ alias: null, domain: "moved.test", status: 302, bytes: 1 });
      ledger.record({ alias: null, domain: "nostatus.test", status: null, bytes: 1 });

      const succeeded = ledger.succeededDomains();
      expect([...succeeded.keys()]).toEqual(["ok.test"]);
      // The most recent success, so promotion can name the call that earned it.
      expect(succeeded.get("ok.test")?.timestamp).toBe("2026-10-24T02:00:00.000Z");
      expect(succeeded.get("ok.test")?.calls).toBe(2);
    } finally {
      ledger.close();
    }
  });

  it("lowercases the domain it reports, so host comparison is predictable", () => {
    const ledger = openLedger(home);
    try {
      ledger.record({ alias: null, domain: "API.Example.COM", status: 201, bytes: 1 });
      expect([...ledger.succeededDomains().keys()]).toEqual(["api.example.com"]);
    } finally {
      ledger.close();
    }
  });
});
