/**
 * A fake `bw` on PATH.
 *
 * The suite must never touch a real Bitwarden vault, so every test that goes
 * through the built CLI gets this shell script instead: it answers `bw status`
 * from a JSON file, `bw list ...` from another, and appends every argv it was
 * given to a log the test can read back. That log is how "no secret and no
 * master password is ever passed to `bw` in argv" is asserted.
 */
import fs from "node:fs";
import path from "node:path";

const SCRIPT = `#!/bin/sh
# Fake Bitwarden CLI. Used by the SkeletonKey test suite only.
# Shell builtins only: PATH is replaced with this directory alone, so even
# \`cat\` is not reachable from in here.
printf '%s\\n' "$*" >> "$BW_FAKE_CALLS"
emit() {
  while IFS= read -r line; do printf '%s\\n' "$line"; done < "$1"
}
case "$1" in
  status)
    emit "$BW_FAKE_STATUS"
    ;;
  list)
    emit "$BW_FAKE_LIST"
    ;;
  create)
    # Reads base64 JSON on stdin, the way the real CLI does.
    while IFS= read -r ignored; do : "$ignored"; done
    printf '{"id":"fake-created"}\\n'
    ;;
  *)
    echo "fake bw: unexpected invocation: $*" >&2
    exit 1
    ;;
esac
`;

export type FakeBwState = "unlocked" | "locked" | "unauthenticated";

export interface FakeBw {
  /** Directory to put at the front of PATH. */
  dir: string;
  /** Env for `runCli`: PATH plus the fake's own variables. */
  env: Record<string, string>;
  /** Every argv line the fake was invoked with, in order. */
  calls(): string[];
  setStatus(state: FakeBwState, userEmail?: string | null): void;
  setItems(items: unknown[]): void;
}

/**
 * Writes the fake under `root` and returns the env that puts it on PATH.
 *
 * PATH is replaced, not prepended: a real `bw` installed on the machine
 * running the suite must not be reachable, or the test would talk to a real
 * vault. Nothing else in these code paths is spawned by name.
 */
export function installFakeBw(
  root: string,
  options: {
    state?: FakeBwState;
    /** Account `bw status` reports. */
    userEmail?: string | null;
    items?: unknown[];
    /** Leave the binary out, to test "not installed". */
    missing?: boolean;
  } = {},
): FakeBw {
  const dir = path.join(root, "fake-bin");
  fs.mkdirSync(dir, { recursive: true });
  const statusFile = path.join(root, "bw-status.json");
  const listFile = path.join(root, "bw-list.json");
  const callsFile = path.join(root, "bw-calls.log");
  fs.writeFileSync(callsFile, "");

  const fake: FakeBw = {
    dir,
    env: {
      PATH: dir,
      BW_FAKE_STATUS: statusFile,
      BW_FAKE_LIST: listFile,
      BW_FAKE_CALLS: callsFile,
    },
    calls: () =>
      fs
        .readFileSync(callsFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    setStatus: (state, userEmail) => {
      fs.writeFileSync(
        statusFile,
        `${JSON.stringify({
          serverUrl: null,
          lastSync: "2026-10-01T00:00:00.000Z",
          userEmail: userEmail ?? null,
          status: state,
        })}\n`,
      );
    },
    setItems: (items) => {
      fs.writeFileSync(listFile, `${JSON.stringify(items)}\n`);
    },
  };

  fake.setStatus(options.state ?? "unlocked", options.userEmail ?? null);
  fake.setItems(options.items ?? []);
  if (options.missing !== true) {
    const bin = path.join(dir, "bw");
    fs.writeFileSync(bin, SCRIPT, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
  }
  return fake;
}
