/**
 * Trusted-process signup executor. Drivers must enforce their vendor's origins
 * and keep browser sessions/response bodies out of logs and agent tools.
 * Live Apify, TikHub, Apollo and DropLeads OAuth, forms, OTP, challenges and
 * key provisioning are UNVERIFIED; see docs/signup.md. No guessed HTTP APIs.
 */
import { randomBytes } from "node:crypto";
import { BitwardenVault } from "../vault/bitwarden.js";
import { globalRedactor } from "../redact.js";
import { HumanHandoffSignupRunner, type SignupContext, type SignupOutcome, type SignupRunner } from "./types.js";

export const SIGNUP_URLS: Record<string, string> = {
  apify: "https://console.apify.com/sign-up",
  tikhub: "https://user.tikhub.io/",
  apollo: "https://app.apollo.io/#/signup",
  dropleads: "https://app.dropleads.io/auth/signup",
};
export type SignupStep =
  | { kind: "methods"; google: boolean; oauth: boolean; password: boolean }
  | { kind: "email_otp" }
  | { kind: "captcha" | "phone" | "oauth_consent" | "payment" }
  | { kind: "complete"; apiKey: string };
/** Internal only: these arguments and responses may contain secrets. */
export interface SignupDriver {
  open(): Promise<SignupStep>;
  oauth(provider: "google" | "oauth"): Promise<SignupStep>;
  password(email: string, password: string): Promise<SignupStep>;
  otp(value: string): Promise<SignupStep>;
}
export interface SignupExecutorOptions {
  /** Installed by trusted host code, never from agent input. Per-run sessions. */
  driverFor?: (vendor: string) => SignupDriver | undefined;
  vault?: BitwardenVault;
}
export class AutoSignupExecutor implements SignupRunner {
  readonly id = "auto-signup";
  constructor(private readonly options: SignupExecutorOptions = {}) {}
  playbookFor(vendor: string) {
    const url = SIGNUP_URLS[vendor.toLowerCase()];
    return url ? { vendor, domains: [new URL(url).hostname], automation: "unknown" as const } : null;
  }
  async run(context: SignupContext): Promise<SignupOutcome> {
    const vendor = context.vendor.toLowerCase();
    const url = SIGNUP_URLS[vendor];
    const log: string[] = [];
    const record = (line: string) => { log.push(line); context.log(line); };
    const handoff = (reason: string): SignupOutcome => {
      record(`Signup stopped: ${reason}.`);
      return { status: "needs_human", handle: null, reason, log, ...(url ? { vendorUrl: url } : {}) };
    };
    if (!url) return new HumanHandoffSignupRunner().run(context);
    try {
      const driver = this.options.driverFor?.(vendor);
      if (!driver) return handoff("live_driver_unavailable");
      const vault = this.options.vault ?? new BitwardenVault(undefined, context.email ?? undefined);
      let step = await driver.open();
      if (step.kind === "methods") {
        if (step.google || step.oauth) {
          record("Starting OAuth signup.");
          step = await driver.oauth(step.google ? "google" : "oauth");
        } else if (step.password && context.email) {
          const password = `Aa1!${randomBytes(32).toString("base64url")}`;
          globalRedactor.add(password);
          // A distinct random alias avoids overwriting an existing account login.
          await vault.set(`${vendor}-signup-password-${randomBytes(12).toString("hex")}`, password);
          record("Generated password saved to Bitwarden before submission.");
          step = await driver.password(context.email, password);
        } else return handoff("signup_method_unavailable");
      }
      if (step.kind === "email_otp") {
        record("Waiting for email OTP in Secure Input Popup.");
        // Deliberately bypass the ladder: no inbox or agent fallback.
        const otp = await context.resolvePopup?.({ class: "otp", vendor: context.vendor,
          origin: url, field: "email verification code" });
        if (!otp || otp.source !== "popup") return handoff("otp_unavailable");
        globalRedactor.add(otp.value);
        step = await driver.otp(otp.value);
      }
      if (step.kind !== "complete") {
        const reason = ["captcha", "phone", "oauth_consent", "payment"].includes(step.kind)
          ? step.kind : "unexpected_step";
        return handoff(reason);
      }
      if (typeof step.apiKey !== "string" || !step.apiKey.trim()) return handoff("key_unavailable");
      globalRedactor.add(step.apiKey);
      // Persist the credential, but don't claim it is a proxy handle. Binding is
      // a separate existing registration step requiring API domain/header info.
      await vault.set(`${vendor}-signup-key-${randomBytes(12).toString("hex")}`, step.apiKey);
      record("API key saved to Bitwarden.");
      return handoff("key_binding_required");
    } catch {
      // Never echo vendor bodies, bw stderr, or exception messages.
      return handoff("signup_failed");
    }
  }
}
