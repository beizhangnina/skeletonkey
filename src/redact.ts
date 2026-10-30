/**
 * One redaction utility, applied to every log line, every ledger field, and
 * every file this tool writes outside the vault.
 *
 * Two layers, because either one alone is not enough:
 *
 *   1. **Known values.** Anything the process has actually loaded -- a vault
 *      secret, a `bw` session token, a value a human typed into the Secure
 *      Input Popup -- is registered here and replaced wherever it appears.
 *   2. **Shapes.** Card numbers, CVVs, `sk-`/`pk-`-style keys, bearer tokens,
 *      and `password=`/`otp=` assignments are replaced on sight, even when this
 *      process has never seen that particular value. This is the layer that
 *      catches a secret arriving from somewhere nobody thought about.
 *
 * Nothing here ever returns a secret: redaction only ever shortens what a
 * caller already holds.
 */

export const REDACTED = "[redacted]";

/** Values shorter than this are too common to replace without mangling logs. */
const MIN_SECRET_LENGTH = 4;

/** Values that are facts rather than secrets, whatever they are labelled. */
const JSON_LITERALS = new Set(["null", "true", "false", "undefined", "none", "unknown"]);

/** Luhn check, so a long order number is not reported as a card. */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (Number.isNaN(value)) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Secret-shaped substrings, replaced wherever they appear.
 *
 * Each rule keeps whatever labelled the value (`password=`, `Authorization:
 * Bearer`) so a redacted line still says *what* was removed.
 */
const SHAPE_RULES: { name: string; pattern: RegExp; replace: (match: string, ...rest: string[]) => string }[] = [
  {
    // `Authorization: Bearer <token>` and friends, in a header dump or a log line.
    name: "bearer",
    pattern: /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_match, label) => `${label}${REDACTED}`,
  },
  {
    // Vendor key prefixes that are conventionally followed by the secret
    // itself. Deliberately narrow: a token is long AND contains a digit, so
    // ordinary field names (`key_page_url`, `api_shard_dirs`) are left alone.
    name: "prefixed-key",
    pattern: /\b((?:sk|pk|rk|ak|api|key|tok|ghp|gho|xox[baprs])[-_][A-Za-z0-9][A-Za-z0-9._-]{14,})/g,
    replace: (match) => (/\d/.test(match) ? REDACTED : match),
  },
  {
    // `password=...`, `secret: ...`, `otp = 123456`, `cvv:123`, `BW_SESSION=...`
    name: "labelled",
    pattern:
      /\b(password|passwd|passphrase|secret|api[_-]?key|apikey|token|session|bw_session|otp|one[_-]?time[_-]?code|cvv|cvc|csc|card[_-]?number|pan)\b(\s*[:=]\s*)("?)([^\s"',;)}\]]{3,})\3/gi,
    replace: (match, label, separator, quote, value) =>
      // `"billing_verified_url": null` and friends are facts, not secrets, and
      // "null means nobody checked" is load-bearing in this codebase.
      JSON_LITERALS.has(value.toLowerCase()) || value === REDACTED
        ? match
        : `${label}${separator}${quote}${REDACTED}${quote}`,
  },
  {
    // A bare 13-19 digit run that passes Luhn: a card number, with or without
    // spaces/dashes between groups.
    name: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replace: (match) => (luhnValid(match.replace(/[ -]/g, "")) ? REDACTED : match),
  },
];

/** Replaces secret-shaped substrings in `text`, without knowing any values. */
export function redactShapes(text: string): string {
  let out = text;
  for (const rule of SHAPE_RULES) {
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/**
 * A set of known secret values plus the shape rules.
 *
 * Register a value the moment it is read (`vault.get`, `bw get`, a popup
 * submission) and every log line, ledger field, and status file written
 * afterwards is covered.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string> = []) {
    this.addAll(secrets);
  }

  /** Registers one value. Short and empty values are ignored on purpose. */
  add(secret: string | null | undefined): this {
    if (typeof secret !== "string") return this;
    const value = secret.trim();
    if (value.length < MIN_SECRET_LENGTH) return this;
    this.secrets.add(value);
    return this;
  }

  addAll(secrets: Iterable<string>): this {
    for (const secret of secrets) this.add(secret);
    return this;
  }

  /** How many values are registered. Never the values themselves. */
  get size(): number {
    return this.secrets.size;
  }

  forget(): void {
    this.secrets.clear();
  }

  /** Known values first (longest first, so a prefix cannot survive), then shapes. */
  redact(text: string): string {
    let out = text;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED);
    }
    return redactShapes(out);
  }

  /** Deep-redacts a value for JSON output: strings in, redacted strings out. */
  redactDeep<T>(value: T): T {
    return redactValue(value, (text) => this.redact(text)) as T;
  }

  /** Wraps a logger so nothing can be printed without passing through here. */
  logger(sink: (line: string) => void): (line: string) => void {
    return (line: string) => sink(this.redact(line));
  }
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, redact);
    }
    return out;
  }
  return value;
}

/** Shape-only deep redaction, for a process that holds no secrets of its own. */
export function redactDeepShapes<T>(value: T): T {
  return redactValue(value, redactShapes) as T;
}

/**
 * The process-wide redactor. The runner registers every secret it loads here,
 * and the ledger and the request store redact through it, so a value that
 * reached memory in one place cannot be written out in another.
 */
export const globalRedactor = new Redactor();
