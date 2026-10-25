/**
 * The secret value resolution ladder (§5a, D1).
 *
 *   1. Bitwarden, automatic -- no human prompt.
 *   2. The bound inbox, automatic -- email OTPs and magic links only.
 *   3. The Secure Input Popup -- localhost page, announced by an OS
 *      notification, never the agent's terminal.
 *
 * Stops at the first rung that answers. Two rules sit above all three:
 *
 *   - the origin must be on the domain allowlist, or nothing is asked of any
 *     rung at all (§9: lookalike domains);
 *   - whatever is resolved is registered with the redactor immediately, so the
 *     value cannot appear in a later log line even by accident.
 */
import type { Allowlist } from "../allowlist.js";
import type { Notifier } from "../notify.js";
import { globalRedactor, type Redactor } from "../redact.js";
import type {
  SecretOutcome,
  SecretRequest,
  SecretResolution,
  SecretSource,
} from "./types.js";

export interface LadderOptions {
  /** In ladder order. Anything not listed simply is not tried. */
  sources: SecretSource[];
  allowlist: Allowlist;
  /** Values are registered here so later logs cannot print them. */
  redactor?: Redactor;
  /** Receives one line per rung. Never a value. */
  log?: (line: string) => void;
  /** Told when an origin is refused, so the human hears about it (§9). */
  notifier?: Notifier;
}

export interface LadderAttempt {
  source: string;
  answered: boolean;
  detail: string | null;
}

export interface LadderResult {
  outcome: SecretOutcome;
  /** One row per rung tried, for the runner's log and the human's page. */
  attempts: LadderAttempt[];
}

export async function resolveSecret(
  request: SecretRequest,
  options: LadderOptions,
): Promise<LadderResult> {
  const log = options.log ?? ((): void => {});
  const redactor = options.redactor ?? globalRedactor;
  const attempts: LadderAttempt[] = [];

  const check = options.allowlist.checkOrigin(request.origin, { vendor: request.vendor });
  if (!check.allowed) {
    log(
      `! ladder refused ${request.class} for ${request.vendor}: origin not allowlisted ` +
        `(${check.reason})`,
    );
    void options.notifier?.notify({
      title: "SkeletonKey blocked a secret request",
      body:
        `${request.vendor} asked for ${request.field} on ${check.host}, which is not on the ` +
        "domain allowlist. Nothing was filled.",
    });
    return {
      attempts,
      outcome: {
        source: null,
        kind: "blocked",
        detail:
          `${check.reason} No rung of the ladder was asked, and the human has been told. ` +
          "SkeletonKey fills secrets only on origins the API index vouches for.",
      },
    };
  }

  for (const source of options.sources) {
    if (!source.handles(request.class)) {
      attempts.push({
        source: source.id,
        answered: false,
        detail: `does not handle ${request.class}`,
      });
      continue;
    }
    let resolution: SecretResolution | null = null;
    try {
      resolution = await source.resolve(request);
    } catch (error) {
      // A rung that throws is a rung that did not answer. Never fatal, and the
      // message is redacted in case something put a value in it.
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ source: source.id, answered: false, detail: redactor.redact(message) });
      log(`! ladder rung ${source.id} failed: ${redactor.redact(message)}`);
      continue;
    }
    if (resolution === null) {
      const detail = source.lastDetail();
      attempts.push({ source: source.id, answered: false, detail });
      log(`ladder rung ${source.id}: no answer${detail === null ? "" : ` -- ${detail}`}`);
      continue;
    }
    // Register before anything else can be logged.
    redactor.add(resolution.value);
    attempts.push({ source: source.id, answered: true, detail: resolution.detail });
    log(
      `ladder resolved ${request.class} for ${request.vendor} from ${source.id} ` +
        `(${resolution.value.length} chars, value not logged)`,
    );
    return { attempts, outcome: resolution };
  }

  log(`! ladder exhausted for ${request.class} (${request.vendor}): no rung could answer`);
  return {
    attempts,
    outcome: {
      source: null,
      kind: "unavailable",
      detail:
        `No rung of the ladder could supply ${request.field} for ${request.vendor}. The agent is ` +
        "not asked to supply it: the human is, through the Secure Input Popup.",
    },
  };
}
