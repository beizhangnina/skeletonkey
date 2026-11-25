# SkeletonKey API index — three aggregator catalogs

An index of the tools/APIs listed by three agent-tool aggregators — **Glasser**
(glasser.ai), **Monid** (monid.ai) and **Flatkey** (flatkey.ai) — reduced to the
**underlying provider** as the unit of record.

The point of the index is *existence* and *how to reach the vendor directly*.
It deliberately does **not** reproduce the aggregators' own descriptions, prices
or markups. Every `capability` line is our own one-sentence summary; prices and
free tiers are left `null` because they were not verified against the vendor's
own pricing page.

Scrape date / `checked_date` on every entry: **2026-10-24**.

## Layout

Vendor-direct additions that were not observed in these aggregator scrapes belong
in root `apis.yaml`. NVIDIA API Catalog / NIM (`nvidia-nim`) is recorded there
with vendor-documented LLM auth and offerings/free-access notes checked on
2026-10-28. It is not added to `llm-models.yaml`: shard `seen_in` must name at least
one of the three aggregators, and `build.py` rejects curated providers without
raw records. Root entries are loaded alongside the generated shards and survive
regeneration; the counts below describe only the aggregator shards.

```
data/apis/
  <category>.yaml        26 shards, top-level key `apis:` (one list per category)
  README.md              this file
  scripts/validate.py    schema validator (exit 0 = pass)
  scripts/build.py       regenerates the shards from raw/
  scripts/curated.py     hand-written per-provider facts used by build.py
  raw/                   cached scrape artifacts -- NOT in the repo, see below
```

`raw/` is listed in the root `.gitignore` and is not committed: it holds
verbatim third-party catalog captures (45 files, ~8 MB) that `scripts/build.py`
reads but nothing in the repo ships. To run `scripts/build.py`, place a `raw/`
directory with those captures under `data/apis/` yourself; without it, every
other file here -- the committed shards, `validate.py`, `curated.py` -- works
as normal.

Validate with:

```
python3 data/apis/scripts/validate.py
# shards: 26   entries: 162   unique ids: 162
# OK: all entries valid
```

`validate.py` uses PyYAML when importable and falls back to a small
indentation-driven reader for the YAML subset these shards use — nested
mappings, block and inline lists, quoted and bare scalars, and folded/literal
block scalars — so it runs on a bare interpreter too. (The original fallback
understood only one flat level of keys, which the nested `offering:` block
below would have broken.) Anchors, aliases, multi-document streams and flow
mappings are outside the subset and absent from these files.

## The optional `offering` block

Every row may carry one `offering:` mapping describing **what the vendor
offers**. It is optional and every field inside it is null-when-unknown, so the
162 rows generated before it existed validate unchanged.

Layer 1 — `summary` (one line, ≤ 200 chars), `categories` (≤ 12, from a closed
list of 30), `endpoint_count` / `model_count` (approximate, and only a number
the vendor itself states), `count_note`, `free_tier`
(`available` / `what` / `limits` / `requires_key` / `requires_account`),
`connect` (`base_url` / `auth` / `auth_header` / `auth_format`), `catalog_url`
(the **vendor's own** catalog page), `verified_url` + `verified_date`, and
`source_urls`.

Layer 2 — `highlights`, at most **15** rows of
`{id, kind: model|endpoint, free, note, url}`: a sample of the free or notable
models/endpoints, never a full catalog. An agent that needs the whole list
fetches `catalog_url` live.

The rules, enforced identically here and by `skeletonkey apis validate` (see
`src/apis.ts`, and the drift test in `test/offering.test.ts`): a free tier that
claims to exist must say *what* is free; `verified_url` and `verified_date` are
required together; `connect.auth: none` is a fact and may not sit beside an
`auth_header` (`null` is "nobody checked"); `summary` is one line;
`categories` come from the closed list; `highlights` is capped and may not be an
empty list.

`access_mode` also accepts **`keyless`** (the vendor documents no credential at
all) and **`wallet-x402`** (the only documented way to pay is a crypto wallet —
recorded as a fact; SkeletonKey itself pays in fiat only), beside the original
`intermediary` / `own-account` / `byok` / `unknown`.

**No shard row carries an `offering` block yet, and `build.py` does not emit
one.** The three aggregator catalogs do not publish Layer 1 facts about the
underlying vendor, and copying their descriptions would describe the aggregator
(see the note at the top of this file). Vendor-direct offerings therefore live
in root `apis.yaml`; the schema exists here so a future, vendor-sourced shard
can carry one without a schema change.

## The structured core fields (ND-8)

Five more optional fields, independent of `offering` above and validated the
same way by both `validate.py` and `src/apis.ts` (and checked for drift by
`test/structured-fields.test.ts`):

- **`official_docs_url`** -- http(s) URL or null. The vendor's **own** official
  API documentation, never an aggregator's page. `null` = not verified.
- **`auth`** -- null, or `{type, header, format, docs_url}`. `type` is one of
  `api_key | bearer | oauth2 | basic | none | other | unknown` and is required
  whenever the block exists. `header`/`format` must be null when `type` is
  `none` (nothing to name), and `format` is a placeholder TEMPLATE such as
  `"Bearer <API_KEY>"` that must contain a `<...>` placeholder -- never a real
  secret.
- **`pricing`** -- null, or `{model, free_tier, starting_price_usd, unit,
  pricing_url, notes}`. `model` is one of `free | freemium | pay_as_you_go |
  subscription | prepaid_credits | contact_sales | unknown`, or null.
  `starting_price_usd` is never guessed.
- **`endpoints`** -- null, or a list of at most 50 `{method, path, summary,
  returns, docs_url}` rows. `null` means not verified yet; `[]` means verified
  that there is **no** official self-serve API surface to list, which requires
  a non-empty `endpoints_note`. `method` is uppercase HTTP; `path` starts with
  `/`; duplicate `(method, path)` pairs in one row are an error.
- **`endpoints_note`** -- string or null, one line, at most 300 characters:
  why `endpoints` is empty or partial.

No shard row carries any of these yet, because the aggregator catalogs do not
publish a vendor's own docs URL, auth/pricing specifics or endpoint catalog --
`build.py` never invents one of these five fields itself. See "Preserving
hand-filled fields" below for how a rebuild keeps a hand-filled value instead
of wiping it -- the mechanism is generic and covers these five fields the
same way it covers `offering` and any other hand-filled extra a shard row
carries.

## ND-12 pricing gate

Four more fields nested in `pricing` (independent of the five ND-8 fields
above), plus two new top-level row fields and one derived field -- validated
identically by `validate.py` and `src/apis.ts`, and checked for drift by
`test/pricing-gate.test.ts`. The point: tell a human or an agent, at a
glance, whether an API can be reached for free or pay-as-you-go, or whether
it forces a recurring commitment or a sales call first -- and if it does,
where else to get the same capability.

### `pricing.*` (nested, all optional, all null-when-unknown)

| field | type | meaning |
|---|---|---|
| `api_access_gate` | enum or null | what stands between you and the API -- see below |
| `min_monthly_usd` | number ≥ 0 or null | the subscription's minimum monthly fee, only when `api_access_gate` is `subscription_required` |
| `min_prepay_usd` | number ≥ 0 or null | the minimum prepaid balance, only when `api_access_gate` is `prepaid_min` |
| `gate_source_url` | http(s) URL or null | the vendor's own pricing page the gate was read from |

`api_access_gate` is one of:

- **`none`** -- free, or pure pay-as-you-go: no gate at all.
- **`prepaid_min`** -- must prepay a minimum balance, but there is no
  monthly fee. The minimum goes in `min_prepay_usd`.
- **`subscription_required`** -- there is no API access without a paid
  subscription. The minimum monthly fee goes in `min_monthly_usd`.
- **`contact_sales`** -- the API is reachable only through a sales process.
- **`unknown`** -- nobody has checked the vendor's own pricing page yet.
- `null` -- same as `unknown`, for a row nobody has touched at all.

`min_monthly_usd` is **only allowed** (non-null) when the gate is
`subscription_required`, and `min_prepay_usd` only when it is `prepaid_min`
-- a minimum attached to the wrong gate is rejected, the same way
`starting_price_usd` is never guessed elsewhere in this file.
`gate_source_url` is **required** whenever `api_access_gate` is set and is
not `unknown` -- a real claim about how the API is gated needs the page it
came from; `unknown` (nobody checked) and `null` need no source.

### `alternatives` / `alternatives_note` (top-level, optional)

- **`alternatives`** -- null/absent, or a list of
  `{vendor_id, why, access_gate}`:
  - `vendor_id` -- non-empty string. Must resolve to an existing index
    entry: a shard row's `id` in `data/apis/*.yaml`, or a root `apis.yaml`
    entry's `name` -- **never invented**. Must not equal this row's own id,
    and must not repeat within one list.
  - `why` -- non-empty single-line string, at most 200 characters.
  - `access_gate` -- one of `none | prepaid_min | subscription_required |
    contact_sales` (the same five values as `pricing.api_access_gate`,
    **minus** `unknown` -- `unknown` says nothing about how the alternative
    itself is gated, so it cannot describe one).
- **`alternatives_note`** -- single-line non-empty string, at most 300
  characters, or null.

These two are **required together with the gate**, never independent of it:

- When `pricing.api_access_gate` is `subscription_required` or
  `contact_sales`: `alternatives` must be a list (non-null). An empty list
  (`[]`) is allowed, but then `alternatives_note` is required -- say in
  words why there is nowhere else to go.
- For every other gate (including `unknown`, `null`, or no `pricing` block
  at all): `alternatives` and `alternatives_note` must both be absent or
  null. A row nobody has gated has nothing to route around yet.

### `cost_badge` (top-level, derived -- never hand-fill this)

| `pricing.api_access_gate` | `cost_badge` |
|---|---|
| `none`, `prepaid_min` | `green` |
| `subscription_required`, `contact_sales` | `red` |
| `unknown`, `null`, or no `pricing` block at all | `gray` |

`cost_badge` is **never hand-filled**: `build.py` writes it on every row it
emits, computed from that row's own `pricing` *after* hand-filled fields
have been merged back onto it (see "Preserving hand-filled fields" below).
The validators only ever check that a `cost_badge` present on a row (old
data a human typed in, or a stale regenerate) still agrees with what
`pricing.api_access_gate` derives -- a row with no `cost_badge` at all is
still valid. A mismatch is rejected with:

```
<row>.cost_badge: derived field; expected <x> from pricing.api_access_gate, got <y> (do not hand-edit; run build)
```

`src/apis.ts` exports the mapping as `deriveCostBadge(pricing)` (constants
`API_ACCESS_GATES`, `ALTERNATIVE_ACCESS_GATES`, `COST_BADGES`); the index
loader (`loadApiIndex` / `buildApiIndex`) also sets a computed `costBadge`
property on every loaded entry, so a consumer never has to call
`deriveCostBadge` itself. `validate.py` exports the same mapping as
`derive_cost_badge(pricing)`.

### Every validation error string

```
<row>.pricing.api_access_gate: expected one of none | prepaid_min | subscription_required | contact_sales | unknown or null
<row>.pricing.min_monthly_usd: expected a non-negative number or null
<row>.pricing.min_monthly_usd: only allowed when pricing.api_access_gate is subscription_required
<row>.pricing.min_prepay_usd: expected a non-negative number or null
<row>.pricing.min_prepay_usd: only allowed when pricing.api_access_gate is prepaid_min
<row>.pricing.gate_source_url: expected an http(s) URL or null
<row>.pricing.gate_source_url: required when pricing.api_access_gate is set and not unknown (what proves the gate?)
<row>.alternatives: required (a list) when pricing.api_access_gate is subscription_required or contact_sales
<row>.alternatives: must be absent or null unless pricing.api_access_gate is subscription_required or contact_sales
<row>.alternatives: expected a non-empty alternatives_note when alternatives is [] -- say where else to go
<row>.alternatives[N]: expected a mapping
<row>.alternatives[N].<field>: unknown field
<row>.alternatives[N].vendor_id: expected a non-empty string
<row>.alternatives[N].vendor_id: must not equal this row's own id
<row>.alternatives[N].vendor_id: duplicate vendor_id '<id>'
<row>.alternatives[N].vendor_id: unknown vendor '<id>' -- not a shard id or apis.yaml name
<row>.alternatives[N].why: expected a non-empty string
<row>.alternatives[N].why: expected a single line (no line breaks)
<row>.alternatives[N].why: expected at most 200 characters, got <n>
<row>.alternatives[N].access_gate: expected one of none | prepaid_min | subscription_required | contact_sales
<row>.alternatives_note: expected a non-empty string or null
<row>.alternatives_note: expected a single line (no line breaks)
<row>.alternatives_note: expected at most 300 characters, got <n>
<row>.alternatives_note: must be absent or null unless pricing.api_access_gate is subscription_required or contact_sales
<row>.cost_badge: derived field; expected <x> from pricing.api_access_gate, got <y> (do not hand-edit; run build)
```

### `data/apis/scripts/derive_cost_badge.py`

A standalone script that rewrites/inserts `cost_badge` lines directly in the
shard YAML text, for exactly the reason `build.py` cannot be run in a clean
clone: `raw/` is not committed (see "Layout" above). It never touches
anything but `cost_badge` lines, is idempotent (a second run changes
nothing), and supports `--check` (reports what would change, without
writing, exit 1 if anything would):

```
python3 data/apis/scripts/derive_cost_badge.py [--check] [dir]
```

No shard row carries `pricing`, `alternatives` or `alternatives_note` yet --
same reason as the ND-8 fields above. `build.py` preserves all three (and
the four new `pricing.*` keys) across a rebuild exactly as it does the five
ND-8 fields, emitting `alternatives` then `alternatives_note` right after
them -- see "Preserving hand-filled fields" below, which already covers
these generically.

## Preserving hand-filled fields

`build.py` only ever computes a fixed set of base fields for a row -- `id`,
`name`, `capability`, `category`, `provider_url`, `docs_url`, `access_mode`,
`signup`, `signup_automatable`, `min_topup`, `billing_unit`, `free_tier`,
`auth_type`, `seen_in`, `tos_notes`, `source_url`, `checked_date` (`ORDER` in
`scripts/build.py`) -- from `raw/` and `curated.py`. **Any other key** a shard
row carries -- the five ND-8 fields above, `offering`, or a key nobody has
written yet -- is something `build.py` itself never invents, so a rebuild
**preserves** whatever is already there instead of wiping it. This is a
generic mechanism keyed only off "is this one of the base fields I compute,"
not a hard-coded list of known extra field names, so a brand-new hand-filled
key works the same way without a `build.py` change.

For each key not in that base set, `build.py` (`merge_preserved` in
`scripts/build.py`) picks, in order:

1. the existing shard's value, if that file already has one and it is non-null;
2. else `curated.py`'s `STRUCTURED[id]` value for that key, if any and non-null;
3. else the key is left out of the row entirely.

So `python3 scripts/build.py` can only ever pick up a hand-filled value for
one of these keys, never strip or guess one, and a row that has none of them
regenerates byte-identical to before any of them existed. Once emitted
(`emit_row`), the base fields come first, then the five ND-8 fields present on
the row in their defined order, then the two ND-12 fields (`alternatives`,
`alternatives_note`) present on the row in their defined order, then any other
preserved extra key in the order it appeared on the existing shard row. The
nested value itself can be anything PyYAML and `validate.py`'s fallback reader
both round-trip: mappings, lists of scalars or mappings, nested mappings,
multi-line strings, booleans, numbers, null and dates.

**`cost_badge` is the one exception to "never invents":** it is the one key
`build.py` *does* compute itself on every row, derived from that row's own
(already-merged) `pricing` -- see "ND-12 pricing gate" above. `merge_preserved`
treats it like a base field (never pulled from the existing shard), even
though it is not in `ORDER`, so a stale `cost_badge` from before a pricing
edit can never survive a rebuild.

## Counts

### Deduped total

**162 providers** across 26 category shards.

### Per source (`seen_in`)

| catalog | providers indexed | underlying listings behind them |
|---|---|---|
| glasser | 105 | 2,170 endpoints (catalog self-reports 105 providers) |
| monid   | 92  | 2,900 endpoints + 9 rentable resources (catalog self-reports 2,853–2,900) |
| flatkey | 16  | 85 model rows on the public models directory |

Overlap between catalogs:

| appears in | providers |
|---|---|
| glasser only | 60 |
| monid only | 42 |
| flatkey only | 10 |
| glasser + monid | 44 |
| flatkey + monid | 5 |
| all three | 1 (`typesafe`) |

Monid markets "1,700+ tools" and Flatkey "1,000+ metered tools". Monid's public
API confirms the endpoint-level number (2,900 endpoints, 93 providers, 92 of
them indexed here) — the
inflation is endpoints-per-provider, not missing providers. Flatkey's tool count
could **not** be confirmed: its tool catalog is login-only (see *Blocked* below),
so Flatkey contributes only model-layer vendors here.

### Per category

| category | n | | category | n |
|---|---|---|---|---|
| people-company-data | 22 | | news-media | 4 |
| ecommerce-retail | 14 | | real-estate | 4 |
| llm-models | 13 | | government-reference | 3 |
| finance-markets | 10 | | weather-environment | 3 |
| generative-media | 9 | | contact-verification | 3 |
| jobs-compensation | 8 | | ai-benchmarks | 2 |
| web-search | 8 | | legal-compliance | 2 |
| crypto-web3 | 7 | | maps-local | 2 |
| seo-marketing | 7 | | research-academic | 2 |
| web-scraping | 7 | | travel-hospitality | 2 |
| automotive | 6 | | | |
| reviews-ratings | 6 | | | |
| social-media | 6 | | | |
| developer-infra | 5 | | | |
| communications | 4 | | | |
| entertainment-media | 4 | | | |

### Per access_mode

| access_mode | n | meaning as used here |
|---|---|---|
| own-account | 105 | the vendor documents direct API access you can hold your own key for |
| intermediary | 46 | no first-party public data API identified — the catalogs appear to reach it by scraping |
| unknown | 11 | not determined from public material |

`byok` is a legal value in the schema but no entry warranted it: none of the
three catalogs documents bring-your-own-key passthrough for a named provider.

### Other field coverage

- **provider_url resolved: 145 / 162 = 89.5 %.** The 17 nulls are vendors whose
  homepage was neither stated by a catalog nor well-known enough to assert:
  `aviato`, `edinet`, `justoneapi`, `kadec0`, `macaron`, `metixai`, `octen`,
  `orbit`, `ploid`, `saperly`, `sfs`, `sonilo`, `surf`, `suzanne`, `tiktok-shop`,
  `typesafe`, `valyu`.
- **docs_url resolved: 46 / 162 = 28.4 %** — 36 came straight from Monid's
  provider records, the rest are well-known developer-docs domains.
- `signup`: self-serve 69, sales 8, unknown 85.
- `auth_type`: api_key 92, unknown 61, oauth 7, none 2.
- `min_topup`, `billing_unit`, `free_tier`: **null on all 162 entries.** The brief
  requires these to be verified on the provider's own pricing page, and that
  verification was not performed. The aggregators do publish their own resale
  prices, but copying those would describe the aggregator, not the provider.
- `signup_automatable`: `no` for the 8 sales-gated vendors and `unknown` for the
  other 154 — no signup flow was actually attempted, so nothing is `yes`.

## Method, per catalog

Nothing in this index required a login. `robots.txt` was fetched first for all
three hosts and honoured. No `run`, `discover` or other billable call was made.

### Glasser (glasser.ai) — complete

1. `https://glasser.ai/robots.txt` → `Allow: /`, two sitemaps declared.
2. `https://glasser.ai/sitemap.xml` (195 KB) → 1,558 `/endpoints/*`,
   105 `/data-sources/*`, 24 legacy `/datasources/*` pages.
3. `https://glasser.ai/llms.txt` → pointed at the docs set and `SKILL.md`.
4. `https://glasser.ai/SKILL.md` and `https://glasser.ai/docs/api-reference`
   → the docs name a public operation, `GET /public/catalog`.
5. **`https://api.glasser.ai/public/catalog`** → the whole catalog, no auth
   header, HTTP 200, 1.2 MB: `endpoint_count: 2170`, `provider_count: 105`,
   plus a `providers[]` block with slug, label, description, categories and
   endpoint count. This is the source of all 105 glasser entries.
6. Cross-checked with the installed CLI (`glasser v0.1.57`), read-only:
   `glasser search --use-case "..." --json` and
   `glasser inspect -p ahrefs -e /v3/site-explorer/domain-rating --json`.
   Both answer **without credentials** (omitting `use_case` returns a schema
   error, not a 401). `glasser run` was never invoked.
   *Disclosure:* a Glasser Key already existed in this machine's credential
   store before this task (`glasser balance` reports a funded workspace). No
   login was performed and no paid call was made — only
   `--help`, `search` and `inspect`.

Glasser publishes no outbound vendor links on its `/data-sources/<slug>` pages
and no `provider_url` field in the catalog JSON, so vendor homepages for
glasser-only providers come from `curated.py`, not from Glasser.

### Monid (monid.ai) — complete at provider level

1. `https://monid.ai/robots.txt` → `Allow: /`, sitemap index declared.
2. `https://monid.ai/sitemap.xml` → `https://monid.ai/pages.xml` (888 KB) and
   `https://monid.ai/docs/sitemap.xml`. `pages.xml` holds 238 `/tools/*` pages —
   a mix of provider slugs and category slugs, so not usable on its own.
3. `https://monid.ai/llms.txt`, `https://monid.ai/docs/llms.txt`,
   `https://monid.ai/SKILL.md` → confirmed `discover`/`inspect` are key-gated.
4. Nuxt JS bundles linked from `https://monid.ai/tools` (10 chunks under
   `https://monid.ai/_nuxt/`) were grepped for API paths, yielding four
   **unauthenticated** endpoints on `https://api.monid.ai`:
   - `GET /public/v1/providers` → 93 providers, with `url` and `docsUrl` for 36
   - `GET /public/v1/endpoints` → 2,900 endpoints (cursor-paged, 50/page)
   - `GET /public/v1/categories` → 210 categories, `totalEndpointCount: 2853`
   - `GET /public/v1/resources` → 9 rentable resources (phone numbers, inboxes,
     browser sessions, microVMs, voices, file systems)
   All four return HTTP 200 with no credentials. Paginated to exhaustion.
5. The Monid CLI is **not** installed on this machine, and `monid discover`
   requires a key from `https://app.monid.ai/access/api-keys` — not used.

### Flatkey (flatkey.ai) — partial, model layer only

1. `https://flatkey.ai/robots.txt` → `Allow: /` but **`Disallow: /api/`**,
   `/dashboard/`, `/_next/`, `/cdn-cgi/`, `/lp/`.
2. `https://flatkey.ai/sitemap.xml` → ten per-language sitemaps; the English one
   (`https://flatkey.ai/sitemaps/sitemap/en.xml`, 416 URLs) contains
   82 `/models/*`, 8 `/collections/*` and only **2** `/tools/*` pages.
3. `https://flatkey.ai/llms.txt` → router base URL and protocol surfaces.
4. `https://flatkey.ai/SKILL.md` → states plainly that the tools catalog is
   reachable only through the authenticated console.
5. `https://flatkey.ai/models` is server-rendered: the RSC payload embeds 85
   model rows with `model_name`, `vendor_name` and a `directory_metadata` block
   carrying `author` and upstream `providers`. Parsed locally into
   `raw/flatkey_models_extracted.json` → 13 model vendors plus 3 upstream
   hosting routes (Amazon Bedrock, Azure, Baidu AI Cloud) = 16 entries.
6. `https://flatkey.ai/tools/google-search-api` and
   `https://flatkey.ai/tools/web-scraping-api` were fetched and name **no**
   underlying providers — they are capability landing pages, so they produced no
   index entries.

## Blocked / needs a logged-in session

| what | exact URL | status |
|---|---|---|
| Flatkey tool catalog (its "1,000+ metered tools") | `https://console.flatkey.ai/api-marketplace` | Login-only console. `SKILL.md` states tools are "available to eligible plans through the authenticated tools catalog". Not enumerable publicly; **this is the single biggest gap in the index.** |
| Flatkey live model catalog | `https://router.flatkey.ai/v1/models` | HTTP **401** `{"error":{"message":"Token not provided"}}` without `Authorization: Bearer sk-fk-…`. Worked around via the SSR payload on `https://flatkey.ai/models`, which may lag the live catalog (directory shows 81–85 rows; `SKILL.md` claims "300+ supported AI models"). |
| Flatkey GPU price index and any other JSON under `/api/` | `https://flatkey.ai/api/compute/price-index` | **Not fetched.** `https://flatkey.ai/robots.txt` sets `Disallow: /api/` for all agents, even though `https://flatkey.ai/llms.txt` advertises this same URL as "open data, free to cite". Conflicting signals; robots.txt was honoured. Contains GPU hourly prices, not tool listings, so nothing in this index depends on it. |
| Flatkey router robots.txt | `https://router.flatkey.ai/robots.txt` | HTTP 301 → `https://console.flatkey.ai/robots.txt` (login host). |
| Monid `discover` / `inspect` (per-endpoint schemas, live prices, health) | `https://api.monid.ai/v1/discover`, `https://api.monid.ai/v1/inspect`; keys from `https://app.monid.ai/access/api-keys` | Key-gated. Not needed for provider-level coverage — the `/public/v1/*` endpoints above gave the full provider and endpoint list. |
| Monid provider detail | `https://api.monid.ai/public/v1/providers/apify` | HTTP **404**. Only the list form and `/public/v1/providers/{p}/endpoints` exist. |
| `llms-full.txt` on all three | `https://glasser.ai/llms-full.txt`, `https://monid.ai/llms-full.txt`, `https://flatkey.ai/llms-full.txt` | HTTP **404** on all three (HTML error pages). |
| OpenAPI specs | `https://api.glasser.ai/openapi.json`, `/openapi.yaml`, `/.well-known/openapi.json`, `/spec.json` | HTTP **404**. Glasser's HTTP contract is only published as rendered docs at `https://glasser.ai/docs/api-reference/overview`. |

## Caveats

- **The unit is the provider, not the endpoint.** 162 providers sit on top of
  ~5,100 listed endpoints. Endpoint-level detail was deliberately not copied.
- **`access_mode` describes the direct path to the vendor**, not how the
  aggregator bills you. A vendor marked `own-account` may still be resold by all
  three catalogs; a vendor marked `intermediary` is one we could not find a
  first-party public API for, which is a statement about our search, not proof
  that none exists.
- **SkeletonKey pays in fiat only, so the index records no crypto-payment
  rail.** Monid's catalog advertises per-call wallet payment on nearly every
  endpoint; none of that is represented here, and there is no `access_mode` for
  it. Seven providers were previously classified by that rail alone. Six are
  kept as ordinary APIs: `browserbase` and `quicknode` sell self-serve accounts
  and are recorded `own-account`, while `blockrun`, `capminal`, `emc2ai` and
  `kadec0` drop to `access_mode: unknown` because no other access path was
  verified for them. The seventh was a directory of payment endpoints rather
  than an API in its own right, and is no longer indexed — `build.py` reports
  it as an uncurated catalog slug and skips it.
- Two Alibaba products are kept apart because the catalogs list different
  things: `alibaba-com` (the B2B marketplace, via Glasser) and `alibaba-cloud`
  (Model Studio / Qwen / WAN, via Monid and Flatkey). Likewise `us-census-bureau`
  (the official API, via Glasser) is separate from `censusdata-xyz` (a
  third-party wrapper, via Monid).
- `sfs` (Simple FS) is Monid's own agent file system, not an independent vendor;
  it is kept for completeness with `access_mode: unknown`.
- `source_url` points at one representative aggregator page per provider
  (Glasser's `/data-sources/<slug>` preferred, then Monid's `/tools/<slug>`,
  then `https://flatkey.ai/models`). Three Monid-only providers have no
  dedicated tool page and fall back to `https://monid.ai/tools`: `kadec0`,
  `capminal`, `emc2ai`. The ten Flatkey-only vendors all point at
  `https://flatkey.ai/models`.

## Regenerating

```
cd data/apis
python3 scripts/build.py      # rewrites every <category>.yaml from raw/
python3 scripts/validate.py   # must exit 0
```

`build.py` fails loudly if `raw/` grows a provider that `curated.py` has no row
for (or vice versa), so a re-scrape cannot silently drop metadata. `raw/` is
not in the repo (see Layout above) -- supply it locally before running either
command.
