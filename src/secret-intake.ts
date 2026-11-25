/**
 * Guards the secret-intake paths (`account add --store-key`, `signup
 * complete`, the legacy `add`/`vault add --type api_key`) against a value
 * that is shaped like a payment instrument rather than an API key.
 * SkeletonKey never stores card data, by design -- see `src/payments.ts`.
 */
import { SkeletonKeyError } from "./exit-codes.js";
import { luhnValid } from "./redact.js";

/** Strips the separators someone might type between groups of digits. */
function compactDigits(value: string): string {
  return value.replace(/[ -]/g, "");
}

/**
 * Throws when `secret`, once spaces/dashes are removed, is a 13-19 digit run
 * that passes the Luhn check. The thrown error never contains the value or
 * any of its digits.
 */
export function rejectIfPaymentCard(secret: string): void {
  const compact = compactDigits(secret);
  if (/^\d{13,19}$/.test(compact) && luhnValid(compact)) {
    throw new SkeletonKeyError(
      "card_number_rejected",
      "this looks like a payment card number; SkeletonKey never stores card data",
      "Use the API key the vendor issued, not a card number.",
    );
  }
}

/** Session `reason` recorded when `signup complete` refuses a card-shaped value. */
export const PAYMENT_SHAPED_REJECTION_REASON = "card_number_rejected";

/** True when `err` is the refusal thrown by `rejectIfPaymentCard`. */
export function isPaymentShapedRejection(err: unknown): boolean {
  return err instanceof SkeletonKeyError && err.code === "card_number_rejected";
}
