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

## ND-2 first wave: `skeletonkey signup`

`skeletonkey signup` is a different, newer path than the executor above: a
guided human handoff for six vendors, with facts verified against each
vendor's own docs on 2026-11-24, and a bridge into the ND-1 account vault once
a human has the key. It does not use `AutoSignupExecutor` or `SIGNUP_URLS`
above -- see `src/signup/playbooks.ts` for why its `apollo` entry disagrees
with `SIGNUP_URLS.apollo`: Apollo's own docs publish no signup URL at all.

| Vendor | Signup URL | Key page | Auth |
| --- | --- | --- | --- |
| `apify` | https://console.apify.com/sign-up | https://console.apify.com/settings/integrations | `Authorization: Bearer {key}` |
| `serpapi` | https://serpapi.com/users/sign_up | none published ("Your Account" tab) | `api_key` query param -- **env-only**, no header |
| `firecrawl` | https://www.firecrawl.dev/signin | https://www.firecrawl.dev/app/api-keys | `Authorization: Bearer {key}` |
| `exa` | https://dashboard.exa.ai/login | https://dashboard.exa.ai/api-keys | `x-api-key: {key}` |
| `github` | https://github.com/signup | https://github.com/settings/personal-access-tokens/new | `Authorization: Bearer {key}` |
| `apollo` | none published (sign up from https://www.apollo.io) | https://app.apollo.io/#/settings/integrations | `x-api-key: {key}` |

Every one of these six is `automation: "human-handoff"`: there is no bundled
browser driver for any of them, so `skeletonkey signup start <vendor>`:

1. validates the vendor (unknown -> `entry_not_found`, exit 66, with a hint
   listing the six);
2. records a local session in `~/.skeletonkey/signups.yaml` (`0600`, no
   secrets: an id, the vendor, the account name, a state, timestamps, and the
   steps shown);
3. opens the official signup URL in a browser (unless `--no-open` or stdout is
   not a TTY -- then it just prints the URL);
4. prints the steps still to do, the official URLs, and the exact next
   command: `skeletonkey signup complete <vendor> --account <name>`.

It always exits 0, and the status line always says `status: needs_human` --
**it never prints "success" or "registered" when nothing was automated.**
`--json` returns `{"status":"needs_human","reason":"no_driver",...}`.

Trusted host code -- never the CLI, never an agent -- can inject a driver
(`Nd2SignupDriver` in `src/signup/drive.ts`) ahead of a future real browser
automation. The interface has exactly one method, `run()`, called at most
once: a `captcha`/`phone`/`oauth_consent`/`payment` outcome stops immediately
with nothing further to call and no payment field anywhere on the interface
to have asked for; a `complete` outcome hands back an opaque key string that
is bound into the vault the same way `account add --store-key` does, and only
a `vault://` reference is ever printed afterward.

`skeletonkey signup complete <vendor>` is how a human hands the key back,
through the same hidden-prompt/`--stdin`/`--email-stdin` contract
`account add` uses. It stores the key via `addAccount` with the playbook's own
domain/header/format, so the agent only ever sees the `vault://` reference and
the exact `skeletonkey run --env <ENV_HINT>=vault://<alias> -- <cmd>` example
-- never the key itself. `serpapi` authenticates with an `api_key` query
parameter, not a header: its key is stored with `injection: "env-only"` on the
`KeyMeta` row, so the proxy never invents a header for it (see
`src/proxy.ts`), while `skeletonkey run --env SERPAPI_API_KEY=vault://<alias>`
still works, because `run --env` reads the raw secret directly and never
applies `header`/`format` at all.

`skeletonkey signup status [<vendor>]` lists sessions and their states
(`needs_human`, `key_pending`, `bound`, `abandoned`); `skeletonkey signup
abandon <vendor>` marks the most recently touched session for that vendor
abandoned. The MCP tool `signup_status` is read-only and mirrors `status`,
plus a vendor's official URLs and human_steps when asked for one vendor --
there is no tool that can submit a key or complete a signup; only a human
running `skeletonkey signup complete` can.
