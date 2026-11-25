/**
 * The environment a child process gets.
 *
 * Two things happen here:
 *
 *   1. **Scrubbing.** The variables that can unlock a vault are removed before
 *      the child starts. A child that could read `BW_SESSION` could unlock
 *      Bitwarden itself; a child that could read `SKELETONKEY_PASSPHRASE` could
 *      decrypt the encrypted file vault. The child gets the value it needs and
 *      nothing that could get it any more.
 *   2. **Injection.** The named variables are set to the values that were read
 *      out of the vault -- in the child only. The parent process's own
 *      environment is never touched.
 *
 * `SKELETONKEY_HOME` is deliberately kept: a child that shells out to
 * `skeletonkey` needs to find the same home, and the path unlocks nothing.
 */

/** Variables removed from the child's environment, by exact name. */
export const SCRUBBED_ENV_NAMES: readonly string[] = [
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
];

/** Variables removed from the child's environment, by prefix. */
export const SCRUBBED_ENV_PREFIXES: readonly string[] = ["OP_SESSION_"];

/** Variables that stay, even though they look scrubbable. */
export const KEPT_ENV_NAMES: readonly string[] = ["SKELETONKEY_HOME"];

/**
 * True when a variable name is one SkeletonKey scrubs. Injecting a value under
 * such a name would hand the vault itself to the child, so `run` refuses it.
 */
export function isReservedEnvName(name: string): boolean {
  if (KEPT_ENV_NAMES.includes(name)) return false;
  if (SCRUBBED_ENV_NAMES.includes(name)) return true;
  return SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface ChildEnvResult {
  /** The environment the child is spawned with. */
  env: Record<string, string>;
  /** The names that were removed, sorted. */
  scrubbed: string[];
  /** The injected names that already existed in the parent environment. */
  overridden: string[];
}

/**
 * Builds the child's environment: the parent's, minus the scrubbed names, plus
 * the injected values.
 */
export function buildChildEnv(options: {
  parentEnv: NodeJS.ProcessEnv;
  injected: Record<string, string>;
}): ChildEnvResult {
  const { parentEnv, injected } = options;
  const env: Record<string, string> = {};
  const scrubbed: string[] = [];
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (isReservedEnvName(name)) {
      scrubbed.push(name);
      continue;
    }
    env[name] = value;
  }
  const overridden: string[] = [];
  for (const [name, value] of Object.entries(injected)) {
    if (parentEnv[name] !== undefined) overridden.push(name);
    env[name] = value;
  }
  return { env, scrubbed: scrubbed.sort(), overridden: overridden.sort() };
}
