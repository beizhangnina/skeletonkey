/**
 * The Bitwarden guidance end to end, through the built CLI, against a fake
 * `bw` script on PATH (`test/helpers/fake-bw.ts`).
 *
 * PATH is replaced rather than prepended, so a real `bw` on the machine
 * running the suite cannot be reached: no real vault, no real account, and no
 * real master password is ever involved.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeBw } from "./helpers/fake-bw.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const BOUND = "apis@example.test";
const VENDOR_PASSWORD = "FAKE-cli-vendor-password-0xB1";
const VENDOR_KEY = "sk-test-FAKE-cli-tikhub-0xB2";
const OTHER_PASSWORD = "FAKE-cli-other-mailbox-0xB3";

const ITEMS = [
  {
    id: "item-tikhub",
    name: "TikHub",
    login: {
      username: BOUND,
      password: VENDOR_PASSWORD,
      uris: [{ uri: "https://tikhub.io/login" }],
    },
    fields: [{ name: "API key", value: VENDOR_KEY, type: 1 }],
  },
  {
    id: "item-tikhub-other",
    name: "TikHub (work)",
    login: {
      username: "someone.else@corp.test",
      password: OTHER_PASSWORD,
      uris: [{ uri: "https://tikhub.io/login" }],
    },
  },
];

describe("`skeletonkey init --backend bitwarden` against a fake bw", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  const configFile = (): string => path.join(home, "config.yaml");

  it("initialises when the fake bw is unlocked as the bound email", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND });
    const result = await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/installed, logged in and unlocked/);
    expect(result.stderr).toContain(`matches the bound email ${BOUND}`);
    expect(result.stdout).toMatch(/backend:\s+bitwarden/);
    expect(fs.readFileSync(configFile(), "utf8")).toContain("backend: bitwarden");
    // One read of the state, and nothing else.
    expect(fake.calls()).toEqual(["status"]);
  });

  it("refuses to finish, with the unlock steps, when bw is locked", async () => {
    const fake = installFakeBw(home, { state: "locked", userEmail: BOUND });
    const result = await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('export BW_SESSION="$(bw unlock --raw)"');
    expect(result.stderr).toMatch(/never asks for, stores, or passes on your Bitwarden master password/);
    // Nothing was written: `init` is not half-done.
    expect(fs.existsSync(configFile())).toBe(false);
    expect(fake.calls()).toEqual(["status"]);
  });

  it("gives install steps and a `bw login <bound email>` line when bw is missing", async () => {
    const fake = installFakeBw(home, { missing: true });
    const result = await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("https://bitwarden.com/help/cli/");
    expect(result.stderr).toContain("npm install -g @bitwarden/cli");
    expect(result.stderr).toContain(`bw login ${BOUND}`);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it("initialises but warns when bw is logged in as another account", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: "personal@example.test" });
    const result = await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("NOT the bound email");
    expect(result.stderr).toContain("bw logout");
    expect(fs.existsSync(configFile())).toBe(true);
  });

  it("leaves the other backends alone: no bw call at all", async () => {
    const fake = installFakeBw(home, { state: "locked" });
    const result = await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "file", "--no-register"],
      "",
      fake.env,
    );
    expect(result.code).toBe(0);
    expect(fake.calls()).toEqual([]);
  });
});

describe("`skeletonkey bitwarden status`", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  async function init(fake: { env: Record<string, string> }): Promise<void> {
    const result = await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    expect(result.code).toBe(0);
  }

  it("reports installed, logged in, unlocked and the account", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND });
    await init(fake);
    const result = await runCli(home, ["bitwarden", "status"], "", fake.env);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/bw CLI: +installed/);
    expect(result.stdout).toMatch(/logged in: +yes/);
    expect(result.stdout).toMatch(/unlocked: +yes/);
    expect(result.stdout).toContain(`account:      ${BOUND}`);
    expect(result.stdout).toContain("(matches)");
  });

  it("answers as JSON, and `skk bw status` is the same command", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND });
    await init(fake);
    const result = await runCli(home, ["bw", "status", "--json"], "", fake.env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "unlocked",
      usable: true,
      account: BOUND,
      bound_email: BOUND,
      matches_bound_email: true,
      guidance: [],
    });
  });

  it("exits non-zero with the steps when bw is locked", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND });
    await init(fake);
    fake.setStatus("locked", BOUND);
    const result = await runCli(home, ["bitwarden", "status"], "", fake.env);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/unlocked: +no/);
    expect(result.stdout).toContain('export BW_SESSION="$(bw unlock --raw)"');
  });

  it("works before `init`, and says the bound email is unset", async () => {
    const fake = installFakeBw(home, { state: "unauthenticated" });
    const result = await runCli(home, ["bitwarden", "status"], "", fake.env);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("bound email:  unset");
    expect(result.stdout).toContain("bw login <your bound email>");
  });
});

describe("`skeletonkey bitwarden find <domain>`", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("finds the bound email's item for the domain and prints no value", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND, items: ITEMS });
    expect(
      (
        await runCli(
          home,
          ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
          "",
          fake.env,
        )
      ).code,
    ).toBe(0);

    const result = await runCli(home, ["bitwarden", "find", "api.tikhub.io"], "", fake.env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("TikHub (item-tikhub)");
    expect(result.stdout).toContain('API key in field "API key"');
    // The other mailbox's item for the same vendor is not in the answer.
    expect(result.stdout).not.toContain("item-tikhub-other");
    for (const value of [VENDOR_KEY, VENDOR_PASSWORD, OTHER_PASSWORD]) {
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(value);
    }

    const json = await runCli(home, ["bw", "find", "tikhub.io", "--json"], "", fake.env);
    const parsed = JSON.parse(json.stdout) as {
      items: { id: string; has_api_key: boolean; api_key?: unknown; password?: unknown }[];
      bound_email: string;
    };
    expect(parsed.bound_email).toBe(BOUND);
    expect(parsed.items.map((item) => item.id)).toEqual(["item-tikhub"]);
    expect(parsed.items[0]).toMatchObject({ has_api_key: true, has_password: true });
    expect(parsed.items[0]?.api_key).toBeUndefined();
    expect(parsed.items[0]?.password).toBeUndefined();
    expect(json.stdout).not.toContain(VENDOR_KEY);

    // Every `bw` invocation this whole test made: reads only, no secret and no
    // master password anywhere in argv.
    for (const call of fake.calls()) {
      expect(call).toMatch(/^(status|list items --search )/);
      expect(call).not.toMatch(/password|unlock|login|BW_SESSION/i);
      for (const value of [VENDOR_KEY, VENDOR_PASSWORD, OTHER_PASSWORD]) {
        expect(call).not.toContain(value);
      }
    }
  });

  it("says plainly when nothing matches", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND, items: ITEMS });
    await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    const result = await runCli(home, ["bitwarden", "find", "nothing.example"], "", fake.env);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No Bitwarden item for apis@example\.test mentions nothing\.example/);
  });

  it("refuses to look anything up while bw is locked, and exits non-zero", async () => {
    const fake = installFakeBw(home, { state: "unlocked", userEmail: BOUND, items: ITEMS });
    await runCli(
      home,
      ["init", "--email", BOUND, "--backend", "bitwarden", "--no-register"],
      "",
      fake.env,
    );
    fake.setStatus("locked", BOUND);
    const result = await runCli(home, ["bitwarden", "find", "api.tikhub.io"], "", fake.env);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/cannot be read right now/);
    expect(result.stdout).toContain('export BW_SESSION="$(bw unlock --raw)"');
    expect(fake.calls().filter((call) => call.startsWith("list"))).toEqual([]);
  });
});
