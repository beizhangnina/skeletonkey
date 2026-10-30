---
name: skeletonkey
description: Check SkeletonKey before calling any paid or key-gated API. Use when a task needs an external API (social data, scraping, embeddings, LLMs, geocoding, anything with an API key), when a call returns 401/403/429, or when you are about to ask a human for an API key. Finds whether a key already exists, gets access just-in-time via agent-assisted signup with the human confirming the final step, and routes calls through the local injecting proxy so you never hold the key.
---

# SkeletonKey

SkeletonKey holds this user's API keys. **You never see a key.** You call
APIs through a local proxy that attaches the credential on the way out, and the
proxy writes one ledger row per call so the user can see what you spent.

This file is also usable as an `AGENTS.md` snippet for Codex — the rules below
are the same either way.

## The rule

**Before calling any API that needs a key, ask SkeletonKey first.** Never ask
the user to paste a key into the chat, never read one from an `.env` file, and
never put one in a file, a commit, or an environment variable.

## Tools

SkeletonKey exposes an MCP server (`skeletonkey mcp`). None of its tools can return
a secret value — there is deliberately no such tool.

| Tool | Use it to |
| --- | --- |
| `find_api(capability)` | See which APIs are known for a capability, how they authenticate, how they are paid for (verified `billing` block), who resells them and at what per-call price, the recommended `{route, reason}`, and whether a key already exists. Searches `apis.yaml`, your local discovered rows, **and** the generated provider index in `data/apis/*.yaml`. |
| `list_keys()` | List every key: alias, platform, domain, state. Metadata only. |
| `key_status(alias)` | One key's state, last use, and recorded spend. |
| `request_access(platform, reason, est_budget)` | Get either a proxy URL to call through, or a signup plan with the vendor's auth facts, ready-made `register_key` arguments, and the explicit list of human-only gates. **Start here.** |
| `access_status(request_id)` | Poll the request `request_access` raised: `pending_approval`, `approved`, `ready`, `needs_human`, `denied`, `cancelled`, `voided`. Statuses only — never a key, a card, an OTP, a screenshot, or page text. |
| `cancel_request(request_id, reason?)` | Withdraw a request you no longer need, so the user is not left with a stale approval. You may cancel; you may never approve. |
| `spend_policy()` | The global monthly cap and per-vendor caps. Read-only: **there is no tool that can raise a cap or enable a key.** |
| `register_key(alias, platform, domain)` | After signup: ask the human to enter the key out of band. Header and format default to what the index records for that domain, not to `Bearer`. Pass `scheme: "http"` only for a vendor that genuinely is plain HTTP; the default is https (http for loopback hosts). |
| `ledger(alias?)` | Recent calls and spend, so you can report what a task cost. |
| `disable(alias)` | Stop a key being injected. Use the moment one looks compromised. |
| `discover_api(capability)` | **When `find_api` misses.** Returns the research recipe — which sources to read in which order, which field each one fills, and the rules. Reaches no network itself; you do the research. |
| `propose_entry(...)` | Write what you discovered into the local user index, `status: unverified`. Promoted to `verified` only after a call through the proxy returns `2xx`. |

A second process, the **trusted runner** (`skeletonkey runner`), is what actually
holds secrets and raises approvals. You never talk to it directly and it has no
verb that returns a secret value. If `access_status` comes back
`runner_unavailable`, ask the user to start it — do not attempt the work yourself.

If the MCP server is not available, the same things work from the shell:
`skeletonkey list`, `skeletonkey ledger`, `skeletonkey add <alias> ...` (the human runs
this one), `skeletonkey disable <alias>`, `skeletonkey policy show`. `skeletonkey stale-check` re-reads every page
the index claims a price was verified on and flags what moved — run it, or suggest it,
before trusting an old `verified_date`.

## Workflow

### 1. Check before you reach

```
find_api("web scraping")        -> what exists, and whether a key is on file
request_access(platform="Apify", reason="scrape 200 product pages", est_budget=5)
```

If `has_key` is true you get a `proxy_url`. Go to step 4.

If the key exists but is `disabled`, **stop and tell the user.** Do not work
around a disabled key — someone disabled it on purpose. The proxy will not even
forward the call: it answers `403 {"error": "key_disabled"}` itself, locally.
Only a human re-enables it, with `skeletonkey enable <alias>`.

**Say what you searched for.** `find_api` reports `search_terms` and
`ignored_terms`: generic words (`api`, `data`, `search`, `lookup`, …) are
dropped, and a query made only of those matches nothing on purpose. If
`match_count` is 0, name the capability or the vendor more precisely, then go to
step 1b — never pad the query until something matches.

### 1a. Read the route before you read the price

`find_api` and `request_access` both answer with a **`{route, reason}`** worked out
from the index's verified `billing` block and the aggregator carriage:

| `route` | What it means |
| --- | --- |
| `direct` | Go to the vendor. Either it is pay-as-you-go with no plan in the way, or its free tier verifiably covers API access — the `reason` says which, and quotes the free tier. |
| `aggregator:<name>` | Direct access needs a **monthly subscription**, and this aggregator resells the vendor per call for `per_call_price_usd`, verified at `price_verified_url`. Cheapest verified price wins; ties break by catalog order. |
| `unknown` | No billing model is recorded. Nobody checked — which is not the same as free. |

Rules for using it:

- **`billing.model: null` means nobody checked.** It never means free. Same for
  `per_call_price: null`: that aggregator publishes no comparable per-call price
  (it may price per *result* or in tiers), not that the call is free.
- When `price_unverified` is true, or the `reason` contains the words
  **`price unverified`**, say exactly that to the user. Do not fill the gap with a
  number from memory, and do not quote an aggregator's price for a vendor whose
  `price_verified_url` is `null`.
- `billing.verified_url` + `verified_date` are the receipt for the model. If the
  date is old, the `notes` say so and name `skeletonkey stale-check`; mention it
  rather than quietly trusting it.
- Every match also carries a **`freshness`** block. When `freshness.stale` is
  true, the row's `checked_date` or `billing.verified_date` is past the window
  (90 days by default), or missing on a row that claims to be real. Repeat the
  warning to the user before quoting anything off that row, and suggest
  `skeletonkey stale-check`.
- The route is a recommendation about **money**, so it never overrides a human
  gate. An `aggregator:` route still means somebody has to hold an account with
  that aggregator, and that is the user's decision, not yours.

### 1b. If `find_api` misses: discover, do not guess

A miss is not permission to invent a vendor, a header, or a price. Call
`discover_api(capability)` and follow the recipe it returns:

1. **The vendor's own API docs** → the exact header *name* and value template,
   and the base URL. Copy them verbatim.
2. **The vendor's own pricing page** → the billing model and what the free tier
   actually is, in the vendor's words. Set `billing.verified_url` to that page
   and `billing.verified_date` to today. Cannot load it? Leave `model: null`.
3. **An OpenAPI/Swagger spec**, if one exists (`/openapi.json`, `/swagger.json`,
   `/.well-known/openapi.json`) — a `securityScheme` pins the header better than
   prose does. A `404` is worth recording too.
4. **APIs.guru** (`https://api.apis.guru/v2/list.json`) — ~2,500 APIs, mostly
   large platforms. Absent there is a fact about the directory, not the vendor.
5. **Signup and key pages** → `signup_url`, and `key_page_url` only when it is
   documented; a login-gated key page stays `null` with the click-path in
   `human_steps`.
6. **The aggregator catalogs**, only if direct access needs a subscription —
   their public catalogs answer without a key.

Then call `propose_entry(...)`. What it enforces, so you do not have to remember:

- The row is written `status: unverified`, whatever you pass. **You cannot
  verify your own research.** A row becomes `verified` only when a call to its
  domain through the proxy returns `2xx` — the ledger row that did it is then
  recorded in `promoted_by`.
- Every row needs at least one URL in `source_urls`, and any price needs the URL
  it was read from. An unsourced field stays out, which makes it `null`.
- It writes to a **local user index**, never to the packaged `apis.yaml`, and a
  reviewed `apis.yaml` row always wins on a name or domain clash.

Say plainly that a discovered row is unverified when you report it. If the
vendor's docs are behind a login, a captcha, or a bot wall, leave those fields
`null` and say so — do not work around it.

### 2. No key? The human approves it, out of band

When no key exists, `request_access` does two things:

1. It asks the trusted runner to raise an **approval with the user, outside this
   conversation**: an OS notification plus a page on `127.0.0.1`. You get back
   `access_request: {request_id, status: "pending_approval"}`.
2. It returns the vendor's facts and a signup plan, so you know what is coming.

What that means for you:

- **Poll `access_status(request_id)`.** Do not ask the user to approve it here,
  do not ask them to read you anything from that page, and do not ask again and
  again — the page is theirs, on their screen.
- `needs_human` means a person has to finish a step (a captcha, a phone check, or
  simply that v0.3 ships no signup playbook for this vendor). Report the reason
  and stop. `denied` is an answer: accept it and say so.
- `ready` means a key now exists. Call `request_access` again for the proxy URL.
- When direct signup ends in a handoff and the vendor has an aggregator
  fallback, the runner raises a **second** approval. If the user approves that
  one, the runner routes the call itself through the cheapest aggregator a key is
  configured for, with that key read from the vault by the runner —
  `access_status` then reports `routed_via`, `routed_cost_usd`,
  `routed_http_status` and `routed_result` (the aggregator's own answer). If no
  aggregator key is configured, the status is `needs_human` and the reason names
  the aggregator and where the user signs up: report that and stop.
- When you no longer need it, call `cancel_request(request_id)`.

**Spend caps gate everything.** The global monthly cap and every per-vendor cap
start at **$0**, so the first paid action asks the user to set them on that same
page. `spend_policy()` shows where they stand. You can never raise one, and
asking the user to raise one in chat is not how it is done — the approval page
is the place.

**If the kill switch is engaged** (`kill_switch: true` in a tool response, or the
proxy answering `403 {"error":"kill_switch"}`), stop. Everything is refused on
purpose, and only the user clears it with `skeletonkey resume`.

### 2a. Driving a signup yourself (v0.3)

**Wait for the approval first.** Until `access_status` says `approved` (or
`needs_human` naming a step you can help with), there is nothing to drive: a
`pending_approval` means the user has not agreed to this vendor yet.

Once it is approved, and while a vendor has no runner playbook, the signup is
yours to drive using **your own** capabilities, not SkeletonKey's — and every
secret still stays out of your hands (§ "Never" below):

- Your **computer-use or browser tool** opens `signup_url` — the page where
  signup actually starts, not the docs root.
- Your **own inbox** reads the verification code and completes verification (see
  below).
- Create the API key at `key_page_url`, or in the provider's dashboard when that
  page is behind a login. **Do not copy the key into your context, a file, or the
  chat.** Leave it on screen.

Before you start: check the entry's `tos_notes` and `signup_automatable`. If
`signup_automatable` is not `true`, the terms have not been cleared for automated
signup — say so and ask the user before driving the browser. A `min_topup` of
`null` means **unknown**, not free; never state a price the entry does not
contain.

The plan also carries `human_gates`: the explicit list of steps a person has to
do, each one tagged with where the requirement came from (`apis.yaml`,
`skeletonkey-policy`, or `unknown`). Read it before you start and tell the user
which gates are coming, so nobody is surprised halfway through a signup. A gate
whose source is `unknown` means **nobody checked** — if that screen appears
(a card, an SMS code, a captcha), stop and hand over.

### 2b. Use your own inbox for verification codes

Almost every signup sends a code or a confirmation link to the address you sign
up with. That mailbox is yours to read with **your own email connector or inbox
tool** — reading a verification code is not the same as holding a credential, and
asking the user to read it to you wastes their time.

- `request_access` returns an `email_verification` block: `mailbox` (the
  dedicated SkeletonKey address from `skeletonkey init`), `address_to_use`, and
  `alias_allowed`. Sign up with `address_to_use`, then look in `mailbox`.
- Open the vendor's message, take **only** the code or the confirmation link out
  of it, and use it in the browser. Do not copy the message into a file, a
  commit, or your notes, and do not quote the whole email back into chat.
- If a magic sign-in link arrives instead of a code, follow it in the same
  browser session you started signup in.
- If the message never arrives, say so and stop. Do not try a different mailbox,
  and do not create a second account.
- If you have **no** inbox access, say that plainly and hand the verification
  step to the user — do not ask them to forward the email to you.

**`+alias` only when a personal address is accepted.** The default plan signs up
as `apis+<platform>@…` so vendor mail stays sorted. But when the entry records
`requires_work_email: true` (Apollo, for example), **do not use a `+alias` and do
not invent an address**: the vendor may refuse an aliased generic mailbox, and
which real work address to use is the user's decision, not yours. `request_access`
sets `alias_allowed: false` and makes that step a human gate — honour it.

A key SkeletonKey holds is never needed to read mail. If a vendor asks for a
phone number or shows a captcha instead of an email code, that is a human gate:
stop and hand over.

### 3. Stop for the human — twice

Hand control back, in plain words, at both of these:

- **Payment.** Any card entry, any top-up, any paid plan. The user's card, the
  user's hands. Never yours.
- **The final Terms-of-Service confirmation.** The last button that creates the
  account or commits the spend is pressed by the human, after you have shown
  them what they are agreeing to and what it costs.

Then call `register_key(alias, platform, domain)`. It asks the human to type the
key straight into the vault on their own terminal (or tells them the one
`skeletonkey add` command to run). The secret goes from their screen into the vault
without passing through you. If the tool reports `stored: false`, relay the
command it gives you and wait — do not offer to handle the key yourself.

If anything comes back saying Bitwarden is **locked, not logged in, or not
installed**, relay the steps it printed verbatim and ask the user to run
`skeletonkey bitwarden status` in their own terminal — that command prints the
`bw login` and unlock steps for their bound email, and exits non-zero until the
vault is usable. **Never ask the user for their Bitwarden master password,
never accept it if they offer it, and never run `bw login` or `bw unlock`
yourself** — unlocking a vault is a human action, and the password must never
pass through you.

### 4. Call the API through the proxy

Send the request to the proxy's URL with **no credential of your own**:

```
curl http://127.0.0.1:8787/api.apify.com/v2/acts
```

That is reverse / base-URL mode: the destination domain goes in the path. If the
tool you are using takes a base URL, point it at
`http://127.0.0.1:8787/<api-domain>` and leave its API-key field blank or set to
a dummy value — the proxy strips client-supplied auth headers and injects the
real one.

`HTTPS_PROXY` does **not** work: an HTTPS `CONNECT` tunnel is end-to-end
encrypted, so no header can be injected into it, and the proxy answers `405`
rather than pretend. Use reverse mode for HTTPS APIs. `HTTP_PROXY` works for
plain-HTTP upstreams only.

If a call returns `401`/`403`, do not retry with a key of your own. Call
`key_status(alias)` and report what you find.

### 5. Report the cost

Finish with `ledger(alias)` and tell the user what the task actually used.
`cost_usd: null` means the upstream reported no price — say "unknown", not
"free" and not a guess.

## Never

- Never ask a human to tell you, type into chat, or paste an API key.
- Never write a key to a file, a commit, an environment variable, or your own
  notes. If one ends up in your context anyway, say so immediately and
  recommend `skeletonkey disable <alias>` plus rotation at the provider.
- Never ask a human for a card number, a CVV, a password, or an OTP, and never
  accept one if it is offered. The runner's **Secure Input Popup** collects those
  on localhost, and a card number or password must never pass through you at all.
  If one lands in your context, say so at once and recommend rotating it.
- Never complete a payment or accept terms on the user's behalf.
- Never approve your own request, and never ask for a cap to be raised in this
  conversation. Approving and raising caps happen on the local approval page.
- Never re-enable a disabled key, or route around the proxy to call an API
  directly with a credential you found somewhere.
- Never state a price that is not in the index. Unknown is `null`.
- Never quote a price whose `verified_url` (or `price_verified_url`) is `null`.
  If the route says `price unverified`, pass those words on.
- Never mark your own discovery verified, and never hand-edit the index to say a
  row is verified. Only a `2xx` through the proxy earns that.
- Never guess an auth header. If `auth_header` is `null`, read the vendor's own
  auth docs before registering a key — the wrong header fails as a vendor `401`
  that looks exactly like a bad key.
- Never sign up with a `+alias` when the entry says a work email is required, and
  never pick a work address on the user's behalf.
