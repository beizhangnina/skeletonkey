/**
 * `skeletonkey run` -- put a secret in a child process, and nowhere else.
 *
 * The shape of the thing:
 *
 * ```
 * skeletonkey run --env NAME=vault://<entry>[.<field>] [--env ...] -- <cmd> [args...]
 * ```
 *
 * The value is read out of the vault **before** the child starts, put in the
 * child's environment, and nowhere else: not in the parent's environment, not
 * in a file, not in a log line. The child's stdout and stderr are scrubbed of
 * every known value on the way back, so the agent that ran the command sees
 * `[redacted]` where the secret was.
 *
 * The prechecks run in a fixed order, and every one of them happens before the
 * child is spawned. That is what makes the exit codes meaningful: a code in
 * the 64-77 range always means "the child never ran".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { SkeletonKeyError, formatCliError } from "../exit-codes.js";
import { killSwitchState } from "../killswitch.js";
import { skeletonKeyHome } from "../paths.js";
import { globalRedactor, Redactor } from "../redact.js";
import { listVaultEntries } from "../vault/entries.js";
import { openEntryStore, type ResolvedEntry } from "../vault/entry-store.js";
import { formatVaultUri, isVaultUri, parseVaultUri, type VaultUri } from "../vault/uri.js";
import { buildChildEnv, isReservedEnvName } from "./env.js";
import { createRedactingStream } from "./redact-stream.js";

/** How long a timed-out child gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000;

export interface RunEnvSpec {
  /** The variable name in the child, e.g. `GITHUB_PASSWORD`. */
  name: string;
  /** The reference, e.g. `vault://github-login.password`. */
  value: string;
}

export interface RunOptions {
  home?: string;
  /** The `--env` pairs, in the order they were given. */
  env: RunEnvSpec[];
  /** The command to run, after `--`. */
  command: string[];
  cwd?: string;
  /** Kill the child after this many seconds. */
  timeoutSeconds?: number;
  /** Do every precheck, print the plan, and stop. */
  dryRun?: boolean;
  /** Where the child's stdout goes. Defaults to this process's stdout. */
  stdout?: NodeJS.WritableStream;
  /** Where the child's stderr goes. Defaults to this process's stderr. */
  stderr?: NodeJS.WritableStream;
  /** The redactor to use. A fresh one is made when this is not given. */
  redactor?: Redactor;
}

export interface RunResult {
  /** The child's exit code, or the code SkeletonKey itself produced. */
  exitCode: number;
  dryRun: boolean;
  /** What was injected: the name and the reference. Never the value. */
  injections: { name: string; ref: string }[];
  /** The variable names that were removed from the child's environment. */
  scrubbed: string[];
  /** The injected names that already existed in the parent's environment. */
  overridden: string[];
}

interface PlannedInjection {
  name: string;
  ref: string;
  uri: VaultUri;
  entry: ResolvedEntry;
  field: string;
}

export async function runWithInjectedEnv(options: RunOptions): Promise<RunResult> {
  const home = options.home ?? skeletonKeyHome();
  const redactor = options.redactor ?? new Redactor();
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;

  // --- 1. flag syntax and NAME ------------------------------------------
  const seen = new Set<string>();
  for (const spec of options.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.name)) {
      throw new SkeletonKeyError(
        "usage",
        `Variable names must start with a letter or underscore and contain only [A-Za-z0-9_].`,
        `Got ${JSON.stringify(spec.name)}.`,
      );
    }
    if (seen.has(spec.name)) {
      throw new SkeletonKeyError(
        "usage",
        `--env ${spec.name} was given more than once.`,
        "Give every variable its own --env.",
      );
    }
    seen.add(spec.name);
    if (!isVaultUri(spec.value)) {
      throw new SkeletonKeyError(
        "usage",
        `--env ${spec.name} was given a literal value; only vault:// references are accepted.`,
        "Store it first: skeletonkey vault add <name> --type login",
      );
    }
  }
  if (options.command.length === 0) {
    throw new SkeletonKeyError(
      "usage",
      "run needs a command after --.",
      "skeletonkey run --env X=vault://a.password -- curl https://example.com",
    );
  }
  if (options.cwd !== undefined && !fs.existsSync(options.cwd)) {
    throw new SkeletonKeyError(
      "usage",
      `--cwd ${JSON.stringify(options.cwd)} does not exist.`,
      "Point it at a directory that does exist.",
    );
  }

  // --- 2. vault:// syntax ------------------------------------------------
  const uris = options.env.map((spec) => parseVaultUri(spec.value));

  // --- 3. home and config ------------------------------------------------
  const store = openEntryStore(home);

  // --- 4. the kill switch ------------------------------------------------
  if (killSwitchState(home).engaged) {
    throw new SkeletonKeyError(
      "kill_switch",
      "The SkeletonKey kill switch is engaged; no secret was read and nothing was run.",
      "A human clears it with `skeletonkey resume`.",
    );
  }

  // --- 5. the entry exists, is enabled, and has the field ----------------
  const planned: PlannedInjection[] = [];
  options.env.forEach((spec, index) => {
    const uri = uris[index];
    if (uri === undefined) return;
    const entry = store.resolve(uri.name);
    if (entry === null) {
      throw new SkeletonKeyError(
        "entry_not_found",
        `No vault entry named "${uri.name}".`,
        closestHint(uri.name, home),
      );
    }
    if (entry.disabled) {
      throw new SkeletonKeyError(
        "entry_disabled",
        `Entry "${uri.name}" is disabled, so nothing was injected.`,
        `A human re-enables it with \`skeletonkey enable ${uri.name}\`.`,
      );
    }
    const field = resolveField(entry, uri.field);
    if (!entry.fields.includes(field)) {
      throw new SkeletonKeyError(
        "field_not_found",
        `Entry "${uri.name}" (${entry.type}) has no field "${field}".`,
        `Available fields: ${entry.fields.join(", ")}.`,
      );
    }
    planned.push({ name: spec.name, ref: formatVaultUri(uri.name, field), uri, entry, field });
  });

  // --- 6. the injected names must not be ones we scrub -------------------
  for (const injection of planned) {
    if (isReservedEnvName(injection.name)) {
      throw new SkeletonKeyError(
        "reserved_env_name",
        `Refusing to set ${injection.name}: SkeletonKey scrubs that variable from child processes.`,
        `Pick another name; ${injection.name} would hand the vault itself to the child.`,
      );
    }
  }

  // The names that will be scrubbed, known before anything is read.
  const scrubbed = Object.keys(process.env)
    .filter((name) => isReservedEnvName(name))
    .sort();

  if (options.dryRun) {
    // Everything above is a precheck. The values themselves are not read, and
    // nothing is spawned.
    return {
      exitCode: 0,
      dryRun: true,
      injections: planned.map((injection) => ({ name: injection.name, ref: injection.ref })),
      scrubbed,
      overridden: [],
    };
  }

  // --- 7. the backend, and the values ------------------------------------
  await store.checkBackend();
  const injected: Record<string, string> = {};
  for (const injection of planned) {
    const value = await store.getField(injection.entry, injection.field);
    if (value === null) {
      throw new SkeletonKeyError(
        "entry_not_found",
        `No vault entry named "${injection.uri.name}".`,
        `The vault has no record for it. Re-add it: skeletonkey vault add ${injection.uri.name} --type ${injection.entry.type}`,
      );
    }
    // Registered before it can reach a single byte of output.
    redactor.addExact(value);
    redactor.add(value);
    globalRedactor.addExact(value);
    globalRedactor.add(value);
    injected[injection.name] = value;
  }

  // --- 8. the child ------------------------------------------------------
  const { env, scrubbed: scrubbedNames, overridden } = buildChildEnv({
    parentEnv: process.env,
    injected,
  });
  const injections = planned.map((injection) => ({ name: injection.name, ref: injection.ref }));

  for (const name of overridden) {
    err.write(`skeletonkey run: ${name} overridden for the child process.\n`);
  }

  const { exitCode, timedOut } = await spawnChild({
    command: options.command,
    env,
    cwd: options.cwd,
    timeoutSeconds: options.timeoutSeconds,
    redactor,
    out,
    err,
  });

  if (timedOut) {
    err.write(
      formatCliError(
        "run",
        new SkeletonKeyError(
          "timeout",
          `${options.command[0]} did not finish within ${options.timeoutSeconds}s; it was terminated.`,
          "Raise --timeout or run it without one.",
        ),
      ) + "\n",
    );
  }

  return { exitCode, dryRun: false, injections, scrubbed: scrubbedNames, overridden };
}
/**
 * Which field a reference means.
 *
 * An api_key has exactly one secret field, so it is the obvious default. A
 * login has two, so the reference has to say which one it wants.
 */
function resolveField(entry: ResolvedEntry, field: string | null): string {
  if (field !== null) return field;
  if (entry.fields.length === 1) return entry.fields[0] ?? "api_key";
  throw new SkeletonKeyError(
    "field_not_found",
    `Entry "${entry.name}" is a login; say which field you want.`,
    `Use vault://${entry.name}.password or vault://${entry.name}.username.`,
  );
}

/** "Closest: a, b." -- the names within an edit distance of two. */
function closestHint(name: string, home: string): string {
  const names = listVaultEntries(home).map((entry) => entry.name);
  const close = names
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter((row) => row.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((row) => row.candidate);
  if (close.length === 0) return "List them with `skeletonkey vault list`.";
  return `Closest: ${close.join(", ")}. List them with \`skeletonkey vault list\`.`;
}

/** Plain Levenshtein distance, used only to suggest a name. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

interface SpawnOptions {
  command: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutSeconds?: number;
  redactor: Redactor;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

interface SpawnOutcome {
  exitCode: number;
  /** True when SkeletonKey killed the child, not when the child exited itself. */
  timedOut: boolean;
}

/** Runs the child, scrubs what it prints, and reports how it ended. */
function spawnChild(options: SpawnOptions): Promise<SpawnOutcome> {
  const [program, ...args] = options.command;
  if (program === undefined) return Promise.resolve({ exitCode: 0, timedOut: false });

  return new Promise<SpawnOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve({ exitCode: code, timedOut });
    };

    const child = spawn(program, args, {
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      // stdin is inherited: an interactive child still gets a terminal.
      stdio: ["inherit", "pipe", "pipe"],
    });

    if (options.timeoutSeconds !== undefined && options.timeoutSeconds > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        graceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, options.timeoutSeconds * 1000);
      killTimer.unref?.();
    }

    if (child.stdout) pipeRedacted(child.stdout, options.redactor, options.out);
    if (child.stderr) pipeRedacted(child.stderr, options.redactor, options.err);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(127);
        return;
      }
      if (error.code === "EACCES") {
        finish(126);
        return;
      }
      finish(70);
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(124);
        return;
      }
      if (signal !== null) {
        finish(128 + (os.constants.signals[signal] ?? 0));
        return;
      }
      finish(code ?? 70);
    });
  });
}

/**
 * Streams a child's output through the redactor and on to the parent.
 *
 * The destination is not ended: the parent's own stdout stays open for
 * whatever else writes to it.
 */
function pipeRedacted(
  source: NodeJS.ReadableStream,
  redactor: Redactor,
  destination: NodeJS.WritableStream,
): void {
  const scrubber = createRedactingStream(redactor);
  scrubber.on("error", () => {
    // A broken pipe is not our problem; the child's exit code is.
  });
  scrubber.pipe(destination, { end: false });
  source.pipe(scrubber);
}
