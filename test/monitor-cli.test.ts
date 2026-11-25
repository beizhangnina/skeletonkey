/**
 * ND-5: `skeletonkey monitor run|report|install-help`, driven as a real
 * subprocess against the file backend -- the same style test/accounts-cli.test.ts
 * uses for `account *`. Confirms the CLI end to end: exit codes, the
 * "cannot auto-compare" wording for a vendor with no verified usage API,
 * that `install-help` really never touches the filesystem, and that none of
 * the account canaries (key or plaintext email) leak onto any surface except
 * the plaintext test vault file.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devVaultPath } from "../src/paths.js";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

const APIFY_EMAIL = "canary-nd5-apify-0xC0FFEE01@example.test";
const APIFY_KEY = "sk-canary-ND5-APIFY-KEY-0xC0FFEE01";
const SAPERLY_EMAIL = "canary-nd5-saperly-0xC0FFEE02@example.test";
const SAPERLY_KEY = "sk-canary-ND5-SAPERLY-KEY-0xC0FFEE02";

const CANARIES = [APIFY_EMAIL, APIFY_KEY, SAPERLY_EMAIL, SAPERLY_KEY];

/** Every file under `root`, as absolute paths. */
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

/** Filenames a scheduler install would leave behind, anywhere under `root`. */
function schedulerArtifacts(root: string): string[] {
  const suspicious = /crontab|\.service$|\.timer$|\.plist$|LaunchAgents|systemd/i;
  return filesUnder(root)
    .map((file) => path.relative(root, file))
    .filter((rel) => suspicious.test(rel));
}

describe("skeletonkey monitor (CLI, file backend)", () => {
  let home: string;
  const surfaces: { name: string; text: string }[] = [];

  beforeEach(async () => {
    home = makeHome();
    surfaces.length = 0;

    const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    expect(init.code, init.stderr).toBe(0);

    // apify: usage_api.available is true in the bundled index, with an
    // implemented checker -- `--offline` still carries no previous run.
    const addApify = await runCli(
      home,
      [
        "account",
        "add",
        "apify-main",
        "--vendor",
        "apify",
        "--email-stdin",
        "--store-key",
        "--domain",
        "api.apify.com",
        "--stdin",
      ],
      `${APIFY_EMAIL}\n${APIFY_KEY}`,
    );
    expect(addApify.code, addApify.stderr).toBe(0);
    surfaces.push({ name: "cli:account add apify-main", text: `${addApify.stdout}\n${addApify.stderr}` });

    // saperly: usage_api.available is null in the bundled index -- "cannot
    // auto-compare" has to come from the honest "not verified" path.
    const addSaperly = await runCli(
      home,
      [
        "account",
        "add",
        "saperly-main",
        "--vendor",
        "saperly",
        "--email-stdin",
        "--store-key",
        "--domain",
        "saperly.test",
        "--stdin",
      ],
      `${SAPERLY_EMAIL}\n${SAPERLY_KEY}`,
    );
    expect(addSaperly.code, addSaperly.stderr).toBe(0);
    surfaces.push({ name: "cli:account add saperly-main", text: `${addSaperly.stdout}\n${addSaperly.stderr}` });
  });

  afterEach(() => {
    removeHome(home);
  });

  it("monitor run --json reports both accounts, with 'cannot auto-compare' for the null-usage_api vendor", async () => {
    const result = await runCli(home, ["monitor", "run", "--offline", "--json", "--no-notify"]);
    expect(result.code, result.stderr).toBe(0);
    surfaces.push({ name: "cli:monitor run --json", text: `${result.stdout}\n${result.stderr}` });

    const parsed = JSON.parse(result.stdout) as {
      alert_count: number;
      accounts: { name: string; vendor: string; reasons: string[] }[];
    };
    expect(parsed.alert_count).toBe(0);
    expect(parsed.accounts).toHaveLength(2);

    const saperly = parsed.accounts.find((a) => a.name === "saperly-main");
    expect(saperly?.reasons.join(" ")).toContain("cannot auto-compare");

    const apify = parsed.accounts.find((a) => a.name === "apify-main");
    expect(apify?.name).toBe("apify-main");
  });

  it("monitor run (table output) also mentions 'cannot auto-compare' for the null-usage_api vendor", async () => {
    const result = await runCli(home, ["monitor", "run", "--offline", "--no-notify"]);
    expect(result.code, result.stderr).toBe(0);
    surfaces.push({ name: "cli:monitor run (table)", text: `${result.stdout}\n${result.stderr}` });

    expect(result.stdout).toContain("cannot auto-compare");
    expect(result.stdout).toContain("apify-main");
    expect(result.stdout).toContain("saperly-main");
  });

  it("monitor report --latest prints the report `monitor run` wrote", async () => {
    const run = await runCli(home, ["monitor", "run", "--offline", "--no-notify"]);
    expect(run.code, run.stderr).toBe(0);
    surfaces.push({ name: "cli:monitor run (for report)", text: `${run.stdout}\n${run.stderr}` });

    const report = await runCli(home, ["monitor", "report", "--latest"]);
    expect(report.code, report.stderr).toBe(0);
    surfaces.push({ name: "cli:monitor report --latest", text: `${report.stdout}\n${report.stderr}` });
    expect(report.stdout).toContain("weekly-");
    expect(report.stdout).toContain("saperly-main");
  });

  it("monitor install-help only prints: no crontab/systemd/launchd file anywhere, and says so", async () => {
    const before = filesUnder(home);

    const result = await runCli(home, ["monitor", "install-help"]);
    expect(result.code, result.stderr).toBe(0);
    surfaces.push({ name: "cli:monitor install-help", text: `${result.stdout}\n${result.stderr}` });

    expect(result.stdout).toContain("never installs");
    expect(schedulerArtifacts(home)).toEqual([]);

    const after = filesUnder(home);
    expect(after.sort()).toEqual(before.sort());
  });

  it("leaks no canary (key or plaintext email) onto stdout/stderr or any file except the plaintext vault", async () => {
    for (const argv of [
      ["monitor", "run", "--offline", "--json", "--no-notify"],
      ["monitor", "run", "--offline", "--no-notify"],
      ["monitor", "report", "--latest"],
      ["monitor", "install-help"],
    ]) {
      const result = await runCli(home, argv);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
      surfaces.push({ name: `cli:${argv.join(" ")}`, text: `${result.stdout}\n${result.stderr}` });
    }

    // Sanity: the keys really are in the plaintext test vault (the email is
    // never stored anywhere, not even there -- only its masked hint is).
    const vaultText = fs.readFileSync(devVaultPath(home), "utf8");
    expect(vaultText).toContain(APIFY_KEY);
    expect(vaultText).toContain(SAPERLY_KEY);

    for (const file of filesUnder(home)) {
      if (file === devVaultPath(home)) continue;
      surfaces.push({
        name: `file:${path.relative(home, file)}`,
        text: fs.readFileSync(file).toString("latin1"),
      });
    }

    expect(surfaces.length).toBeGreaterThan(5);
    for (const surface of surfaces) {
      for (const canary of CANARIES) {
        expect(surface.text, `${surface.name} leaked a canary`).not.toContain(canary);
      }
    }
  });
});
