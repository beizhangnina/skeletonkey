import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { domainMatches, normalizeDomain, readKeys } from "../src/keys.js";
import { initWithKey, makeHome, removeHome, runCli } from "./helpers/env.js";

const SECRET = "sk-test-FAKE-super-secret-0001";

describe("keys.yaml metadata store", () => {
  let home: string;

  beforeEach(() => {
    home = makeHome();
  });
  afterEach(() => {
    removeHome(home);
  });

  it("stores metadata in keys.yaml and the secret only in the vault", async () => {
    await initWithKey(home, { alias: "openai-personal", secret: SECRET, domain: "api.example.com" });

    const keysYaml = fs.readFileSync(path.join(home, "keys.yaml"), "utf8");
    expect(keysYaml).not.toContain(SECRET);
    expect(keysYaml).not.toContain("sk-test");
    expect(keysYaml).toContain("alias: openai-personal");
    expect(keysYaml).toContain("domain: api.example.com");
    expect(keysYaml).toContain("header: Authorization");
    expect(keysYaml).toContain("format: Bearer {key}");
    expect(keysYaml).toContain("last_used: null");
    expect(keysYaml).toContain("disabled: false");

    const vault = JSON.parse(fs.readFileSync(path.join(home, "dev-vault.json"), "utf8")) as {
      secrets: Record<string, string>;
    };
    expect(vault.secrets["openai-personal"]).toBe(SECRET);
  });

  it("leaks no secret into any file except the dev vault", async () => {
    await initWithKey(home, { secret: SECRET });
    // Walks subdirectories too: `init` also writes the agent config (into a
    // temp home under here, never the real one).
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return [full];
      });
    const leaked = walk(home)
      .filter((file) => path.basename(file) !== "dev-vault.json")
      .filter((file) => fs.readFileSync(file).includes(SECRET));
    expect(leaked).toEqual([]);
  });

  it("writes keys.yaml and the dev vault with 0600 permissions", async () => {
    await initWithKey(home);
    for (const name of ["config.yaml", "keys.yaml", "dev-vault.json"]) {
      const mode = fs.statSync(path.join(home, name)).mode & 0o777;
      expect(mode, name).toBe(0o600);
    }
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it("rejects a --format without the {key} placeholder and stores nothing", async () => {
    await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
    const result = await runCli(
      home,
      ["add", "bad", "--platform", "X", "--domain", "api.example.com", "--format", "Bearer oops"],
      SECRET,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("{key}");
    expect(readKeys(home).keys).toHaveLength(0);
  });

  it("disable flips the flag without touching the stored secret", async () => {
    const { alias, secret } = await initWithKey(home);
    const disable = await runCli(home, ["disable", alias]);
    expect(disable.code).toBe(0);
    expect(readKeys(home).keys[0]?.disabled).toBe(true);

    const vault = JSON.parse(fs.readFileSync(path.join(home, "dev-vault.json"), "utf8")) as {
      secrets: Record<string, string>;
    };
    expect(vault.secrets[alias]).toBe(secret);

    const enable = await runCli(home, ["enable", alias]);
    expect(enable.code).toBe(0);
    expect(readKeys(home).keys[0]?.disabled).toBe(false);
  });

  it("list --json reports metadata and no secret", async () => {
    const { secret } = await initWithKey(home, { secret: SECRET });
    const result = await runCli(home, ["list", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(secret);
    const rows = JSON.parse(result.stdout) as { alias: string; last_used: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_used).toBeNull();
  });

  it("idle --days lists never-used keys and respects the threshold", async () => {
    const { alias } = await initWithKey(home);
    const idle = await runCli(home, ["idle", "--days", "7", "--json"]);
    expect(JSON.parse(idle.stdout)).toHaveLength(1);

    // A key used right now is not idle.
    const keysFile = path.join(home, "keys.yaml");
    fs.writeFileSync(
      keysFile,
      fs.readFileSync(keysFile, "utf8").replace("last_used: null", `last_used: "${new Date().toISOString()}"`),
    );
    const after = await runCli(home, ["idle", "--days", "7", "--json"]);
    expect(JSON.parse(after.stdout)).toHaveLength(0);
    expect(alias).toBeTruthy();
  });
});

describe("domain matching", () => {
  it("normalizes hosts, URLs and ports", () => {
    expect(normalizeDomain("API.Example.COM")).toBe("api.example.com");
    expect(normalizeDomain("https://api.example.com/v1/chat")).toBe("api.example.com");
    expect(normalizeDomain("127.0.0.1:8080")).toBe("127.0.0.1");
    expect(normalizeDomain(".example.com.")).toBe("example.com");
  });

  it("matches exact hosts and subdomains only", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("example.com", "api.example.com")).toBe(true);
    expect(domainMatches("api.example.com", "example.com")).toBe(false);
    expect(domainMatches("example.com", "notexample.com")).toBe(false);
    expect(domainMatches("example.com", "example.com.evil.test")).toBe(false);
    expect(domainMatches("127.0.0.1", "127.0.0.1:5555")).toBe(true);
  });
});
