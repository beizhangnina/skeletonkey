# Signup executor

`AutoSignupExecutor` in `src/signup/executor.ts` implements the trusted-process
signup sequence for Apify, TikHub, Apollo and DropLeads. The local runner invokes
it after human approval. A trusted host can inject a per-run `SignupDriver`
through `RunnerOptions.signupRunner`; agent input cannot configure a driver.

The executor prefers Google, then other OAuth, then email/password. Passwords
are generated locally using cryptographic randomness and saved to Bitwarden
before submission. Password and API-key items have separate random aliases so
an existing login is not overwritten. Values travel to bw on stdin, not argv.
OTP entry uses the existing Secure Input Popup directly, never the inbox ladder.
Captcha, phone verification, OAuth consent and payment stop execution; the local
approval page displays the step and a fixed vendor URL. No payment is submitted
by this executor. Existing fiat payment policy remains in effect.

Only fixed step messages leave the executor. Vendor responses and exception
messages are not copied into results or logs. Drivers run inside the trusted
process: they must restrict navigation and credential submission to verified
vendor origins, keep session state private, and never log bodies or secrets.

## Live steps not implemented or verified

For **each of Apify, TikHub, Apollo and DropLeads**, these steps have only fake
coverage, not validation against the real vendor:

- Signup method discovery and Google/other OAuth redirects, consent and sessions.
- Email/password form submission, password requirements and account creation.
- Email OTP delivery, form submission and resend/expiry behavior.
- Captcha/phone detection and completion by a human.
- API-key provisioning, extraction and Bitwarden persistence against a live vault.

There are **no bundled live browser or HTTP vendor drivers**. The default runner
therefore reports `live_driver_unavailable` and hands off with the vendor URL.
The tests use a private fake HTTP protocol, not claimed vendor API endpoints.
Automation permissions and current vendor terms have not been verified.

Even with an injected driver, a created API key is saved to Bitwarden and the
request reports `key_binding_required`: the existing key registration flow must
bind the key to its API domain/header before it is a usable proxy handle. The
executor never presents a vault alias as a working proxy handle.

Tests launch loopback HTTP servers and an absolute-path fake bw binary with a
temporary HOME and Bitwarden data directory. Secure Input Popup submissions are
simulated. No real vendor, inbox, vault, card or agent config is touched.
