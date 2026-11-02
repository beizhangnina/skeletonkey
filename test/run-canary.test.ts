/**
 * The HARD RULE for `skeletonkey run`, as a test.
 *
 * A secret that goes into a child process must never come back out of it, and
 * it must never appear anywhere else either: not in the CLI's own output, not
 * in an error message, not in a file under SKELETONKEY_HOME.
 *
 * Every value below is a fake canary. The suite pushes them through the real
 * code path -- the vault, the `vault://` grammar, the child process -- and
 * then sweeps every surface an agent (or a human reading a terminal) can see.
 *
 * The sweep is not satisfied by "the canary is gone". Each surface also has to
 * show that the injection really happened: the child hashes what it was given,
 * and the hash is compared with the hash of the canary. Without that, a broken
 * injection would look exactly like a clean one.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome, removeHome, runCli } from "./helpers/env.js";

/** Fake values, never a real secret. */
const CANARIES = {
  api_key: "sk-test-FAKE-canary-APIKEY-0xC0FFEE11",
  login_username: "FAKE-canary-USER-0xC0FFEE55",
  login_password: "FAKE-canary-LOGINPW-0xC0FFEE66",
  /** Only ever a session token in the parent's environment. */
  bw_session: "FAKE-canary-BWSESSION-0xC0FFEE33",
};

/** Fragments that would betray a leak even if something truncated the value. */
const FRAGMENTS = ["0xC0FFEE11", "0xC0FFEE55", "0xC0FFEE66", "0xC0FFEE33", "sk-test-FAKE-canary"];

const ENTRY = "github-login";

interface Harness {
  home: string;
  surfaces: { name: string; text: string }[];
}

async function setUp(): Promise<Harness> {
  const home = makeHome();
  const surfaces: { name: string; text: string }[] = [];
  const init = await runCli(home, ["init", "--email", "dev@example.test", "--backend", "file"]);
  expect(init.code, init.stderr).toBe(0);
  surfaces.push({ name: "cli:init", text: `${init.stdout}\n${init.stderr}` });

  const login = await runCli(
    home,
    ["vault", "add", ENTRY, "--type", "login", "--stdin", "--username", CANARIES.login_username],
    CANARIES.login_password,
  );
  expect(login.code, login.stderr).toBe(0);
  surfaces.push({ name: "cli:vault add (login)", text: `${login.stdout}\n${login.stderr}` });

  const key = await runCli(
    home,
    [
      "vault",
      "add",
      "voyage-personal",
      "--type",
      "api_key",
      "--platform",
      "Voyage AI",
      "--domain",
      "api.voyageai.com",
    ],
    CANARIES.api_key,
  );
  expect(key.code, key.stderr).toBe(0);
  surfaces.push({ name: "cli:vault add (api_key)", text: `${key.stdout}\n${key.stderr}` });

  return { home, surfaces };
}

/** Every file under a directory, as latin1 so a secret in a binary file shows. */
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

describe("HARD RULE: a secret that goes into a child process never comes back out", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setUp();
  });
  afterEach(() => {
    removeHome(h.home);
  });

  it("keeps the canary out of the child's stdout, stderr, and every other surface", async () => {
    const surfaces = h.surfaces;
    const childEnv = {
      // A session token in the parent's environment: the child must not get it.
      BW_SESSION: CANARIES.bw_session,
      OP_SESSION_abc: CANARIES.bw_session,
      SKELETONKEY_PASSPHRASE: CANARIES.bw_session,
    };

    // --- 1. the child's stdout -------------------------------------------
    const stdout = await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.env.P)",
      ],
      "",
      childEnv,
    );
    expect(stdout.code, stdout.stderr).toBe(0);
    surfaces.push({ name: "child stdout", text: stdout.stdout });
    surfaces.push({ name: "run stdout (child)", text: stdout.stderr });
    // The child really got the value...
    expect(stdout.stdout).toContain("[redacted]");
    // ...and what came back is not the value.
    expect(stdout.stdout).not.toContain(CANARIES.login_password);

    // --- 2. the child's stderr -------------------------------------------
    const stderr = await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--",
        process.execPath,
        "-e",
        "process.stderr.write(process.env.P)",
      ],
      "",
      childEnv,
    );
    expect(stderr.code, stderr.stderr).toBe(0);
    surfaces.push({ name: "child stderr", text: stderr.stderr });
    expect(stderr.stderr).toContain("[redacted]");
    expect(stderr.stderr).not.toContain(CANARIES.login_password);

    // --- 3. the value, one byte at a time --------------------------------
    // The streaming redactor has to hold a secret back across chunk
    // boundaries. (The unit test in redact-stream.test.ts cuts the boundary
    // exactly; here the child does the cutting.)
    const chunked = await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--",
        process.execPath,
        "-e",
        "const v = process.env.P; let i = 0; const t = setInterval(() => { process.stdout.write(v[i] ?? ''); i += 1; if (i >= v.length) clearInterval(t); }, 5);",
      ],
      "",
      childEnv,
    );
    expect(chunked.code, chunked.stderr).toBe(0);
    surfaces.push({ name: "child stdout (one byte at a time)", text: chunked.stdout });
    expect(chunked.stdout).not.toContain(CANARIES.login_password);
    expect(chunked.stdout).not.toContain("0xC0FFEE66");

    // --- 4. the child's environment --------------------------------------
    const dump = await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(process.env))",
      ],
      "",
      childEnv,
    );
    expect(dump.code, dump.stderr).toBe(0);
    surfaces.push({ name: "child env dump", text: dump.stdout });
    expect(dump.stdout).toContain('"P":"[redacted]"');
    // The variables that could unlock a vault are gone, name and all.
    expect(dump.stdout).not.toContain("BW_SESSION");
    expect(dump.stdout).not.toContain("OP_SESSION_abc");
    expect(dump.stdout).not.toContain("SKELETONKEY_PASSPHRASE");
    expect(dump.stdout).not.toContain(CANARIES.bw_session);

    // --- 5. the injection really happened --------------------------------
    // The child hashes what it was given. The hash is the proof, and the hash
    // is not a secret.
    const digestFile = path.join(h.home, "digest.txt");
    const digest = await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--",
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(digestFile)}, require("crypto").createHash("sha256").update(process.env.P).digest("hex"))`,
      ],
      "",
      childEnv,
    );
    expect(digest.code, digest.stderr).toBe(0);
    const { createHash } = await import("node:crypto");
    expect(fs.readFileSync(digestFile, "utf8")).toBe(
      createHash("sha256").update(CANARIES.login_password).digest("hex"),
    );

    // The same for an api_key entry.
    const keyDigestFile = path.join(h.home, "key-digest.txt");
    const keyDigest = await runCli(
      h.home,
      [
        "run",
        "--env",
        `K=vault://voyage-personal.api_key`,
        "--",
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(keyDigestFile)}, require("crypto").createHash("sha256").update(process.env.K).digest("hex"))`,
      ],
      "",
      childEnv,
    );
    expect(keyDigest.code, keyDigest.stderr).toBe(0);
    expect(fs.readFileSync(keyDigestFile, "utf8")).toBe(
      createHash("sha256").update(CANARIES.api_key).digest("hex"),
    );

    // --- 6. the error messages -------------------------------------------
    const errors: { name: string; result: { code: number; stdout: string; stderr: string } }[] = [
      {
        name: "error: no such entry",
        result: await runCli(
          h.home,
          ["run", "--env", "P=vault://no-such-entry.password", "--", process.execPath, "-e", "0"],
          "",
          childEnv,
        ),
      },
      {
        name: "error: bad reference",
        result: await runCli(
          h.home,
          ["run", "--env", "P=vault://x/y", "--", process.execPath, "-e", "0"],
          "",
          childEnv,
        ),
      },
      {
        name: "error: the canary as a literal value",
        result: await runCli(
          h.home,
          ["run", "--env", `P=${CANARIES.login_password}`, "--", process.execPath, "-e", "0"],
          "",
          childEnv,
        ),
      },
      {
        name: "error: the canary as the variable name",
        result: await runCli(
          h.home,
          [
            "run",
            "--env",
            `${CANARIES.login_password}=vault://${ENTRY}.password`,
            "--",
            process.execPath,
            "-e",
            "0",
          ],
          "",
          childEnv,
        ),
      },
      {
        // A field the entry does not have. The entry *name* is metadata and is
        // echoed on purpose (the closest-name hint needs it); what must never
        // be echoed is a stored value.
        name: "error: a field the entry does not have",
        result: await runCli(
          h.home,
          ["run", "--env", `P=vault://${ENTRY}.totp`, "--", process.execPath, "-e", "0"],
          "",
          childEnv,
        ),
      },
    ];
    for (const error of errors) {
      surfaces.push({ name: error.name, text: `${error.result.stdout}\n${error.result.stderr}` });
    }
    // The literal-value case is a usage error, and it must not repeat the
    // value the user typed.
    const literal = errors.find((error) => error.name.includes("literal value"));
    expect(literal?.result.code).toBe(64);
    expect(literal?.result.stderr).not.toContain(CANARIES.login_password);

    // --- 7. the dry run ---------------------------------------------------
    const dry = await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--dry-run",
        "--",
        process.execPath,
        "-e",
        "0",
      ],
      "",
      childEnv,
    );
    expect(dry.code, dry.stderr).toBe(0);
    surfaces.push({ name: "run --dry-run", text: `${dry.stdout}\n${dry.stderr}` });
    expect(dry.stdout).toContain(`P -> vault://${ENTRY}.password`);

    // --- 9. the CLI's own output ------------------------------------------
    for (const argv of [
      ["vault", "list"],
      ["vault", "list", "--json"],
      ["vault", "show", ENTRY],
      ["vault", "show", ENTRY, "--json"],
      ["vault", "show", "voyage-personal"],
      ["vault", "show", "voyage-personal", "--json"],
      ["list"],
      ["list", "--json"],
      ["ledger"],
      ["requests"],
      ["policy", "show"],
    ]) {
      const result = await runCli(h.home, argv, "", childEnv);
      surfaces.push({ name: `cli:${argv.join(" ")}`, text: `${result.stdout}\n${result.stderr}` });
    }
    // The JSON list holds no field values under any key.
    const jsonList = surfaces.find((surface) => surface.name === "cli:vault list --json");
    expect(jsonList?.text).not.toMatch(/"(password|username|api_key)"\s*:\s*"(?!\[redacted\])/);

    // --- 11. every file under the home ------------------------------------
    for (const file of filesUnder(h.home)) {
      if (file.endsWith("dev-vault.json")) continue; // the plaintext test vault IS the secret store
      if (file.endsWith("digest.txt") || file.endsWith("key-digest.txt")) continue; // written by the child
      surfaces.push({
        name: `file:${path.relative(h.home, file)}`,
        text: fs.readFileSync(file).toString("latin1"),
      });
    }
    expect(fs.statSync(path.join(h.home, "entries.yaml")).mode & 0o777).toBe(0o600);

    // --- the sweep --------------------------------------------------------
    expect(surfaces.length).toBeGreaterThan(20);
    for (const surface of surfaces) {
      for (const [name, value] of Object.entries(CANARIES)) {
        expect(surface.text, `${surface.name} leaked ${name}`).not.toContain(value);
      }
      for (const fragment of FRAGMENTS) {
        expect(surface.text, `${surface.name} leaked a fragment`).not.toContain(fragment);
      }
    }
  });

  it("never writes the secret into the metadata file, whatever the command", async () => {
    await runCli(
      h.home,
      [
        "run",
        "--env",
        `P=vault://${ENTRY}.password`,
        "--",
        process.execPath,
        "-e",
        `process.stdout.write(process.env.P); process.stderr.write(process.env.P)`,
      ],
    );

    const metadata = fs.readFileSync(path.join(h.home, "entries.yaml"), "utf8");
    expect(metadata).not.toContain(CANARIES.login_password);
    expect(metadata).not.toContain(CANARIES.login_username);
    expect(metadata).not.toContain("0xC0FFEE66");
    // The username is stored as a hint, and the hint is not the username.
    expect(metadata).not.toContain(CANARIES.login_username);
  });
});
