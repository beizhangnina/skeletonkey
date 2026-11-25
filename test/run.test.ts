/**
 * U6: the `run` core.
 *
 * `runWithInjectedEnv` is deliberately free of `process.exit`: it returns the
 * child's exit code and lets the caller decide what to do with it. That makes
 * every precheck and every exit code testable without spawning a CLI.
 *
 * The child is always `node -e`, so the suite does not depend on anything
 * being installed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeConfig } from "../src/config.js";
import { engageKillSwitch } from "../src/killswitch.js";
import { upsertKey } from "../src/keys.js";
import { runWithInjectedEnv } from "../src/run/run.js";
import { upsertEntry, fieldsFor } from "../src/vault/entries.js";
import { openEntryStore } from "../src/vault/entry-store.js";
import { makeHome, removeHome } from "./helpers/env.js";

const USERNAME = "FAKE-canary-USER-0xC0FFEE55";
const PASSWORD = "FAKE-canary-LOGINPW-0xC0FFEE66";
const API_KEY = "sk-test-FAKE-canary-APIKEY-0xC0FFEE11";

/** Collects what the child wrote. */
function sink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void): void {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

const sha256 = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

describe("skeletonkey run", () => {
  let home: string;

  beforeEach(async () => {
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "" }, home);
    const store = openEntryStore(home);
    await store.putLogin("github-login", { username: USERNAME, password: PASSWORD });
    upsertEntry(
      {
        name: "github-login",
        type: "login",
        fields: fieldsFor("login"),
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );
    await store.putApiKey("voyage-personal", API_KEY);
    upsertKey(
      {
        alias: "voyage-personal",
        platform: "Voyage AI",
        domain: "api.voyageai.com",
        header: "Authorization",
        format: "Bearer {key}",
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );
  });

  afterEach(() => {
    removeHome(home);
    delete process.env.BW_SESSION;
    delete process.env.OP_SESSION_abc;
  });

  it("injects the value into the child's environment and nowhere else", async () => {
    const out = sink();
    const err = sink();
    const digestFile = path.join(home, "digest.txt");

    const result = await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(digestFile)}, require("crypto").createHash("sha256").update(process.env.GITHUB_PASSWORD).digest("hex"))`,
      ],
      stdout: out.stream,
      stderr: err.stream,
    });

    expect(result.exitCode).toBe(0);
    // The proof that the injection really happened: the child hashed what it
    // was given, and the hash is the hash of the canary.
    expect(fs.readFileSync(digestFile, "utf8")).toBe(sha256(PASSWORD));

    // The parent's own environment is untouched.
    expect(process.env.GITHUB_PASSWORD).toBeUndefined();
    // And nothing was written to a file, a log, or the parent's stdout.
    expect(out.text()).toBe("");
    expect(err.text()).toBe("");
    expect(result.injections).toEqual([
      { name: "GITHUB_PASSWORD", ref: "vault://github-login.password" },
    ]);
  });

  it("redacts the value out of the child's stdout and stderr", async () => {
    const out = sink();
    const err = sink();

    await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [
        process.execPath,
        "-e",
        "process.stdout.write(process.env.GITHUB_PASSWORD); process.stderr.write(process.env.GITHUB_PASSWORD)",
      ],
      stdout: out.stream,
      stderr: err.stream,
    });

    expect(out.text()).not.toContain(PASSWORD);
    expect(out.text()).toContain("[redacted]");
    expect(err.text()).not.toContain(PASSWORD);
    expect(err.text()).toContain("[redacted]");
  });

  it("scrubs the vault-unlocking variables out of the child's environment", async () => {
    process.env.BW_SESSION = "FAKE-canary-BWSESSION-0xC0FFEE33";
    process.env.OP_SESSION_abc = "FAKE-canary-BWSESSION-0xC0FFEE33";
    const out = sink();

    await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      stdout: out.stream,
    });

    const childEnv = JSON.parse(out.text()) as Record<string, string>;
    expect(childEnv.GITHUB_PASSWORD).toBe("[redacted]");
    expect(childEnv.BW_SESSION).toBeUndefined();
    expect(childEnv.OP_SESSION_abc).toBeUndefined();
    expect(childEnv.SKELETONKEY_HOME).toBeUndefined();
  });

  it("gives the child the child's exit code", async () => {
    const result = await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [process.execPath, "-e", "process.exit(3)"],
      stdout: sink().stream,
      stderr: sink().stream,
    });
    expect(result.exitCode).toBe(3);
  });

  it("reports a child killed by a signal as 128 plus the signal", async () => {
    const result = await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      stdout: sink().stream,
      stderr: sink().stream,
    });
    expect(result.exitCode).toBe(128 + 15);
  });

  it("kills a child that runs past --timeout and reports 124", async () => {
    const err = sink();
    const result = await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      timeoutSeconds: 1,
      stdout: sink().stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(124);
    expect(err.text()).toContain("did not finish within 1s");
  });

  it("reports a command that does not exist as 127", async () => {
    const err = sink();
    const result = await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: ["/nonexistent/skeletonkey-test-command"],
      stdout: sink().stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(127);
    expect(err.text()).toContain("command not found");
  });

  it("runs the child in --cwd", async () => {
    const out = sink();
    const dir = path.join(home, "workdir");
    fs.mkdirSync(dir, { recursive: true });
    await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
      cwd: dir,
      stdout: out.stream,
      stderr: sink().stream,
    });
    expect(fs.realpathSync(out.text())).toBe(fs.realpathSync(dir));
  });

  it("warns when an injected name shadows a parent variable, without the value", async () => {
    process.env.GITHUB_PASSWORD = "the-old-one";
    const err = sink();
    const result = await runWithInjectedEnv({
      home,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
      command: [process.execPath, "-e", "process.exit(0)"],
      stdout: sink().stream,
      stderr: err.stream,
    });
    expect(result.overridden).toEqual(["GITHUB_PASSWORD"]);
    expect(err.text()).toContain("GITHUB_PASSWORD overridden for the child process.");
    expect(err.text()).not.toContain(PASSWORD);
    delete process.env.GITHUB_PASSWORD;
  });
});

describe("the run prechecks", () => {
  let home: string;
  const base = {
    command: [process.execPath, "-e", "process.exit(0)"],
    stdout: sink().stream,
    stderr: sink().stream,
  };

  beforeEach(async () => {
    home = makeHome();
    writeConfig({ email: "dev@example.test", backend: "file", created: "" }, home);
    const store = openEntryStore(home);
    await store.putLogin("github-login", { username: USERNAME, password: PASSWORD });
    upsertEntry(
      {
        name: "github-login",
        type: "login",
        fields: fieldsFor("login"),
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: false,
      },
      home,
    );
  });
  afterEach(() => {
    removeHome(home);
  });

  it("refuses a variable name that is not a variable name", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "not a name", value: "vault://github-login.password" }],
      }),
    ).rejects.toMatchObject({ code: "usage" });
  });

  it("refuses the same name twice", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [
          { name: "P", value: "vault://github-login.password" },
          { name: "P", value: "vault://github-login.username" },
        ],
      }),
    ).rejects.toMatchObject({ code: "usage" });
  });

  it("refuses a literal value", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "hunter2" }],
      }),
    ).rejects.toMatchObject({ code: "usage" });
  });

  it("refuses a reference that does not parse", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "vault://x/y" }],
      }),
    ).rejects.toMatchObject({ code: "bad_vault_uri" });
  });

  it("refuses an empty command", async () => {
    await expect(
      runWithInjectedEnv({ ...base, home, command: [], env: [] }),
    ).rejects.toMatchObject({ code: "usage" });
  });

  it("refuses a --cwd that does not exist", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        cwd: path.join(home, "nope"),
        env: [{ name: "P", value: "vault://github-login.password" }],
      }),
    ).rejects.toMatchObject({ code: "usage" });
  });

  it("reports an entry that does not exist, with the closest names", async () => {
    let error: { code: string; message: string; hint?: string } | undefined;
    try {
      await runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "vault://github-logon.password" }],
      });
    } catch (thrown) {
      error = thrown as typeof error;
    }
    expect(error?.code).toBe("entry_not_found");
    expect(error?.message).toContain("github-logon");
    expect(error?.hint).toContain("github-login");
  });

  it("asks which field a login wants", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "vault://github-login" }],
      }),
    ).rejects.toMatchObject({ code: "field_not_found" });
  });

  it("refuses a field the entry does not have", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "vault://github-login.totp" }],
      }),
    ).rejects.toMatchObject({ code: "field_not_found" });
  });

  it("refuses to set a variable SkeletonKey scrubs", async () => {
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "BW_SESSION", value: "vault://github-login.password" }],
      }),
    ).rejects.toMatchObject({ code: "reserved_env_name" });
  });

  it("refuses to run while the kill switch is engaged", async () => {
    engageKillSwitch({ reason: "test" }, home);
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "vault://github-login.password" }],
      }),
    ).rejects.toMatchObject({ code: "kill_switch" });
  });

  it("refuses a disabled entry", async () => {
    upsertKey(
      {
        alias: "voyage-personal",
        platform: "Voyage AI",
        domain: "api.voyageai.com",
        header: "Authorization",
        format: "Bearer {key}",
        created: "2026-10-30T12:00:00.000Z",
        last_used: null,
        disabled: true,
      },
      home,
    );
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "P", value: "vault://voyage-personal.api_key" }],
      }),
    ).rejects.toMatchObject({ code: "entry_disabled" });
  });

  it("does every precheck without reading a value or starting anything", async () => {
    const result = await runWithInjectedEnv({
      ...base,
      home,
      dryRun: true,
      env: [{ name: "GITHUB_PASSWORD", value: "vault://github-login.password" }],
    });
    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.injections).toEqual([
      { name: "GITHUB_PASSWORD", ref: "vault://github-login.password" },
    ]);
  });

  it("checks the flag syntax before the vault syntax", async () => {
    // Both are wrong: the flag error wins, because it comes first.
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "not a name", value: "vault://x/y" }],
      }),
    ).rejects.toMatchObject({ code: "usage" });
  });

  it("checks the entry before the reserved name", async () => {
    // The entry does not exist and the name is reserved: the entry wins,
    // because the precheck order is fixed.
    await expect(
      runWithInjectedEnv({
        ...base,
        home,
        env: [{ name: "BW_SESSION", value: "vault://does-not-exist.password" }],
      }),
    ).rejects.toMatchObject({ code: "entry_not_found" });
  });
});
