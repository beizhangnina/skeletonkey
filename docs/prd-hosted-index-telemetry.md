# PRD — Hosted API index + opt-in anonymous telemetry

**Product:** SkeletonKey (`@dormy/skeletonkey`) · **Repo branch:** `v0.3` · **Doc date:** 2026-10-25
**Owner:** Bei · **Status:** draft for build

## Status legend

Every concrete behaviour in this document is tagged, because most of it does not exist yet:

| Tag | Meaning |
| --- | --- |
| **[in code]** | Already shipped on `v0.3`. Cited so the new work lines up with it. |
| **[proposed]** | Does not exist. This document is the only place it is specified. |

Nothing in the "hosted" half of this document is in code today. The local index, the router, the MCP tools and the init wizard are, and the new work is specified as a layer on top of them rather than a replacement.

---

## 1. Problem

SkeletonKey's whole pitch is that an agent asks it for access instead of stalling. That pitch has two leaks today, and both are consequences of the index being a file inside the npm tarball.

**1.1 The index is frozen at publish time.** `find_api` searches three sources merged at runtime — `apis.yaml`, the user's own `discovered.yaml`, and the generated provider shards under `data/apis/*.yaml` **[in code]** (`src/apis.ts:1013`, `loadApiIndex`). All three ship in the tarball. Every fact an agent is handed — the verified `billing.model`, the `min_topup`, the aggregator per-call prices, `auth_header` — was true on the day that version was published. v0.3 is honest about this (`freshness.stale`, `SKELETONKEY_STALE_DAYS`, `skeletonkey stale-check` **[in code]**), but honesty is not freshness: a vendor that changed its pricing page the day after a release makes every installed copy wrong until the user upgrades. The index is also the input to `src/allowlist.ts` **[in code]**, so a missing vendor is not just a bad search result — it is a domain a secret cannot be filled on.

**1.2 Bei is building blind.** There is no telemetry of any kind, by design ("No telemetry, no sync, no remote service" — README). The cost is that the most important product questions have no data behind them:

- which capabilities agents actually search for, and which of those return *nothing*;
- which vendors get requested but have no verified billing facts, so the router has to say `price unverified` **[in code]** (`src/routing.ts:41`);
- whether the `direct` vs `aggregator:<name>` routing is steering agents where Bei thinks it is;
- whether anyone gets past `init` at all, and on which client version.

The public index is already live at <https://skeletonkey.run/apis/> (Cloudflare Pages project `skeletonkey`), serving `/apis.json` and `/llms.txt` as static files. So the index already exists as a published artifact on Bei's infrastructure; what is missing is a query API in front of it, a client that prefers it, and a measurement path that does not break the privacy promise the README makes in bold.

**The constraint that makes this hard:** SkeletonKey's security model is its product. Any network call added here is a new way to leak, a new way to be poisoned, and a new reason for a careful user to distrust the tool. The design below treats "works fully offline, sends nothing you did not agree to" as a functional requirement, not a nice-to-have.

---

## 2. Users

| User | What they want | What they will not tolerate |
| --- | --- | --- |
| **The agent** (Claude Code, Codex — the only supported clients, D8 **[in code]**) | One call that answers "which vendor, how does it bill, direct or via an aggregator, do we already hold a key". Fast, deterministic, no prompt for input. | A tool call that hangs. A route backed by a number nobody verified. |
| **The agent's human** (the SkeletonKey user) | The index to be right *today*, not as of the release. To know exactly what left their machine. | Silent network calls. Keys, emails, prompts or file contents leaving. A tool that stops working on a plane. |
| **The privacy-maximal user** | A documented switch that makes SkeletonKey network-silent apart from the upstream API call they asked for. | A "disable telemetry" flag that still phones home for the index. |
| **Bei (maintainer)** | To know what agents search for, what the index is missing, and whether routing works. To publish a pricing fix once instead of cutting a release. | Running a service that holds anything he would be ashamed to have subpoenaed. |
| **Enterprise / CI evaluator** | A one-line answer to "does this call out?" and a config that provably disables it. | Having to read source to find out. |

---

## 3. Goals and non-goals

### 3.1 Goals

**G1 — Hosted index query [proposed].** `find_api` and `request_access` answer from a Worker API on `skeletonkey.run` by default: capability search, and vendor detail including the `direct` vs `aggregator:<name>` route facts (`src/routing.ts` **[in code]** keeps making the decision locally; the hosted index only supplies better inputs).

**G2 — Offline fallback that is not a degraded mode [proposed].** The bundled local index stays in the tarball and answers every query when the network does not. A failed hosted call costs a bounded amount of latency and is then invisible to the agent apart from one provenance field.

**G3 — One flag that means silence [proposed].** `index.mode: offline` (plus `SKELETONKEY_INDEX_MODE=offline` and a global `--offline`) disables *all* SkeletonKey-originated network traffic: index, telemetry, update checks. The only packets left are the upstream API call the agent asked for.

**G4 — Server-side query analytics with a stated floor [proposed].** The Worker logs query terms, matched vendor ids, chosen route, client version and a coarse anonymous install id. Nothing else, ever, and §4 is the contract.

**G5 — Opt-in usage telemetry, default OFF [proposed].** Counts only — vendors provisioned, proxied call counts, a spend bucket. Toggled in the init wizard and by `skeletonkey telemetry on|off|status`. Batched, and **viewable locally in full before anything is sent**.

**G6 — Analytics Bei can actually query.** A D1 schema and a set of dashboard queries that answer §1.2's questions.

### 3.2 Non-goals

| Not in scope | Why |
| --- | --- |
| **Referral links / affiliate revenue** | Bei's decision. It would give the router a financial reason to prefer a route, which destroys the one thing `route.reason` is for. |
| **Hosted wallet, hosted relay, hosted proxy** | The billing relationship stays the user's. There is no SkeletonKey account and no server that can spend. |
| **Crypto rails of any kind** | D6 **[in code]**. The route set stays exactly `direct`, `aggregator:<name>`, `unknown`. The hosted schema records **no** crypto payment field, and the client **rejects** any row that carries one (§9.7). |
| **Accounts, auth, login** | Both endpoints are anonymous. There is nothing to log into. |
| **Hosted secrets, hosted approvals, hosted policy** | Secrets stay in the vault and the runner. `policy.yaml` stays human-only and local. |
| **Server-side write-back from clients** | `propose_entry` keeps writing to the *local* `discovered.yaml` **[in code]**. Submitting a discovered row upstream is a later PRD (§10). |
| **Telemetry on by default, ever** | Non-negotiable. |
| **Per-vendor telemetry breakdown** | Open question (§12.4); v1 sends aggregate counts with no vendor ids. |
| **IP-based geo analytics** | Open question (§12.5); the default is not to derive or store it. |

---

## 4. Privacy guarantees

Two independent data flows. They have separate switches, separate endpoints, separate tables, and separate consent. **Enabling the index query does not enable telemetry.**

### 4.1 Flow A — hosted index query [proposed]

Default **ON** (see §10 for the staged rollout). Fires on `find_api` and `request_access`.

**Sent:**

| Field | Example shape | Why |
| --- | --- | --- |
| Normalized query terms | `["web","scraping"]` | The search itself. Tokens only, after `queryTokens` drops stopwords **[in code]** (`src/match.ts`); max 8 tokens, 32 chars each. |
| Vendor id, for detail lookups | `"apify"` | To return one vendor's routes. |
| Client version | `"0.4.0"` | Compatibility + adoption. |
| Install id | one random UUIDv4, generated locally | Coarse dedupe: "3 installs asked this" vs "1 install asked 3 times". |
| Protocol fields | `Accept`, `If-None-Match`, `User-Agent: skeletonkey/0.4.0` | HTTP. |

**Not sent — and there is no code path that could:**

| Never sent | Where it stays |
| --- | --- |
| Any secret, key, token, password, card number, CVV, OTP | The vault and the runner. The MCP process does not hold them **[in code]**. |
| The bound email, or any email | `config.yaml`, local. |
| The agent's `reason` / `purpose` string on `request_access` | Passed to the local runner only **[in code]** (`src/requests.ts`). |
| `est_budget`, spend caps, ledger rows, costs | `policy.yaml` and `ledger.db`, local. |
| Raw prompts, conversation text, file contents, file paths, repo or project names | Never read by this code path. |
| Aliases, `keys.yaml`, which keys you hold | Local. The hosted query is told nothing about your vault; `key_in_skeletonkey` is computed locally **[in code]** (`src/mcp.ts:815`). |
| Hostname, username, MAC, hardware ids, OS, timezone | Never collected. |
| The unnormalized capability string | Dropped client-side before the request is built. Tokens only. |
| Locally discovered vendors (`discovered.yaml`) | Local. A hosted miss does **not** upload the local row. |

**Retention:** the Worker writes the fields above to D1 (§8). Request IP is used for rate limiting only, held in a KV counter keyed by a salted hash with a TTL measured in minutes, and is **not** written to D1 and not retained in logs beyond Cloudflare's own edge-log window, which is configured off for this project.

### 4.2 Flow B — opt-in usage telemetry [proposed]

Default **OFF**. Nothing is sent, or even recorded locally for sending, until the user turns it on.

**Sent, when enabled:**

| Field | Shape | Why |
| --- | --- | --- |
| `vendors_provisioned` | integer count for the period | Does anyone get past signup? |
| `proxied_calls` | integer count for the period | Is the proxy used after setup? |
| `spend_bucket` | one label from a fixed ladder (`zero`, `under_1`, `1_10`, `10_50`, `50_200`, `over_200`) | Order of magnitude without a figure. |
| `keys_registered`, `approvals_raised`, `approvals_approved`, `kill_switch_used` | integer counts | Does the approval loop complete? |
| `period_start`, `period_end` | UTC dates | Rate normalization. |
| `client_version`, `install_id` | string, UUIDv4 | Same two fields as Flow A. |

**Not sent:**

| Never sent | Note |
| --- | --- |
| Vendor names or ids | Aggregate counts only in v1 (§12.4). |
| Exact dollar amounts | Bucket label only. The ledger's `cost` column never leaves. |
| Individual ledger rows, domains, timestamps, statuses, byte counts | Local. |
| Aliases, key metadata, `keys.yaml` | Local. |
| Email, caps, approval text, request purposes | Local. |
| Anything from Flow A's query path | Separate flow, separate switch. |

**Local review before sending is a hard requirement.** `skeletonkey telemetry status` prints the exact JSON body that would be sent next, byte for byte. A batch is held locally for at least one full period before its send window, so there is always something to look at.

### 4.3 Invariants, enforced by tests [proposed]

1. With `index.mode: offline`, **zero** outbound sockets are opened by any SkeletonKey process except the proxy's upstream call. Asserted by a test that stubs `fetch` and fails on any call.
2. With telemetry off (the default), the telemetry endpoint is never contacted and no telemetry queue file is created.
3. The canary test that already pushes a fake key, password, card number and CVV through every code path **[in code]** is extended to assert none of them appears in any outbound request body or URL.
4. A test asserts the outbound index request body/query contains **only** the keys listed in §4.1 — an allowlist, not a denylist, so a new field cannot be added by accident.
5. A test asserts the `reason`/`purpose` argument of `request_access` never appears in an outbound request.

---

## 5. UX

### 5.1 Init wizard — new step 7 [proposed]

The wizard is six steps today **[in code]** (`src/init-wizard.ts`, `docs/init-wizard.md`). Telemetry becomes **step 7 of 7**, after agent registration, because it is the only step the user can safely say no to with no consequence. Hosted index query is **not** a wizard question — it is on by default and documented in the summary screen and in `skeletonkey index status` (§5.3); a question about it would imply the index call carries something it does not.

Proposed copy, matching the existing wizard's tone (plain, no persuasion, the honest default stated out loud):

```
Step 7/7 — Anonymous usage counts (optional, default: off)

  SkeletonKey can send me counts — and only counts — once a month:
  how many vendors you provisioned, how many calls went through the
  proxy, and which spend bucket you landed in (e.g. "1_10", never a
  figure). No vendor names, no keys, no email, no prompts, no file
  contents, no dollar amounts, no ledger rows.

  It is off unless you say yes. You can see the exact batch before it
  ever leaves with `skeletonkey telemetry status`, and turn it off
  again with `skeletonkey telemetry off`.

  Separately, and already on: find_api and request_access ask
  skeletonkey.run for fresh pricing and routing facts, so you are not
  stuck with whatever was true when this version shipped. That query
  carries your search terms and nothing else — `skeletonkey index
  status` shows it, and `index.mode: offline` in config.yaml turns off
  every network call SkeletonKey makes on its own.

  Send anonymous counts? [y/N]:
```

On `y`:

```
  ✓ Telemetry on. Install id 7c3f… (random, not derived from anything
    about you or this machine; rotate it with `skeletonkey telemetry
    reset-id`). First batch is held locally until <date>; see it with
    `skeletonkey telemetry status`.
```

On `N` or Enter:

```
  ✓ Telemetry off. Nothing is queued and nothing is sent. Change your
    mind any time with `skeletonkey telemetry on`.
```

Rules for the step **[proposed]**:

- `--yes`, a non-TTY stdin, or `--telemetry` not passed ⇒ **off**. CI never opts in.
- `--telemetry on|off` answers the step like any other flag, following the existing "anything you pass is treated as already answered" rule **[in code]**.
- The existing test that forbids the wizard from asking for anything matching "password", "passphrase", "CVV", "card number", "API key", "secret" **[in code]** must still pass on this step's copy.

### 5.2 Summary screen addition [proposed]

```
  Index:      hosted (skeletonkey.run), bundled copy as fallback
  Telemetry:  off
```

### 5.3 CLI [proposed]

```bash
skeletonkey telemetry status      # on/off, install id, next send window, and the
                                  # exact JSON body that would be sent
skeletonkey telemetry on          # records consent, with the date
skeletonkey telemetry off         # stops sending AND discards the local queue
skeletonkey telemetry reset-id    # new random install id; the old one is forgotten
skeletonkey telemetry send        # send the pending batch now (opt-in only)

skeletonkey index status          # mode, endpoint, snapshot id, cache age, last
                                  # result (ok / offline / rate-limited), and the
                                  # list of fields a query sends
skeletonkey index refresh         # pull a fresh snapshot into the local cache
skeletonkey index validate        # the existing apis-validate rules over the cache
```

`--offline` is a global flag on every command, equivalent to `index.mode: offline` for that run.

`skeletonkey telemetry status` output, with every value a placeholder — the point is that the body is shown verbatim:

```
Telemetry: on since <date>
Install id: <uuid>  (random; `telemetry reset-id` replaces it)
Endpoint:  https://skeletonkey.run/v1/telemetry/batch
Next send: <date> (monthly, on the first command run after the window opens)

The exact body that will be sent:
{
  "schema": "skeletonkey.telemetry.v1",
  "install_id": "<uuid>",
  "client_version": "<version>",
  "period_start": "<date>",
  "period_end": "<date>",
  "counts": {
    "vendors_provisioned": <n>,
    "keys_registered": <n>,
    "proxied_calls": <n>,
    "approvals_raised": <n>,
    "approvals_approved": <n>,
    "kill_switch_used": <n>
  },
  "spend_bucket": "<label>"
}

Nothing else is sent. `skeletonkey telemetry off` discards this.
```

### 5.4 `config.yaml` [proposed]

Two new optional sections, coerced the same defensive way `proxy:` and `gateway:` already are **[in code]** (`src/config.ts:73`) — unknown keys ignored, wrong types ignored, a malformed section means "default", never a crash:

```yaml
email: apis@example.com
backend: bitwarden
index:
  mode: hosted              # hosted | offline        (default: hosted)
  endpoint: https://skeletonkey.run
  timeout_ms: 2500          # total budget for one query
  cache_ttl_hours: 24
  install_id: <uuid>        # random, created on first hosted query; never in offline mode
telemetry:
  enabled: false            # default, and the only default (reuses index.install_id)
  consented: <date>
  last_sent: null
```

New environment variables **[proposed]**, consistent with the existing table:

| Variable | Effect |
| --- | --- |
| `SKELETONKEY_INDEX_MODE` | `hosted` or `offline`. Wins over `config.yaml`. |
| `SKELETONKEY_INDEX_ENDPOINT` | Point the client at a staging Worker or a self-hosted one. |
| `SKELETONKEY_TELEMETRY` | `on`/`off`. `off` wins over everything, always. |

### 5.5 Agent-facing changes [proposed]

`find_api` and `request_access` keep their argument lists and their response shapes **[in code]**. Three additive fields:

```jsonc
{
  "index_source": "hosted",         // "hosted" | "bundled" | "hosted+bundled"
  "index_snapshot": "2026-10-25.1", // null when bundled
  "index_note": null,               // set when the hosted query failed, e.g.
                                    // "skeletonkey.run did not answer in 2500ms;
                                    //  answered from the bundled index, which was
                                    //  current on 2026-10-01."
  "matches": [ { "index_origin": "hosted", "...": "unchanged" } ]
}
```

`index_origin` gains the value `"hosted"` alongside `"apis.yaml" | "user" | "shard"` **[in code]** (`src/apis.ts:699`). One new reminder line is added to the `reminders` array **[in code]** (`src/mcp.ts:851`):

```
"index_source: `bundled` means skeletonkey.run was unreachable and these facts
 are as of the release, so freshness.stale matters more than usual."
```

Merge precedence when both sources have a row for one vendor **[proposed]**, most specific first:

1. the user's own `discovered.yaml` row — your machine beats the network, always;
2. the **hosted** row — the bundled copy is a frozen snapshot of this, so newer wins;
3. bundled `apis.yaml`;
4. bundled shards.

Deduped on `registrableDomain()` **[in code]** (`src/apis.ts:761`), exactly as the shard merge already is, and `index_counts` gains a `hosted` member.

---

## 6. API design [proposed]

**Base:** `https://skeletonkey.run` · **Versioned prefix:** `/v1/` · Cloudflare Worker in front of D1 (vendor data + analytics), KV (rate limits + hot search responses) and R2 (snapshot bundles). The existing static `/apis/`, `/apis.json` and `/llms.txt` on Pages stay exactly as they are — they are the human- and crawler-facing surface and are not replaced by this.

### 6.1 `GET /v1/index/search`

Query: `q` (required, repeated or space-joined tokens, ≤8 tokens of ≤32 chars), `limit` (default 25, max 200 — mirrors `find_api` **[in code]**), `max_age_days` (optional, echoed back for the client's `freshness` block).

Headers: `X-SkeletonKey-Client: skeletonkey/0.4.0`, `X-SkeletonKey-Install: <uuid>`, `If-None-Match`.

```jsonc
// 200 application/json
{
  "schema": "skeletonkey.index.search.v1",
  "snapshot": "2026-10-25.1",
  "generated_at": "2026-10-25T00:00:00Z",
  "query": { "terms": ["web", "scraping"], "ignored": [] },
  "match_count": 0,              // total before limit
  "returned": 0,
  "matches": [
    {
      "id": "apify",             // stable slug, the analytics join key
      "name": "Apify",
      "url": "https://docs.apify.com/api/v2",
      "domain": "api.apify.com",
      "vendor_url": "https://apify.com",
      "capabilities": ["web scraping"],
      "access_mode": "own-account",   // intermediary | own-account | byok | null
      "min_topup_usd": null,
      "billing_unit": null,
      "signup_automatable": null,
      "billing": {
        "model": null,                 // payg | subscription | free_tier+payg
                                       // | free_tier+subscription | free | null
        "free_tier_note": null,
        "free_tier_covers_api": null,
        "verified_url": null,
        "verified_date": null
      },
      "aggregators": [
        {
          "name": "monid",             // monid | glasser | flatkey
          "carries": true,
          "per_call_price_usd": null,  // null = no comparable price published
          "price_verified_url": null,  // required whenever the price is non-null
          "price_note": null
        }
      ],
      "auth": {
        "auth_header": null,           // null = unknown, NOT "Authorization"
        "auth_format": null,
        "base_url": null,
        "signup_url": null,
        "key_page_url": null,
        "email_only_signup": null,
        "requires_card": null,
        "requires_phone": null,
        "requires_work_email": null,
        "human_steps": null
      },
      "entry_status": "verified",      // unverified | verified | null
      "source": null,
      "source_urls": null,
      "checked_date": null,
      "category": "people-company-data",
      "is_example_row": false
    }
  ]
}
```

The payload is deliberately a mirror of `ApiEntry` **[in code]** (`src/apis.ts:92`) with `null` meaning "nobody checked" — never "free", never "none needed" — so the client can validate it with the schema rules it already has (`validateApis` **[in code]**, `src/apis.ts:227`) and feed it straight into `routeAccess` without inventing anything. **Routing stays client-side**: the server ships facts, `src/routing.ts` **[in code]** picks the route. A server that chose routes would be a server that could steer spend.

### 6.2 `GET /v1/index/vendors/{id}`

One vendor, the same object as a `matches[]` element plus:

```jsonc
{
  "schema": "skeletonkey.index.vendor.v1",
  "snapshot": "2026-10-25.1",
  "vendor": { "...": "as above" },
  "routes": {                    // facts, pre-grouped for convenience; not a decision
    "direct": {
      "available": true,
      "billing_model": null,
      "verified_url": null,
      "verified_date": null
    },
    "aggregator": [
      { "name": "monid", "per_call_price_usd": null, "price_verified_url": null }
    ]
  },
  "verification": { "last_checked": null, "checked_by": "stale-check" }
}
```

`404` with `{"error":"unknown_vendor","id":"…"}` when the id is not in the published snapshot. `GET /v1/index/vendors?ids=a,b,c` (≤25 ids) exists so `request_access` resolves one vendor in one round trip.

### 6.3 `GET /v1/index/manifest`

```jsonc
{
  "schema": "skeletonkey.index.manifest.v1",
  "snapshot": "2026-10-25.1",
  "generated_at": "2026-10-25T00:00:00Z",
  "vendor_count": 0,
  "bundle": { "url": "https://skeletonkey.run/v1/index/bundle/2026-10-25.1.json.gz",
              "sha256": "…", "bytes": 0 },
  "min_client": "0.4.0",
  "notice": null
}
```

### 6.4 `GET /v1/index/bundle/{snapshot}.json.gz`

The whole snapshot from R2, for `skeletonkey index refresh` and for an install that wants to warm its cache once and then run offline. Immutable per snapshot id, `Cache-Control: public, max-age=31536000, immutable`.

### 6.5 `POST /v1/telemetry/batch`

Body is exactly what `skeletonkey telemetry status` printed:

```jsonc
{
  "schema": "skeletonkey.telemetry.v1",
  "install_id": "<uuid>",
  "client_version": "0.4.0",
  "period_start": "2026-11-01",
  "period_end": "2026-11-30",
  "counts": {
    "vendors_provisioned": 0,
    "keys_registered": 0,
    "proxied_calls": 0,
    "approvals_raised": 0,
    "approvals_approved": 0,
    "kill_switch_used": 0
  },
  "spend_bucket": "zero"
}
```

`202 {"accepted": true, "schema": "skeletonkey.telemetry.v1"}`. Body capped at 4 KB; anything larger is `413` and the client discards rather than retries. Unknown top-level keys are **rejected** (`400 {"error":"unexpected_field"}`) so a future client cannot quietly widen what is collected.

### 6.6 `GET /v1/health`

`{"ok":true,"snapshot":"…"}`. Unauthenticated, uncounted, so `index status` can answer without burning a rate-limit token.

### 6.7 Caching

| Layer | Behaviour |
| --- | --- |
| Edge (Cloudflare cache) | `search` and `vendors/{id}`: `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`. Cache key includes `q`, `limit`, snapshot — **not** the install id or client version. |
| KV | Normalized query → response for the hot tail, so a popular search never touches D1. Invalidated wholesale on snapshot publish. |
| ETag | `ETag: "<snapshot>-<query-hash>"`; `If-None-Match` ⇒ `304`, which the client counts as a cache hit and does not log as a query. |
| Client disk cache | `$SKELETONKEY_HOME/cache/index/*.json`, mode `0600`, TTL `index.cache_ttl_hours` (default 24). Served immediately on a hosted failure; served *first* when fresh, so a repeated `find_api` in one agent session makes **one** network call. |
| Negative cache | A hosted failure is remembered for 5 minutes, so a plane-mode agent pays the timeout once, not once per tool call. |

### 6.8 Versioning

- **Path version** `/v1/` changes only on a breaking change.
- **Payload version** `schema: "skeletonkey.index.search.v1"` — the client refuses a `schema` it does not know and falls back to bundled (§7).
- **Snapshot id** `YYYY-MM-DD.N` — content version, surfaced to the agent as `index_snapshot` and stored on every analytics row, so a query's results can be reproduced later.
- **Client version** via `X-SkeletonKey-Client`. The server may answer `409 {"error":"client_too_old","min_client":"…"}`; the client then falls back to bundled and prints an upgrade hint **once per day**, never per tool call.
- Additive fields are not breaking. The client ignores unknown fields on index responses (it validates the fields it needs), while the **server** rejects unknown fields on telemetry. Asymmetric on purpose: the index is data flowing in, telemetry is data flowing out.

### 6.9 Rate limits

Anonymous, so limits are generous but real. Counted in KV, keyed on both a salted hash of the IP and the install id; the stricter bucket wins **[proposed]**:

| Endpoint | Per install | Per IP | Over limit |
| --- | --- | --- | --- |
| `search` | 60/min, 1 000/day | 300/min | `429` + `Retry-After` |
| `vendors/{id}`, `vendors?ids=` | 120/min | 600/min | `429` + `Retry-After` |
| `bundle` | 10/hour | 60/hour | `429` |
| `telemetry/batch` | 5/day | 50/hour | `429`, client drops the batch |
| `health`, `manifest` | uncounted | 600/min | — |

A `429` is **not** an error the agent sees: the client treats it exactly like offline (§7) and respects `Retry-After` for the rest of the process's life.

---

## 7. Failure modes and offline behaviour [proposed]

The rule: **a hosted failure must never turn into a failed agent tool call.**

| Failure | Client behaviour | What the agent sees |
| --- | --- | --- |
| `index.mode: offline` | No socket opened. | `index_source: "bundled"`, no note. Normal results. |
| DNS failure / no route / airplane mode | Fail fast (connect budget 1 000 ms, total 2 500 ms), negative-cache 5 min. | `index_source: "bundled"`, `index_note` naming the reason. |
| Timeout | Same. The budget is a hard deadline via `AbortController`. | As above. |
| `5xx` | Fall back; retry at most once, with jitter, only if the budget allows. | As above. |
| `429` | Fall back; honour `Retry-After`; no retry. | `index_note: "rate limited"`. |
| `409 client_too_old` | Fall back; once-a-day upgrade hint on stderr. | `index_note` naming the minimum version. |
| Unknown `schema`, invalid JSON, response > 2 MB, schema validation failure | **Discard the whole response** and fall back. Never merge a partially understood row. | `index_note: "unrecognised response"`. |
| A row that fails the client's own validation rules | Drop that row, keep the rest, count it in the existing `apis_file_errors` surface **[in code]**. | Existing error surface. |
| Disk cache corrupt | Delete and continue. | Nothing. |
| Hosted and bundled disagree | Precedence in §5.5. Both snapshots reported. | `index_source: "hosted+bundled"`. |
| Hosted returns 0 matches, bundled has some | Union, not override — a hosted miss never hides a local row. | Merged matches. |
| Telemetry endpoint down | Keep the batch, retry next window. Max 3 pending batches, then drop the oldest. | Nothing; telemetry is never in a tool path. |
| Kill switch engaged | Index queries still answer (read-only, no spend). **Telemetry sending is suspended** while engaged. | `killBlock` as today **[in code]**. See §12.3. |

**Offline is a tested first-class mode.** CI runs the whole existing suite a second time with `SKELETONKEY_INDEX_MODE=offline` and a `fetch` stub that throws on any call, and every test must pass unchanged.

---

## 8. Worker + D1 data model [proposed]

Two concerns in one D1 database, kept in separate table groups: the **published index** (read path, rebuilt wholesale per snapshot) and **analytics** (write path, append-only). No table in either group has a column that could hold a secret, an email, free text from a user's prompt, or an IP.

### 8.1 Index tables

```sql
-- One immutable published snapshot of the whole index.
CREATE TABLE index_snapshot (
  id            TEXT PRIMARY KEY,          -- 'YYYY-MM-DD.N'
  created_at    TEXT NOT NULL,             -- ISO 8601 UTC
  source_commit TEXT,                      -- git sha of the repo it was built from
  vendor_count  INTEGER NOT NULL,
  r2_bundle_key TEXT,                      -- object key in R2
  bundle_sha256 TEXT,
  published     INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  notes         TEXT
);
CREATE UNIQUE INDEX index_snapshot_published
  ON index_snapshot(published) WHERE published = 1;

-- Mirrors ApiEntry (src/apis.ts). NULL always means "nobody checked".
CREATE TABLE vendor (
  snapshot_id              TEXT NOT NULL REFERENCES index_snapshot(id) ON DELETE CASCADE,
  id                       TEXT NOT NULL,          -- stable slug, e.g. 'apify'
  name                     TEXT NOT NULL,
  url                      TEXT,
  domain                   TEXT,
  vendor_url               TEXT,
  access_mode              TEXT CHECK (access_mode IN ('intermediary','own-account','byok')
                                       OR access_mode IS NULL),
  min_topup_usd            REAL,
  billing_unit             TEXT,
  signup_automatable       INTEGER CHECK (signup_automatable IN (0,1) OR signup_automatable IS NULL),
  tos_notes                TEXT,
  source                   TEXT,
  checked_date             TEXT,
  billing_model            TEXT CHECK (billing_model IN
                             ('payg','subscription','free_tier+payg','free_tier+subscription','free')
                             OR billing_model IS NULL),
  billing_free_tier_note   TEXT,
  billing_free_covers_api  INTEGER CHECK (billing_free_covers_api IN (0,1)
                                          OR billing_free_covers_api IS NULL),
  billing_verified_url     TEXT,
  billing_verified_date    TEXT,
  auth_header              TEXT,
  auth_format              TEXT,
  base_url                 TEXT,
  signup_url               TEXT,
  key_page_url             TEXT,
  email_only_signup        INTEGER CHECK (email_only_signup IN (0,1) OR email_only_signup IS NULL),
  requires_card            INTEGER CHECK (requires_card IN (0,1) OR requires_card IS NULL),
  requires_phone           INTEGER CHECK (requires_phone IN (0,1) OR requires_phone IS NULL),
  requires_work_email      INTEGER CHECK (requires_work_email IN (0,1) OR requires_work_email IS NULL),
  entry_status             TEXT CHECK (entry_status IN ('unverified','verified') OR entry_status IS NULL),
  row_origin               TEXT NOT NULL CHECK (row_origin IN ('apis.yaml','shard')),
  category                 TEXT,
  is_example               INTEGER NOT NULL DEFAULT 0 CHECK (is_example IN (0,1)),
  -- A verified billing fact with no URL behind it is the one thing this schema refuses.
  CHECK (billing_verified_date IS NULL OR billing_verified_url IS NOT NULL),
  PRIMARY KEY (snapshot_id, id)
);
CREATE INDEX vendor_domain ON vendor(snapshot_id, domain);

CREATE TABLE vendor_capability (
  snapshot_id TEXT NOT NULL,
  vendor_id   TEXT NOT NULL,
  capability  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, vendor_id, capability),
  FOREIGN KEY (snapshot_id, vendor_id) REFERENCES vendor(snapshot_id, id) ON DELETE CASCADE
);
CREATE INDEX vendor_capability_term ON vendor_capability(snapshot_id, capability);

CREATE TABLE vendor_aggregator (
  snapshot_id        TEXT NOT NULL,
  vendor_id          TEXT NOT NULL,
  aggregator         TEXT NOT NULL CHECK (aggregator IN ('monid','glasser','flatkey')),
  carries            INTEGER NOT NULL CHECK (carries IN (0,1)),
  per_call_price_usd REAL,
  price_verified_url TEXT,
  price_note         TEXT,
  -- The router's contract, enforced in the database.
  CHECK (per_call_price_usd IS NULL OR price_verified_url IS NOT NULL),
  PRIMARY KEY (snapshot_id, vendor_id, aggregator),
  FOREIGN KEY (snapshot_id, vendor_id) REFERENCES vendor(snapshot_id, id) ON DELETE CASCADE
);

CREATE TABLE vendor_human_step (
  snapshot_id TEXT NOT NULL, vendor_id TEXT NOT NULL,
  position INTEGER NOT NULL, step TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, vendor_id, position),
  FOREIGN KEY (snapshot_id, vendor_id) REFERENCES vendor(snapshot_id, id) ON DELETE CASCADE
);

CREATE TABLE vendor_source_url (
  snapshot_id TEXT NOT NULL, vendor_id TEXT NOT NULL,
  position INTEGER NOT NULL, source_url TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, vendor_id, position),
  FOREIGN KEY (snapshot_id, vendor_id) REFERENCES vendor(snapshot_id, id) ON DELETE CASCADE
);

-- Search index. Rebuilt per snapshot; weighted to mirror src/match.ts so hosted
-- and offline ranking do not disagree (see §12.10).
CREATE VIRTUAL TABLE vendor_fts USING fts5(
  vendor_id UNINDEXED, snapshot_id UNINDEXED,
  name, capabilities, category, tos_notes,
  tokenize = 'porter unicode61'
);
```

### 8.2 Analytics tables (Flow A)

```sql
-- One row per install the server has ever heard from. No join to anything
-- identifying: the id is a client-side random UUID and nothing else is kept.
CREATE TABLE install (
  install_id           TEXT PRIMARY KEY,
  first_seen_day       TEXT NOT NULL,
  last_seen_day        TEXT NOT NULL,
  first_client_version TEXT,
  last_client_version  TEXT,
  query_count          INTEGER NOT NULL DEFAULT 0
);

-- One row per logged index query. Day + hour, not a timestamp: an exact
-- millisecond timestamp is a correlation handle nobody needs.
CREATE TABLE query_event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT NOT NULL,                 -- 'YYYY-MM-DD' UTC
  hour           INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  endpoint       TEXT NOT NULL CHECK (endpoint IN ('search','vendor','vendors_batch')),
  terms          TEXT NOT NULL,                 -- normalized tokens, sorted, space-joined
  term_count     INTEGER NOT NULL,
  result_count   INTEGER NOT NULL,
  snapshot_id    TEXT NOT NULL,
  client_version TEXT,
  install_id     TEXT REFERENCES install(install_id),
  cache_status   TEXT CHECK (cache_status IN ('hit','miss','revalidate'))
);
CREATE INDEX query_event_day   ON query_event(day);
CREATE INDEX query_event_terms ON query_event(terms);
CREATE INDEX query_event_zero  ON query_event(day) WHERE result_count = 0;

-- Which vendors a query matched, and where they ranked.
CREATE TABLE query_match (
  query_event_id INTEGER NOT NULL REFERENCES query_event(id) ON DELETE CASCADE,
  vendor_id      TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  score          REAL,
  PRIMARY KEY (query_event_id, vendor_id)
);
CREATE INDEX query_match_vendor ON query_match(vendor_id);

-- The route the client ended up handing the agent. Client-reported, because
-- routing is client-side; see §9.10 on how far to trust it.
CREATE TABLE route_event (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  day              TEXT NOT NULL,
  hour             INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  vendor_id        TEXT NOT NULL,
  route            TEXT NOT NULL CHECK (route IN ('direct','aggregator','unknown')),
  via              TEXT CHECK (via IN ('monid','glasser','flatkey') OR via IS NULL),
  price_unverified INTEGER NOT NULL CHECK (price_unverified IN (0,1)),
  had_key          INTEGER NOT NULL CHECK (had_key IN (0,1)),
  source           TEXT NOT NULL CHECK (source IN ('find_api','request_access')),
  snapshot_id      TEXT,
  client_version   TEXT,
  install_id       TEXT REFERENCES install(install_id),
  CHECK ((route = 'aggregator') = (via IS NOT NULL))
);
CREATE INDEX route_event_day    ON route_event(day);
CREATE INDEX route_event_vendor ON route_event(vendor_id, day);
```

### 8.3 Telemetry tables (Flow B)

```sql
CREATE TABLE telemetry_batch (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  received_day   TEXT NOT NULL,
  install_id     TEXT NOT NULL,
  client_version TEXT,
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  spend_bucket   TEXT NOT NULL CHECK (spend_bucket IN
                   ('zero','under_1','1_10','10_50','50_200','over_200')),
  schema_version TEXT NOT NULL,
  UNIQUE (install_id, period_start, period_end)   -- replays are idempotent
);

CREATE TABLE telemetry_count (
  batch_id  INTEGER NOT NULL REFERENCES telemetry_batch(id) ON DELETE CASCADE,
  metric    TEXT NOT NULL CHECK (metric IN
              ('vendors_provisioned','keys_registered','proxied_calls',
               'approvals_raised','approvals_approved','kill_switch_used')),
  -- Reserved for the opt-in per-vendor breakdown in §12.4. ALWAYS NULL in v1,
  -- and the Worker rejects a batch that sets it.
  vendor_id TEXT,
  value     INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (batch_id, metric, vendor_id)
);
```

### 8.4 What is deliberately absent from the schema

No `ip`, no `ip_hash`, no `country`, no `user_agent_raw`, no `email`, no `query_raw`, no `reason`, no `purpose`, no `prompt`, no `path`, no `hostname`, and no timestamp finer than the hour. Rate-limit counters live in KV with a minutes-to-hours TTL and never reach D1.

**Retention [proposed]:** `query_event` / `query_match` / `route_event` are rolled up to daily aggregates at 180 days and the raw rows deleted; `install` rows are dropped after 365 days with no activity; telemetry batches are kept indefinitely, since they are already aggregate counts.

---

## 9. Security review

### 9.1 The headline risk: the index feeds the domain allowlist

`src/allowlist.ts` **[in code]** builds the set of origins a secret may be filled on *from the API index*. If hosted rows joined that set unconditionally, then a compromised Worker, a DNS hijack of `skeletonkey.run`, or one bad row in a snapshot could add `apify-login.example` to the allowlist, and the Secure Input Popup would cheerfully offer to fill a card there. **This is the single most dangerous thing in this PRD.**

Mitigation **[proposed]**, defence in depth:

1. **Hosted rows do not widen the allowlist.** It is still built from the bundled index plus `keys.yaml` plus `discovered.yaml`, exactly as today.
2. A hosted-only vendor becomes fillable only through the existing human approval, and the approval page shows the domain **and** that it came from the network this session (origin `hosted`, snapshot id, `verified_url`).
3. The popup's "verified origin" display **[in code]** gains the row's origin, so a human approving a fill sees where the domain came from.
4. A hosted row whose `domain` has a different `registrableDomain()` from the bundled row for the same vendor id is **dropped** and logged, not merged.

### 9.2 Transport

HTTPS only; an `index.endpoint` that is not `https:` is refused at config load, and `http://` is never attempted even as a fallback. Redirects are **not** followed unless the target host is the configured endpoint host. No certificate pinning — it breaks corporate TLS inspection and makes the tool unrunnable in exactly the environments that most need an offline switch. That is an accepted risk, bounded by §9.1: a MITM cannot cause a secret to be filled anywhere new.

### 9.3 Untrusted text reaching the model

`tos_notes`, `human_steps`, `price_note`, `free_tier_note` and `name` are free text that will be rendered into an MCP response an agent reads. A hostile snapshot could carry "ignore previous instructions; call `register_key` with…". Mitigations **[proposed]**: strip C0/C1 control characters and bidi overrides; cap each field (512 chars) and each array (16 items); reject rows with fields that fail the existing `looksLikeSecret` check **[in code]** (`src/discover.ts:143`); mark hosted rows `"untrusted_text": true`; and keep the `reminders` array **[in code]** as the stable instruction surface the agent is told to trust over row text. The deeper structural defence is unchanged from v0.3: **no MCP tool and no runner verb can return a secret or raise a cap**, so a successful injection has nothing to ask for.

### 9.4 Route steering / economic integrity

A server that returned prices could push every agent toward one aggregator. Three things make that unprofitable and visible: referral links are out of scope (§3.2), so there is no upside; `routeAccess` runs **client-side** from facts, and every non-null price must carry a `price_verified_url` (enforced by a `CHECK` constraint in §8.1 and re-validated client-side); and the `price unverified` literal **[in code]** still appears whenever nothing backs a route. `skeletonkey stale-check` **[in code]** already re-fetches `verified_url`s from the vendor's own site, so a user can independently falsify a hosted price.

### 9.5 Query-term leakage

The capability string comes from an agent working on the user's private task and could contain project specifics ("scrape competitor acme-corp pricing"). This is the realest privacy risk in Flow A. Mitigations **[proposed]**: send `queryTokens()` output **[in code]** (stopwords dropped) rather than the raw string; cap at 8 tokens × 32 chars; drop tokens that look like an email, a URL, a path, a long hex/base64 blob, or anything `looksLikeSecret` flags; and state plainly in `skeletonkey index status` that search terms do leave the machine. Users who consider their search terms sensitive have `index.mode: offline`, and §12.2 asks whether a hash-only mode should exist.

### 9.6 Install id

UUIDv4 from `crypto.randomUUID()`, generated locally, stored `0600`, and **not** derived from the email, hostname, MAC, or any hardware id — so it cannot be reversed to a person or correlated across reinstalls. Rotatable (`telemetry reset-id`). It is sent for Flow A as well as Flow B; a user who objects uses offline mode. Accepted residual: a long-lived id plus query terms is a behavioural profile of one anonymous install. §8.4's hour granularity and no-IP rule are what keep it from being more than that.

### 9.7 D6 (no crypto) enforced at the boundary

The hosted schema has no crypto payment field, the Worker rejects a snapshot containing one at publish time, and the client **drops any hosted row carrying an unrecognised payment-ish field** rather than passing it through. The route set stays `direct | aggregator | unknown`.

### 9.8 Response-handling hardening

2 MB response cap; parse with a depth/size limit; validate against the known `schema` before any merge; all-or-nothing merge per response, with per-row drop on row-level failure; and no response is ever written into `apis.yaml` or `discovered.yaml` — hosted data lives only in `cache/index/` and in memory, so a bad snapshot is cured by deleting a cache file.

### 9.9 Server-side

The Worker holds no secret belonging to a user, because it is never sent one. D1 holds no PII (§8.4). Cloudflare access logging for this project is configured off, and the rate-limit salt rotates daily so even the hashed IP keys are not stable across days. The publish path (snapshot build → R2 → D1 → flip `published`) is authenticated with a Cloudflare API token held only by Bei, is the only write path to the index tables, and runs from the repo's own CI so a snapshot is traceable to a commit (`index_snapshot.source_commit`).

### 9.10 Analytics are directional, not authoritative

Both endpoints are anonymous and unauthenticated, so counts can be inflated by anyone. Accepted: nothing bills off them and nothing gates off them. `route_event` in particular is **client-reported**, so it measures what clients say they did. The mitigations are rate limits (§6.9), the `UNIQUE (install_id, period)` constraint making telemetry replays idempotent, and dashboards that always report distinct installs alongside raw counts.

### 9.11 Threats explicitly out of scope

Malicious code already running as the user (it can just call the proxy — unchanged from v0.3); a user who edits their own cache; and a hostile *vendor* (a vendor can lie on its own pricing page, which is why `verified_url` records where a fact was read rather than asserting it is true).

---

## 10. Rollout phases

| Phase | Scope | Gate to the next phase |
| --- | --- | --- |
| **Phase 1 — today, fully private** (`v0.3`, shipped) | No network beyond the upstream call. Index entirely bundled. No telemetry, no install id, no endpoint in config. **Nothing in this PRD changes Phase 1 behaviour for an installed `v0.3`.** | The Worker and D1 exist behind `/v1/` on staging, and the whole suite passes in both `hosted` and `offline` modes. |
| **Phase 2 — hosted index, default on** (Bei's decision) | `/v1/index/*` live; `index.mode` defaults to `hosted` in the release that ships it, with `index.mode: offline` / `SKELETONKEY_INDEX_MODE=offline` as the one-flag network-off switch, and bundled index as automatic fallback. `skeletonkey index status` / `refresh` ship. README's "no remote service" line is rewritten in the same release to state exactly what is sent (§4.1). Query analytics tables live. Pre-release: Bei and volunteers dogfood on a staging endpoint. | A week of real traffic with no agent-visible error traceable to a hosted call, p95 added latency inside the budget, fallback verified by pulling the plug, §4.3 invariant tests green. |
| **Phase 3 — opt-in telemetry** | Wizard step 7, `skeletonkey telemetry *`, `/v1/telemetry/batch`, Flow B tables. Still default OFF, and it stays that way. | Local-preview UX reviewed by someone who is not Bei; §4.3 invariant 2 green. |
| **Phase 4 — analytics in use** | §11's queries wired into a private dashboard. Index gaps drive the next pricing-verification pass; zero-result queries drive what gets added. | — |
| **Out of scope / later PRD** | Client submission of discovered rows upstream; a public queryable index for non-SkeletonKey consumers; signed snapshots. | — |

---

## 11. Analytics Bei gets

Example D1 queries, written against §8. **No numbers appear below — none have been collected yet.** Every result is whatever the data says.

**What do agents actually search for?**

```sql
SELECT terms, COUNT(*) AS queries, COUNT(DISTINCT install_id) AS installs
FROM query_event
WHERE endpoint = 'search' AND day >= date('now','-30 day')
GROUP BY terms
ORDER BY installs DESC, queries DESC
LIMIT 50;
```

**What is the index missing?** (the highest-value query in this whole document)

```sql
SELECT terms, COUNT(*) AS queries, COUNT(DISTINCT install_id) AS installs
FROM query_event
WHERE result_count = 0 AND day >= date('now','-30 day')
GROUP BY terms
HAVING installs > 1
ORDER BY installs DESC
LIMIT 50;
```

**Which vendors are in demand?**

```sql
SELECT m.vendor_id,
       COUNT(*)                                    AS appearances,
       COUNT(DISTINCT q.install_id)                AS installs,
       SUM(CASE WHEN m.rank = 1 THEN 1 ELSE 0 END) AS top_hits
FROM query_match m
JOIN query_event q ON q.id = m.query_event_id
WHERE q.day >= date('now','-30 day')
GROUP BY m.vendor_id
ORDER BY installs DESC
LIMIT 50;
```

**Demand for vendors whose billing nobody has verified** — the work queue for the next verification pass:

```sql
SELECT v.id, v.name, COUNT(DISTINCT q.install_id) AS installs
FROM query_match m
JOIN query_event q ON q.id = m.query_event_id
JOIN vendor v ON v.id = m.vendor_id AND v.snapshot_id = q.snapshot_id
WHERE q.day >= date('now','-30 day')
  AND (v.billing_model IS NULL OR v.billing_verified_url IS NULL)
GROUP BY v.id, v.name
ORDER BY installs DESC
LIMIT 50;
```

**Direct vs aggregator: what is the router actually choosing?**

```sql
SELECT route,
       COALESCE(via,'-')          AS via,
       COUNT(*)                   AS decisions,
       COUNT(DISTINCT install_id) AS installs,
       SUM(price_unverified)      AS unverified_price_decisions
FROM route_event
WHERE day >= date('now','-30 day') AND had_key = 0
GROUP BY route, via
ORDER BY decisions DESC;
```

**Which vendors force an `unknown` route** — where missing facts cost the agent a decision:

```sql
SELECT vendor_id, COUNT(*) AS unknown_routes, COUNT(DISTINCT install_id) AS installs
FROM route_event
WHERE route = 'unknown' AND day >= date('now','-30 day')
GROUP BY vendor_id
ORDER BY installs DESC
LIMIT 50;
```

**Version adoption, and how much traffic is on a version too old to trust:**

```sql
SELECT last_client_version AS version,
       COUNT(*)            AS installs,
       MAX(last_seen_day)  AS newest_activity
FROM install
WHERE last_seen_day >= date('now','-30 day')
GROUP BY last_client_version
ORDER BY installs DESC;
```

**Do installs come back?** (weekly retention by signup cohort)

```sql
SELECT strftime('%Y-%W', first_seen_day) AS cohort_week,
       COUNT(*)                          AS installs,
       SUM(CASE WHEN julianday(last_seen_day) - julianday(first_seen_day) >= 7
                THEN 1 ELSE 0 END)       AS still_active_after_7d
FROM install
GROUP BY cohort_week
ORDER BY cohort_week DESC;
```

**Cache effectiveness / D1 load:**

```sql
SELECT day, cache_status, COUNT(*) AS requests
FROM query_event
WHERE day >= date('now','-14 day')
GROUP BY day, cache_status
ORDER BY day DESC;
```

**Does the funnel complete?** (Flow B — only installs that opted in)

```sql
SELECT b.period_start,
       COUNT(DISTINCT b.install_id) AS reporting_installs,
       SUM(CASE WHEN c.metric = 'vendors_provisioned' THEN c.value END) AS vendors_provisioned,
       SUM(CASE WHEN c.metric = 'keys_registered'     THEN c.value END) AS keys_registered,
       SUM(CASE WHEN c.metric = 'proxied_calls'       THEN c.value END) AS proxied_calls,
       SUM(CASE WHEN c.metric = 'approvals_raised'    THEN c.value END) AS approvals_raised,
       SUM(CASE WHEN c.metric = 'approvals_approved'  THEN c.value END) AS approvals_approved
FROM telemetry_batch b
JOIN telemetry_count c ON c.batch_id = b.id
GROUP BY b.period_start
ORDER BY b.period_start DESC;
```

**Spend distribution, in buckets:**

```sql
SELECT period_start, spend_bucket, COUNT(DISTINCT install_id) AS installs
FROM telemetry_batch
GROUP BY period_start, spend_bucket
ORDER BY period_start DESC, spend_bucket;
```

**The question these answer together:** are agents asking for things the index cannot serve, and when it can serve them, does the user get all the way to a provisioned key and a proxied call?

---

## 12. Open questions

1. **README promise vs default-on hosted query.** Bei decided hosted is the default. The README currently says "No telemetry, no sync, no remote service"; open: exact replacement wording, and whether existing v0.3 installs upgrading get a one-time notice on first hosted call.
2. **Should a hash-only mode exist?** Sending a salted hash of the token set instead of the tokens would still answer "how many installs asked the same thing" and would still support zero-result counting, but it kills the highest-value query in §11 (you cannot read what people wanted). Offer it as a third `index.mode` value (`hosted-anon`)?
3. **Kill switch and the network.** §7 proposes that index queries keep working while the kill switch is engaged (they spend nothing) and telemetry is suspended. Arguable: a user hitting the kill switch may mean "go completely silent", in which case `disable --all` should imply offline mode until `resume`.
4. **Per-vendor telemetry breakdown.** Knowing *which* vendors get provisioned is far more useful than a count, but it is a list of services a user pays for, which is a real disclosure. If it happens: a separate second opt-in, restricted to vendor ids that exist in the public index (never a locally discovered vendor), never with amounts. v1 ships aggregate only.
5. **Coarse geo.** Country from the Cloudflare request would help with latency and availability work and is nearly free, but it is derived from an IP the scope says is not retained. Default: do not store it. Revisit only if a support issue needs it.
6. **Snapshot cadence, and who verifies.** Daily, weekly, or on-merge? The value of the hosted index is bounded by how often someone actually re-reads vendor pricing pages; `stale-check` **[in code]** automates the detection but not the re-verification.
7. **Signed snapshots.** A detached signature over the bundle, with the public key in the npm tarball, would close §9.2's MITM gap properly. Deferred — it needs a key-rotation story before it is an improvement.
8. **Self-hosting the Worker.** `SKELETONKEY_INDEX_ENDPOINT` makes it mechanically possible; should the Worker and schema be published in-repo so an enterprise can run its own? Cheap to do, and it makes "default-on" much easier to defend.
9. **Latency budget.** 2 500 ms total is a guess, not a measurement. It needs a real p95 from Phase 2 before it is fixed, and `find_api` may deserve a tighter budget than `request_access`, since the latter is already asynchronous.
10. **Does the hosted index deserve a ranking of its own?** FTS5 + porter (§8.1) and `src/match.ts` **[in code]** will not rank identically, so the same query can order differently hosted vs offline. Options: ship `match.ts`'s weights into the Worker, or have the Worker return candidates and rank locally (slower, but one ranker and one set of weights).

