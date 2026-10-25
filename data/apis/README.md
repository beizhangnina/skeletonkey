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

```
data/apis/
  <category>.yaml        26 shards, top-level key `apis:` (one list per category)
  README.md              this file
  scripts/validate.py    schema validator (exit 0 = pass)
  scripts/build.py       regenerates the shards from raw/
  scripts/curated.py     hand-written per-provider facts used by build.py
  raw/                   cached scrape artifacts (45 files, ~8 MB)
```

Validate with:

```
python3 data/apis/scripts/validate.py
# shards: 26   entries: 162   unique ids: 162
# OK: all entries valid
```

`validate.py` uses PyYAML when importable and falls back to a small parser for
the exact shape `build.py` emits, so it runs on a bare interpreter too.

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
for (or vice versa), so a re-scrape cannot silently drop metadata.
