/**
 * U4: the environment a child process gets.
 *
 * The parent's environment, minus the names that could unlock a vault, plus
 * the values that were read out of the vault -- in the child only.
 */
import { describe, expect, it } from "vitest";
import {
  buildChildEnv,
  isReservedEnvName,
  KEPT_ENV_NAMES,
  SCRUBBED_ENV_NAMES,
  SCRUBBED_ENV_PREFIXES,
} from "../src/run/env.js";

describe("the scrub list", () => {
  it("names every variable that could unlock a vault", () => {
    for (const name of [
      "SKELETONKEY_PASSPHRASE",
      "BW_SESSION",
      "BW_CLIENTID",
      "BW_CLIENTSECRET",
      "BW_PASSWORD",
      "SKELETONKEY_GATEWAY_TOKEN",
      "SKELETONKEY_RUNNER_TOKEN",
      "OP_SERVICE_ACCOUNT_TOKEN",
      "SKELETONKEY_ALLOW_TEST_BACKEND",
      "SKELETONKEY_ALLOW_TTY_PROMPT",
    ]) {
      expect(SCRUBBED_ENV_NAMES, name).toContain(name);
      expect(isReservedEnvName(name), name).toBe(true);
    }
  });

  it("scrubs the 1Password session variables by prefix", () => {
    expect(SCRUBBED_ENV_PREFIXES).toContain("OP_SESSION_");
    expect(isReservedEnvName("OP_SESSION_abc")).toBe(true);
    expect(isReservedEnvName("OP_SESSION_")).toBe(true);
  });

  it("keeps the home, which unlocks nothing", () => {
    expect(KEPT_ENV_NAMES).toContain("SKELETONKEY_HOME");
    expect(isReservedEnvName("SKELETONKEY_HOME")).toBe(false);
  });

  it("leaves ordinary variables alone", () => {
    for (const name of ["PATH", "HOME", "LANG", "TERM", "GITHUB_PASSWORD", "AWS_SECRET_ACCESS_KEY"]) {
      expect(isReservedEnvName(name), name).toBe(false);
    }
  });
});

describe("building the child's environment", () => {
  it("removes the scrubbed names and keeps the rest", () => {
    const { env, scrubbed } = buildChildEnv({
      parentEnv: {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        BW_SESSION: "FAKE-session-0xC0FFEE33",
        SKELETONKEY_PASSPHRASE: "hunter2",
        OP_SESSION_abc: "FAKE-session-0xC0FFEE33",
        SKELETONKEY_HOME: "/home/dev/.skeletonkey",
      },
      injected: {},
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.SKELETONKEY_HOME).toBe("/home/dev/.skeletonkey");
    expect(env.BW_SESSION).toBeUndefined();
    expect(env.SKELETONKEY_PASSPHRASE).toBeUndefined();
    expect(env.OP_SESSION_abc).toBeUndefined();
    expect(scrubbed).toEqual(["BW_SESSION", "OP_SESSION_abc", "SKELETONKEY_PASSPHRASE"]);
  });

  it("puts the injected values in", () => {
    const { env } = buildChildEnv({
      parentEnv: { PATH: "/usr/bin" },
      injected: { GITHUB_PASSWORD: "FAKE-secret", API_TOKEN: "FAKE-token" },
    });
    expect(env.GITHUB_PASSWORD).toBe("FAKE-secret");
    expect(env.API_TOKEN).toBe("FAKE-token");
  });

  it("never touches the parent's own environment", () => {
    const parentEnv = { PATH: "/usr/bin", GITHUB_PASSWORD: "the-old-one" };
    const before = JSON.stringify(parentEnv);
    buildChildEnv({ parentEnv, injected: { GITHUB_PASSWORD: "the-new-one" } });
    expect(JSON.stringify(parentEnv)).toBe(before);
  });

  it("reports an injected name that shadows a parent variable", () => {
    const { env, overridden } = buildChildEnv({
      parentEnv: { GITHUB_PASSWORD: "the-old-one" },
      injected: { GITHUB_PASSWORD: "the-new-one" },
    });
    expect(overridden).toEqual(["GITHUB_PASSWORD"]);
    expect(env.GITHUB_PASSWORD).toBe("the-new-one");
  });

  it("reports no override when the name is new", () => {
    const { overridden } = buildChildEnv({
      parentEnv: { PATH: "/usr/bin" },
      injected: { GITHUB_PASSWORD: "FAKE-secret" },
    });
    expect(overridden).toEqual([]);
  });

  it("drops variables with no value", () => {
    const { env } = buildChildEnv({
      parentEnv: { PATH: "/usr/bin", EMPTY: undefined },
      injected: {},
    });
    expect("EMPTY" in env).toBe(false);
  });
});
