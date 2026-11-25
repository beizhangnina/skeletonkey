/**
 * U3: one exit-code table for `vault *` and `run`.
 *
 * The table is a contract with whoever scripts this tool, so it is pinned
 * here: no two names may share a number, every name must resolve back, and
 * the error format is the fixed two lines.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  EXIT,
  exitCodeName,
  formatCliError,
  printCliError,
  SkeletonKeyError,
} from "../src/exit-codes.js";
import { globalRedactor } from "../src/redact.js";

describe("the exit-code table", () => {
  it("gives every name its own number", () => {
    const numbers = Object.values(EXIT);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("resolves a number back to its name", () => {
    for (const [name, code] of Object.entries(EXIT)) {
      expect(exitCodeName(code)).toBe(name);
    }
    expect(exitCodeName(999)).toBe("internal");
  });

  it("keeps the sysexits range for the failures SkeletonKey produces itself", () => {
    // Everything in this range means "the child never ran".
    for (const name of [
      "usage",
      "no_home",
      "entry_not_found",
      "field_not_found",
      "vault_locked",
      "kill_switch",
      "internal",
      "entry_disabled",
      "bad_vault_uri",
      "reserved_env_name",
      "entry_corrupt",
      "name_taken",
    ] as const) {
      expect(EXIT[name], name).toBeGreaterThanOrEqual(64);
      expect(EXIT[name], name).toBeLessThanOrEqual(77);
    }
    expect(EXIT.ok).toBe(0);
    expect(EXIT.timeout).toBe(124);
    expect(EXIT.not_executable).toBe(126);
    expect(EXIT.command_not_found).toBe(127);
  });

  it("carries the code on the error itself", () => {
    const error = new SkeletonKeyError("entry_not_found", "No vault entry named \"x\".");
    expect(error.code).toBe("entry_not_found");
    expect(error.exitCode).toBe(66);
    expect(error.hint).toBeUndefined();
  });
});

describe("the error format", () => {
  it("is one line, plus an optional hint line", () => {
    const error = new SkeletonKeyError("usage", "run needs a command after --.", "Try harder.");
    expect(formatCliError("run", error)).toBe(
      "skeletonkey run: error usage: run needs a command after --.\nhint: Try harder.",
    );
  });

  it("leaves the hint out when there is none", () => {
    const error = new SkeletonKeyError("usage", "run needs a command after --.");
    expect(formatCliError("run", error)).toBe("skeletonkey run: error usage: run needs a command after --.");
  });

  it("redacts the message on the way out", () => {
    const secret = "FAKE-canary-ERRORMSG-0xC0FFEE77";
    globalRedactor.addExact(secret);
    try {
      const error = new SkeletonKeyError("internal", `it failed with ${secret} inside`);
      const text = formatCliError("run", error);
      expect(text).not.toContain(secret);
      expect(text).toContain("[redacted]");
    } finally {
      globalRedactor.forget();
    }
  });

  it("prints to stderr", () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      printCliError("vault add", new SkeletonKeyError("name_taken", "\"x\" already exists (login)."));
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }
    expect(written.join("")).toBe(
      'skeletonkey vault add: error name_taken: "x" already exists (login).\n',
    );
  });
});

afterEach(() => {
  globalRedactor.forget();
});
