/**
 * One exit-code table for the `vault *` commands and `skeletonkey run`.
 *
 * The numbers are sysexits.h where they exist (64 = usage, 65 = data error,
 * 69 = service unavailable, 77 = permission problem) and the rest are ours.
 * Two rules make the table usable by a script:
 *
 *   1. A code in the 64-77 range is produced by SkeletonKey itself and always
 *      means **the child process never started**. Once the child is running,
 *      the exit code belongs to the child and nothing else.
 *   2. Every such failure prints exactly one line on stderr:
 *      `skeletonkey <command>: error <code_name>: <message>`
 *      optionally followed by `hint: <hint>`.
 *
 * The whole text goes through the global redactor, so an error message can
 * never be the thing that leaks a secret.
 */
import { globalRedactor } from "./redact.js";

export const EXIT = {
  ok: 0,
  /** flag syntax, a bad `--env`, a missing `--`, an empty command, ... */
  usage: 64,
  /** no ~/.skeletonkey, or config.yaml cannot be read */
  no_home: 65,
  /** no vault entry with that name */
  entry_not_found: 66,
  /** the entry has no such field (including "say which field") */
  field_not_found: 67,
  /** the backend is locked, missing, or refuses to work */
  vault_locked: 68,
  /** the kill switch is engaged */
  kill_switch: 69,
  /** something unexpected, or a write that did not read back */
  internal: 70,
  /** the entry exists but is disabled */
  entry_disabled: 71,
  /** `vault://` is not a well-formed reference */
  bad_vault_uri: 72,
  /** the injected variable name is one SkeletonKey scrubs */
  reserved_env_name: 73,
  /** a login envelope cannot be decoded */
  entry_corrupt: 74,
  /** `vault add` found the name already taken */
  name_taken: 75,
  /** the backend refuses to be used here (e.g. the plaintext test backend) */
  backend_refused: 77,
  /** `--timeout` fired */
  timeout: 124,
  /** the command could not be executed (EACCES) */
  not_executable: 126,
  /** the command does not exist (ENOENT) */
  command_not_found: 127,
} as const;

export type ExitCodeName = keyof typeof EXIT;

/** The name of an exit code, by number. Unknown numbers get `internal`. */
export function exitCodeName(code: number): ExitCodeName {
  const found = (Object.keys(EXIT) as ExitCodeName[]).find((name) => EXIT[name] === code);
  return found ?? "internal";
}

/**
 * An error with a code from the table above.
 *
 * `message` and `hint` are shown to whoever ran the command, so they must
 * never contain a secret: the redactor is applied on the way out as well.
 */
export class SkeletonKeyError extends Error {
  readonly code: ExitCodeName;
  readonly hint?: string;

  constructor(code: ExitCodeName, message: string, hint?: string) {
    super(message);
    this.name = "SkeletonKeyError";
    this.code = code;
    this.hint = hint;
  }

  /** The process exit code for this error. */
  get exitCode(): number {
    return EXIT[this.code];
  }
}

/**
 * The fixed two-line error format:
 *
 * ```
 * skeletonkey <command>: error <code_name>: <message>
 * hint: <hint>
 * ```
 *
 * Everything is redacted on the way out, so a message that somehow contained a
 * secret would not print it.
 */
export function formatCliError(command: string, error: SkeletonKeyError): string {
  const head = `skeletonkey ${command}: error ${error.code}: ${error.message}`;
  const text = error.hint === undefined ? head : `${head}\nhint: ${error.hint}`;
  return globalRedactor.redact(text);
}

/** Prints the fixed error format on stderr. */
export function printCliError(command: string, error: SkeletonKeyError): void {
  process.stderr.write(`${formatCliError(command, error)}\n`);
}
