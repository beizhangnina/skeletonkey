/**
 * `monitor_status` (ND-5): the read-only MCP tool over state.json. It never
 * runs a new check (no transport, no vault, no network) and never returns a
 * secret.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAccount, type AccountMeta } from "../src/accounts/store.js";
import { writeConfig } from "../src/config.js";
import { upsertKey } from "../src/keys.js";
import { callSkeletonKeyTool, type McpContext } from "../src/mcp.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { runMonitor } from "../src/monitor/run.js";
import type { TransportResponse } from "../src/monitor/types.js";
import { makeHome, removeHome } from "./helpers/env.js";

const CANARY_KEY = "sk-test-FAKE-canary-mcpmonitor-0xFEED";

function apiEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: overrides["name"],
    url: "https://example.test/docs",
    access_mode: "own-account",
    min_topup: null,
    billing_unit: null,
    signup_automatable: null,
    tos_notes: null,
    source: null,
    checked_date: "2026-11-01",
    ...overrides,
  };
}

function writeApisFixture(home: string, entries: Record<string, unknown>[]): string {
  const file = path.join(home, "fixture-apis.yaml");
  fs.writeFileSync(file, YAML.stringify({ version: 1, entries }));
  return file;
}

describe("monitor_status MCP tool", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
    writeConfig(
      { email: "dev@example.test", backend: "file", created: "2026-11-01T00:00:00.000Z" },
      home,
    );
  });

  afterEach(() => {
    removeHome(home);
  });

  it("reports nothing before any run, and the last status after one", async () => {
    const ctx: McpContext = { home };

    const before = await callSkeletonKeyTool("monitor_status", {}, ctx);
    const beforeBody = JSON.parse(before.content.map((part) => part.text).join("")) as {
      count: number;
    };
    expect(beforeBody.count).toBe(0);

    const apisFile = writeApisFixture(home, [
      apiEntry({
        name: "apify",
        usage_api: {
          available: true,
          method: "GET",
          path: "https://api.apify.com/v2/users/me/usage/monthly",
          docs_url: "https://docs.apify.com/x",
          limits: null,
          notes: null,
          checked_date: "2026-11-24",
        },
      }),
    ]);
    const store = openEntryStore(home);
    await store.putApiKey("apify-main", CANARY_KEY);
    upsertKey(
      {
        alias: "apify-main",
        platform: "apify",
        domain: "example.test",
        header: "Authorization",
        format: "Bearer {key}",
        created: "2026-11-01T00:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );
    const account: AccountMeta = {
      name: "apify-main",
      vendor: "apify",
      registered: "2026-11-01",
      email_hint: "b**********@gmail.com",
      key_alias: "apify-main",
      login_entry: null,
      created: "2026-11-01T00:00:00.000Z",
      disabled: false,
      disabled_at: null,
    };
    upsertAccount(account, home);

    await runMonitor({
      home,
      apisFile,
      notify: false,
      transport: async (): Promise<TransportResponse> => ({
        status: 200,
        text: async () => JSON.stringify({ data: { monthlyUsageUsd: 4 } }),
      }),
      now: () => new Date("2026-11-01T00:00:00.000Z"),
    });

    const after = await callSkeletonKeyTool("monitor_status", {}, ctx);
    const afterText = after.content.map((part) => part.text).join("");
    expect(afterText).not.toContain(CANARY_KEY);
    const afterBody = JSON.parse(afterText) as {
      count: number;
      accounts: { name: string; last_status: string }[];
    };
    expect(afterBody.count).toBe(1);
    expect(afterBody.accounts[0]?.name).toBe("apify-main");
    expect(afterBody.accounts[0]?.last_status).toBe("ok");
  });
});
