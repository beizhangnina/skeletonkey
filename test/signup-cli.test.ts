/**
 * ND-2: `skeletonkey signup list|start|status|complete|abandon`.
 *
 * `start` never claims success -- there is no bundled driver for any
 * first-wave vendor, so it always stops at `needs_human` when run through the
 * real CLI (no driver can be injected from argv or stdin). `complete` is the
 * only command that ever binds a key, and it prints a `vault://` ref only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const API_KEY = "sk-canary-ND2-CLIKEY-0001";

describe("skeletonkey signup list", () => {
  let home: string;
  beforeEach(async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  });
  afterEach(() => removeHome(home));

  it("lists the six first-wave vendors as a table", async () => {
    const result = await runCli(home, ["signup", "list"]);
    expect(result.code, result.stderr).toBe(0);
    for (const vendor of ["apify", "serpapi", "firecrawl", "exa", "github", "apollo"]) {
      expect(result.stdout).toContain(vendor);
    }
  });

  it("lists them as JSON with signup_url, key_page_url, docs, and automation", async () => {
    const result = await runCli(home, ["signup", "list", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(rows).toHaveLength(6);
    const apify = rows.find((row) => row["vendor"] === "apify");
    expect(apify).toMatchObject({
      vendor: "apify",
      signup_url: "https://console.apify.com/sign-up",
      key_page_url: "https://console.apify.com/settings/integrations",
      docs: "https://docs.apify.com/platform/integrations/api",
      automation: "human-handoff",
    });
    expect(Array.isArray(apify?.["human_steps"])).toBe(true);
    const serpapi = rows.find((row) => row["vendor"] === "serpapi");
    expect(serpapi?.["key_page_url"]).toBeNull();
    const apollo = rows.find((row) => row["vendor"] === "apollo");
    expect(apollo?.["signup_url"]).toBeNull();
  });
});

describe("skeletonkey signup start", () => {
  let home: string;
  beforeEach(async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  });
  afterEach(() => removeHome(home));

  it("rejects an unknown vendor with entry_not_found (66) and a hint listing the six", async () => {
    const result = await runCli(home, ["signup", "start", "nope-vendor"]);
    expect(result.code).toBe(66);
    expect(result.stderr).toContain("error entry_not_found");
    expect(result.stderr).toContain("apify");
    expect(result.stderr).toContain("serpapi");
  });

  it("stops at needs_human with no driver, and never claims success", async () => {
    const result = await runCli(home, ["signup", "start", "apify", "--no-open"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("status: needs_human");
    expect(result.stdout.toLowerCase()).not.toContain("success");
    expect(result.stdout).not.toContain("Registered account");
    expect(result.stdout).toContain("https://console.apify.com/sign-up");
    expect(result.stdout).toContain("skeletonkey signup complete apify --account apify-main");
  });

  it("--json reports status needs_human and reason no_driver", async () => {
    const result = await runCli(home, ["signup", "start", "serpapi", "--no-open", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed["status"]).toBe("needs_human");
    expect(parsed["reason"]).toBe("no_driver");
    expect(parsed["vendor"]).toBe("serpapi");
    expect(parsed["account"]).toBe("serpapi-main");
    expect(parsed["next_command"]).toBe("skeletonkey signup complete serpapi --account serpapi-main");
  });

  it("honors --account for a non-default account name", async () => {
    const result = await runCli(home, [
      "signup",
      "start",
      "exa",
      "--account",
      "exa-work",
      "--no-open",
      "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed["account"]).toBe("exa-work");
  });

  it("creates a session visible in `signup status`", async () => {
    await runCli(home, ["signup", "start", "github", "--no-open"]);
    const status = await runCli(home, ["signup", "status", "github", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    const rows = JSON.parse(status.stdout) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendor: "github", account: "github-main", state: "needs_human", reason: "no_driver" });
  });
});

describe("skeletonkey signup status", () => {
  let home: string;
  beforeEach(async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  });
  afterEach(() => removeHome(home));

  it("reports no sessions before any start", async () => {
    const result = await runCli(home, ["signup", "status"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("No signup sessions");
  });

  it("lists every session with no vendor filter", async () => {
    await runCli(home, ["signup", "start", "apify", "--no-open"]);
    await runCli(home, ["signup", "start", "exa", "--no-open"]);
    const result = await runCli(home, ["signup", "status", "--json"]);
    const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(rows.map((r) => r["vendor"]).sort()).toEqual(["apify", "exa"]);
  });

  it("rejects an unknown vendor filter", async () => {
    const result = await runCli(home, ["signup", "status", "not-a-vendor"]);
    expect(result.code).toBe(66);
  });
});

describe("skeletonkey signup complete", () => {
  let home: string;
  beforeEach(async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  });
  afterEach(() => removeHome(home));

  it("binds the key via stdin, prints only a vault:// ref, never the key", async () => {
    await runCli(home, ["signup", "start", "apify", "--no-open"]);
    const result = await runCli(home, ["signup", "complete", "apify", "--stdin"], API_KEY);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("vault://apify-main");
    expect(result.stdout).toContain("skeletonkey run --env APIFY_TOKEN=vault://apify-main");
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);

    const status = await runCli(home, ["signup", "status", "apify", "--json"]);
    const rows = JSON.parse(status.stdout) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ state: "bound" });

    const run = await runCli(home, [
      "run",
      "--env",
      "X=vault://apify-main",
      "--",
      "node",
      "-e",
      "console.log(process.env.X)",
    ]);
    expect(run.stdout).toContain("[redacted]");
  });

  it("creates its own session when `start` was never run", async () => {
    const result = await runCli(home, ["signup", "complete", "exa", "--stdin"], API_KEY);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("vault://exa-main");
  });

  it("empty key is a usage error (64)", async () => {
    const result = await runCli(home, ["signup", "complete", "apify", "--stdin"], "");
    expect(result.code).toBe(64);
    expect(result.stderr).toContain("error usage");
  });

  it("a taken account name is refused (75) unless --yes", async () => {
    await runCli(home, ["signup", "complete", "apify", "--stdin"], API_KEY);
    const again = await runCli(home, ["signup", "complete", "apify", "--stdin"], "sk-canary-ND2-CLIKEY-0002");
    expect(again.code).toBe(75);
    expect(again.stderr).toContain("error name_taken");

    const withYes = await runCli(
      home,
      ["signup", "complete", "apify", "--stdin", "--yes"],
      "sk-canary-ND2-CLIKEY-0002",
    );
    expect(withYes.code, withYes.stderr).toBe(0);
  });

  it("rejects an unknown vendor", async () => {
    const result = await runCli(home, ["signup", "complete", "not-a-vendor", "--stdin"], API_KEY);
    expect(result.code).toBe(66);
  });

  it("serpapi (env-only) stores the raw key with no header injection metadata", async () => {
    const result = await runCli(home, ["signup", "complete", "serpapi", "--stdin"], API_KEY);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("skeletonkey run --env SERPAPI_API_KEY=vault://serpapi-main");

    const list = await runCli(home, ["list", "--json"]);
    const rows = JSON.parse(list.stdout) as Record<string, unknown>[];
    const row = rows.find((r) => r["alias"] === "serpapi-main");
    expect(row).toBeDefined();

    const run = await runCli(home, [
      "run",
      "--env",
      "X=vault://serpapi-main",
      "--",
      "node",
      "-e",
      `process.stdout.write(process.env.X === ${JSON.stringify(API_KEY)} ? 'OK' : 'MISMATCH')`,
    ]);
    expect(run.stdout.trim()).toBe("OK");
  });
});

describe("skeletonkey signup abandon", () => {
  let home: string;
  beforeEach(async () => {
    home = makeHome();
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  });
  afterEach(() => removeHome(home));

  it("marks a session abandoned", async () => {
    await runCli(home, ["signup", "start", "apify", "--no-open"]);
    const result = await runCli(home, ["signup", "abandon", "apify"]);
    expect(result.code, result.stderr).toBe(0);
    const status = await runCli(home, ["signup", "status", "apify", "--json"]);
    const rows = JSON.parse(status.stdout) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ state: "abandoned" });
  });

  it("errors when there is no session to abandon", async () => {
    const result = await runCli(home, ["signup", "abandon", "apify"]);
    expect(result.code).toBe(66);
    expect(result.stderr).toContain("error entry_not_found");
  });
});
