/**
 * ND-2 first-wave signup playbooks: facts verified against each vendor's own
 * docs on 2026-11-24 (see docs/signup.md). `null` where the vendor's docs
 * genuinely do not say -- never guessed.
 *
 * This is a *different* table from `SIGNUP_URLS` in `../signup/executor.ts`.
 * That one backs `AutoSignupExecutor`, the unverified live-automation path for
 * Apify/TikHub/Apollo/DropLeads behind a fake HTTP driver in tests, and its
 * `apollo` URL (`https://app.apollo.io/#/signup`) is pinned by
 * `test/signup.test.ts`. This table is the verified source of truth for the
 * ND-2 human-handoff `skeletonkey signup` command, and it intentionally
 * disagrees on `apollo`: Apollo's own docs give no signup URL at all, only
 * "sign up from https://www.apollo.io", so `signupUrl` here is `null`.
 *
 * Every playbook in this first wave is `automation: "human-handoff"`: no
 * bundled browser driver exists for any of these six vendors, so
 * `skeletonkey signup start` always stops for a human unless trusted host
 * code (never the CLI or an agent) injects one via `Nd2SignupDriver`.
 */
import type { KeyInjection } from "../types.js";

export interface SignupPlaybook {
  vendor: string;
  /** Where a human creates the account. `null` when the vendor publishes none. */
  signupUrl: string | null;
  /** Where a human creates/finds the API key, once the account exists. */
  keyPageUrl: string | null;
  /** The vendor's own auth docs. */
  docs: string;
  /** Destination domain the key is used against. */
  domain: string;
  /** Header to inject, or `null` when the vendor does not authenticate by header. */
  header: string | null;
  /** Header value template containing `{key}`, or `null` to match `header`. */
  format: string | null;
  /** The env var name conventionally used for this vendor's key. */
  envHint: string;
  /** `"env-only"` vendors (e.g. a query-string `api_key=`) get no proxy header. */
  injection: KeyInjection;
  /** What a human still has to do in the browser, in the usual order. */
  humanSteps: string[];
  automation: "human-handoff";
}

const PAYMENT_STEP = "payment / card (only if you choose a paid plan; SkeletonKey never pays)";
const KEY_PAGE_STEP = "create the API key on the key page";
const EMAIL_OTP_STEP = "email verification / OTP";
const CAPTCHA_STEP = "captcha";
const OAUTH_STEP = "OAuth consent (if using Google/GitHub sign-in)";
const PHONE_STEP = "phone verification (if asked)";

const PLAYBOOKS: readonly SignupPlaybook[] = [
  {
    vendor: "apify",
    signupUrl: "https://console.apify.com/sign-up",
    keyPageUrl: "https://console.apify.com/settings/integrations",
    docs: "https://docs.apify.com/platform/integrations/api",
    domain: "api.apify.com",
    header: "Authorization",
    format: "Bearer {key}",
    envHint: "APIFY_TOKEN",
    injection: "header",
    humanSteps: [EMAIL_OTP_STEP, CAPTCHA_STEP, PAYMENT_STEP, KEY_PAGE_STEP],
    automation: "human-handoff",
  },
  {
    vendor: "serpapi",
    signupUrl: "https://serpapi.com/users/sign_up",
    // SerpApi's own docs: "retrieve it inside the 'Your Account' tab" -- no
    // direct key-page URL is published.
    keyPageUrl: null,
    docs: "https://serpapi.com/account-api",
    domain: "serpapi.com",
    // Auth is the `api_key` query parameter, not a header: no header to
    // inject, and the proxy must not invent one for this key.
    header: null,
    format: null,
    envHint: "SERPAPI_API_KEY",
    injection: "env-only",
    humanSteps: [
      EMAIL_OTP_STEP,
      CAPTCHA_STEP,
      PAYMENT_STEP,
      'find the key inside the "Your Account" tab (SerpApi publishes no direct key-page URL)',
    ],
    automation: "human-handoff",
  },
  {
    vendor: "firecrawl",
    signupUrl: "https://www.firecrawl.dev/signin",
    keyPageUrl: "https://www.firecrawl.dev/app/api-keys",
    docs: "https://docs.firecrawl.dev/api-reference/introduction",
    domain: "api.firecrawl.dev",
    header: "Authorization",
    format: "Bearer {key}",
    envHint: "FIRECRAWL_API_KEY",
    injection: "header",
    humanSteps: [EMAIL_OTP_STEP, CAPTCHA_STEP, OAUTH_STEP, PAYMENT_STEP, KEY_PAGE_STEP],
    automation: "human-handoff",
  },
  {
    vendor: "exa",
    signupUrl: "https://dashboard.exa.ai/login",
    keyPageUrl: "https://dashboard.exa.ai/api-keys",
    docs: "https://exa.ai/docs/reference/search",
    domain: "api.exa.ai",
    header: "x-api-key",
    format: "{key}",
    envHint: "EXA_API_KEY",
    injection: "header",
    humanSteps: [EMAIL_OTP_STEP, OAUTH_STEP, PAYMENT_STEP, KEY_PAGE_STEP],
    automation: "human-handoff",
  },
  {
    vendor: "github",
    signupUrl: "https://github.com/signup",
    keyPageUrl: "https://github.com/settings/personal-access-tokens/new",
    docs: "https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api",
    domain: "api.github.com",
    header: "Authorization",
    format: "Bearer {key}",
    envHint: "GITHUB_TOKEN",
    injection: "header",
    humanSteps: [EMAIL_OTP_STEP, CAPTCHA_STEP, PHONE_STEP, "create a personal access token on the key page"],
    automation: "human-handoff",
  },
  {
    vendor: "apollo",
    // Apollo's own docs give no signup URL; a human signs up from
    // https://www.apollo.io itself.
    signupUrl: null,
    keyPageUrl: "https://app.apollo.io/#/settings/integrations",
    docs: "https://docs.apollo.io/docs/create-api-key",
    domain: "api.apollo.io",
    header: "x-api-key",
    format: "{key}",
    envHint: "APOLLO_API_KEY",
    injection: "header",
    humanSteps: [EMAIL_OTP_STEP, CAPTCHA_STEP, PHONE_STEP, PAYMENT_STEP, KEY_PAGE_STEP],
    automation: "human-handoff",
  },
];

/** Every first-wave vendor id, in table order. */
export const SIGNUP_VENDORS: readonly string[] = PLAYBOOKS.map((playbook) => playbook.vendor);

/** The playbook for one vendor, or `null` if it is not a first-wave vendor. */
export function signupPlaybook(vendor: string): SignupPlaybook | null {
  const target = vendor.trim().toLowerCase();
  return PLAYBOOKS.find((playbook) => playbook.vendor === target) ?? null;
}

/** Every first-wave playbook, in table order. */
export function listSignupPlaybooks(): readonly SignupPlaybook[] {
  return PLAYBOOKS;
}
