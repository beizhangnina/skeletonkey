"""Generate /apis/, /apis/<slug>/, /apis/aggregators/, /apis.json and /llms.txt
from the repo's own data: data/apis/*.yaml (canonical for every field a shard
row carries, including the ND-7/ND-8 structured fields) merged with the
committed site/data/vendor-research.json overlay (research-only fields the
shards don't carry) and site/data/routes/ (aggregator profiles and vendor
routes). Nothing outside the repo is read, so a clean clone can build the
site.

    python3 scripts/build_apis.py [--out DIR]

--out (default: site/public) is where apis/, apis.json, llms.txt and
sitemap.xml are written. public/index.html is always read from site/public
(its header/footer markup is reused), regardless of --out.

Run scripts/export_site_data.py --index <path/to/index.yaml> to refresh
vendor-research.json and routes/ from a new research pass.
"""
import sys, os, re, json, html, shutil, glob, argparse, yaml
SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)              # site/
REPO_ROOT = os.path.dirname(ROOT)            # repo root
PUB = os.path.join(ROOT, 'public')           # source of index.html, always
SHARD_DIR = os.path.join(REPO_ROOT, 'data', 'apis')
SITE_DATA = os.path.join(ROOT, 'data')
RDIR = os.path.join(SITE_DATA, 'routes')

_ap = argparse.ArgumentParser()
_ap.add_argument('--out', default=PUB, help='directory to write apis/, apis.json, llms.txt, sitemap.xml into (default: site/public)')
OUT_ROOT = os.path.abspath(_ap.parse_args().out)
os.makedirs(OUT_ROOT, exist_ok=True)

SITE = 'https://skeletonkey.run'
TODAY = '2026-10-26'

# ---- shards + research overlay merge ---------------------------------------
# data/apis/*.yaml shards are canonical for every field they carry (id, name,
# category, provider_url, docs_url, auth_type, signup, access_mode, seen_in,
# checked_date, min_topup, billing_unit, free_tier, and the ND-7/ND-8
# structured fields: official_docs_url, auth, pricing, endpoints,
# endpoints_note, collection_scope, visibility, visibility_note).
# site/data/vendor-research.json carries the research-only fields the shards
# never gained (what_it_does, url, signup_url, ...) -- a committed snapshot of
# the external research index, refreshed by export_site_data.py.
# Merge rule: a shard value wins whenever both sides have the key, EXCEPT when
# the shard's value is null/absent and the overlay has one, in which case the
# overlay fills -- which matters today for docs_url/min_topup/billing_unit/
# free_tier: shard-canonical fields that are null on every shard row (a known
# research gap), so the overlay's old-index value is what actually reaches the
# site until a shard fills one in. The one field excluded from this fallback
# on purpose is `seen_in`: the shard's list form and the old index's scalar
# bucket aren't the same shape, so `catalogs()` below reads the shard's list
# only and the overlay never carries `seen_in` at all.
OVERLAY = json.load(open(os.path.join(SITE_DATA, 'vendor-research.json')))
VENDOR_RESEARCH = OVERLAY.get('vendors') or {}

def load_shard_rows():
    rows = []
    for f in sorted(glob.glob(os.path.join(SHARD_DIR, '*.yaml'))):
        rows.extend((yaml.safe_load(open(f)) or {}).get('apis') or [])
    return rows

def merge_row(shard_row):
    merged = dict(VENDOR_RESEARCH.get(shard_row['id']) or {})
    for k, v in shard_row.items():
        if v is not None or k not in merged:
            merged[k] = v
    return merged

ENTRIES = [merge_row(r) for r in load_shard_rows()]
E = lambda s: html.escape('' if s is None else str(s))
home = open(os.path.join(PUB, 'index.html')).read()
HEAD = re.search(r'<header class="site-head">.*?</header>', home, re.S).group(0).replace(' aria-current="page"', '')
HEAD = HEAD.replace('<a class="head-link"', '<a class="head-link head-apis" href="/apis/">API index</a>\n    <a class="head-link"', 1)
FOOT = re.search(r'<footer class="site-foot">.*?</footer>', home, re.S).group(0)
CATS = {'glasser': ('Glasser', 'https://glasser.ai'), 'monid': ('Monid', 'https://monid.ai'), 'flatkey': ('Flatkey', 'https://flatkey.ai')}

# ---- catalog scope (Bei, 2026-11-24) ----------------------------------------
# tool/data APIs and aggregators (treg, glasser, monid, ...) are collected;
# LLM APIs are set aside: hidden from listings by default, never deleted. The
# overlay in site/data/collection.json carries per-row exceptions (none of the
# derivation below needed them, so vendor_overrides ships empty) plus treg's
# profile, which does not exist in the external research index. Mirrors
# src/apis.ts effectiveCollectionScope/effectiveVisibility and validate.py's
# copy of it -- same category set, same rule.
COLLECTION = json.load(open(os.path.join(ROOT, 'data', 'collection.json')))
VENDOR_OVERRIDES = COLLECTION.get('vendor_overrides') or {}
AGGREGATOR_OVERRIDES = COLLECTION.get('aggregator_overrides') or {}
EXTRA_AGGREGATORS = COLLECTION.get('extra_aggregators') or []
TOOL_SCOPE_CATEGORIES = {'generative-media', 'web-search', 'web-scraping', 'seo-marketing',
                         'developer-infra', 'communications', 'contact-verification'}

def derive_collection_scope(category):
    if category == 'llm-models':
        return 'llm'
    if category in TOOL_SCOPE_CATEGORIES:
        return 'tool'
    return 'data'

def vendor_collection(r):
    """(collection_scope, visibility, visibility_note) for one vendor row:
    site/data/collection.json's vendor_overrides wins, else the shard row's
    own collection_scope/visibility/visibility_note (set on the llm-models
    shard rows), else category derivation -- same precedence as apis.yaml."""
    ov = VENDOR_OVERRIDES.get(r['id']) or {}
    scope = ov.get('collection_scope') or r.get('collection_scope') or derive_collection_scope(r.get('category'))
    visibility = ov.get('visibility') or r.get('visibility') or ('hidden' if scope == 'llm' else 'listed')
    note = ov.get('visibility_note') if ov.get('visibility_note') is not None else r.get('visibility_note')
    return scope, visibility, note

AGGS = json.load(open(os.path.join(RDIR, 'aggregators.json'))) + EXTRA_AGGREGATORS
for _a in AGGS:
    _ov = AGGREGATOR_OVERRIDES.get(_a['slug']) or {}
    _a['collection_scope'] = 'aggregator'
    _a['visibility'] = _ov.get('visibility') or 'listed'
    _a['visibility_note'] = _ov.get('visibility_note')
AGG = {a['slug']: a for a in AGGS}
SRC_MAP = {'glasser': 'glasser', 'monid': 'monid', 'flatkey': 'flatkey', 'apify': 'apify-store', 'rapidapi': 'rapidapi'}
KEY_UNKNOWN = {'apify-store', 'rapidapi'}   # third-party listings: we did not confirm whether a vendor key is needed

def status(r):
    if r.get('no_public_api'): return 'no-public-api'
    if r.get('sales_only'): return 'sales-only'
    return 'verified' if r.get('verified') else 'unverified'
STATUSES = ('verified', 'unverified', 'sales-only', 'no-public-api')
# ND-18: visible status badges only exist for sales-only/no-public-api (the
# verified/unverified ones were dropped -- see `badge()`); STATUS_FILTER_LABEL
# is the neutral wording for the Status filter's own options.
LABEL = {'sales-only': 'Sales only', 'no-public-api': 'No public API'}
# ND-18: no checked/unchecked filter options -- they read as a verification claim.
STATUS_FILTER_LABEL = {'sales-only': 'Sales only', 'no-public-api': 'No public API'}
STATUS_PROSE = {'verified': 'checked', 'unverified': 'not checked', 'sales-only': 'sales only', 'no-public-api': 'no public API'}

def catalogs(r):
    """Shard `seen_in` is a list (subset of glasser/monid/flatkey/vendor-direct);
    only the three catalog slugs CATS knows how to label are kept."""
    return [c for c in (r.get('seen_in') or []) if c in CATS]

def clean_note(t):
    if not t: return t
    t = re.sub(r",?\s*(each\s+)?(tagged|with)\s+(&#x27;|['\u2018\u2019\"])?(0|zero|no)\s+markup(&#x27;|['\u2018\u2019\"])?", "", t, flags=re.I)
    t = re.sub(r"\s*(&#x27;|['\"])?(0|zero|no)\s+markup(&#x27;|['\"])?", "", t, flags=re.I)
    t = re.sub(r",\s*with cheaper per-comment events listed lower down", ", with per-comment events also listed", t)
    return t

def slug(r): return re.sub(r'[^a-z0-9-]', '-', r['id'].lower())

# ---------- ND-13 cost badge / alternatives ----------
# vendor_id on an `alternatives` entry (ND-12) is either a shard row's own id
# (-> its vendor page) or an aggregator slug such as treg/glasser (-> its
# aggregator page). ID_INFO resolves the first case; AGG (built above) the second.
ID_INFO = {r['id']: (slug(r), r.get('name') or r['id']) for r in ENTRIES}

def alt_link(vendor_id):
    if vendor_id in ID_INFO:
        s, n = ID_INFO[vendor_id]
        return n, f'/apis/{s}/'
    if vendor_id in AGG:
        return AGG[vendor_id]['name'], f'/apis/aggregators/{vendor_id}/'
    return vendor_id, None   # should not happen -- validated upstream

def ordered_alts(alts):
    """treg and glasser first (their own relative order in the data), then the rest in data order."""
    pri = [a for a in alts if a['vendor_id'] in ('treg', 'glasser')]
    rest = [a for a in alts if a['vendor_id'] not in ('treg', 'glasser')]
    return pri + rest

ALT_GATE_LABEL = {'none': 'Pay as you go / free', 'prepaid_min': 'Prepaid credits',
                  'subscription_required': 'Subscription', 'contact_sales': 'Contact sales'}

# ---------- ND-18: FREE / PAYG / SUBS cost label ----------
# Derived from existing fields only (ND-12's cost_badge + ND-8's pricing gate/
# model/free_tier) -- no new data. None means no label at all: gray/unknown
# cost_badge, or access sold through a sales call (cost_badge red but the gate
# isn't subscription_required).
COST_LABEL_RANK = {'FREE': 0, 'PAYG': 1, 'SUBS': 2}

def cost_label(r):
    cb = r.get('cost_badge') or 'gray'
    p = r.get('pricing') or {}
    gate = p.get('api_access_gate')
    if cb == 'red':
        return 'SUBS' if gate == 'subscription_required' else None
    if cb == 'green':
        if gate == 'none' and (p.get('model') in ('free', 'freemium') or p.get('free_tier') is True or r.get('free_tier') is True):
            return 'FREE'
        if gate in ('none', 'prepaid_min'):
            return 'PAYG'
    return None

def llms_cost_bit(x):
    """Compact 'cost: ...' clause for one llms.txt vendor line; '' when the row has no cost label."""
    cl = x.get('cost_label')
    if not cl: return ''
    p = x.get('pricing') or {}
    if cl == 'FREE':
        return 'cost: FREE'
    if cl == 'PAYG':
        if p.get('api_access_gate') == 'prepaid_min':
            return (f'cost: PAYG, {money(p["min_prepay_usd"])} minimum top-up' if p.get('min_prepay_usd') is not None
                    else 'cost: PAYG, minimum top-up required')
        return 'cost: PAYG'
    bit = f'cost: SUBS from {money(p["min_monthly_usd"])}/mo' if p.get('min_monthly_usd') is not None else 'cost: SUBS'
    alts = x.get('alternatives') or []
    if alts: bit += '; no-subscription options: ' + ', '.join(alt_link(a['vendor_id'])[0] for a in ordered_alts(alts))
    return bit

def cost_sort_key(x):
    """Default /apis/ order: FREE, then PAYG (none-gated before prepaid_min), then SUBS, then no label."""
    gate = (x.get('pricing') or {}).get('api_access_gate')
    return (COST_LABEL_RANK.get(x.get('cost_label'), 3), 1 if gate == 'prepaid_min' else 0)

# routes/dead_urls.txt holds every URL that answered 404/410/DNS-failure in scripts/check_apis.py.
# Research runs recorded paths they merely probed (<site>/api, /developers, /pricing); those are
# guesses, not evidence, so no field or source list can put one back on a page.
DEADF = os.path.join(RDIR, 'dead_urls.txt')
DEAD = {l.strip() for l in open(DEADF)} if os.path.isfile(DEADF) else set()
DEAD.discard('')
DEAD = {u for u in DEAD if not u.startswith('#')}
def url_ok(u): return isinstance(u, str) and re.match(r'^https?://\S+$', u) and u not in DEAD
def sl(s): return re.sub(r'[^a-z0-9]+', '-', (s or '').lower()).strip('-')
NAMES = {sl(a['name']): a['slug'] for a in AGGS}

# ---------- routes ----------
def source_ident(s):
    """route.source -> (aggregator slug, display name). 'other:<name>' falls back to a slugified match."""
    raw = (s or '').strip(); low = raw.lower()
    if low in SRC_MAP: return SRC_MAP[low], AGG[SRC_MAP[low]]['name']
    if low.startswith('other:'): raw = raw.split(':', 1)[1].strip()
    k = sl(raw)
    for c in (k, NAMES.get(k)):
        if c in AGG: return c, AGG[c]['name']
    for a in AGGS:
        if k and (k in a['slug'] or k in sl(a['name'])): return a['slug'], a['name']
    return k or 'other', raw or 'Other'

def sents(t): return [s.strip() for s in re.split(r'(?<=[.;])\s+', t or '') if s.strip()]

FREE_PAT = r'\bfree (?:credits?|balance|trial|plan|tier|testing|basic)\b|\bno cost\b'
def free_credit(a):
    """The one sentence of our own profile notes that states a free credit, plan or trial, if any."""
    for s in sents(a.get('billing_model')):
        if re.search(FREE_PAT, s, re.I): return s.rstrip(';, ')
    return None

RL_PAT = r'requests?[ /-]per[ /-](?:second|minute|hour|day)|requests?/(?:second|minute|hour|day)|calls?/day|rate limit\w*|limited per day'
def rate_limits(a):
    """The clause of our profile notes that states a published limit, if there is one."""
    for s in sents(a.get('billing_model')):
        if re.search(RL_PAT, s, re.I):
            for c in re.split(r',\s|;\s|:\s|[()]', s):
                if re.search(RL_PAT, c, re.I): return re.sub(r'^(?:or|and)\s+', '', c.strip(' .,;'), flags=re.I)
    return None

def pay_model(a):
    """Short normalized payment tokens read off our aggregator profile."""
    txt = ' '.join([a.get('billing_model') or '', ' '.join(a.get('payment_methods') or [])])
    t = []
    if re.search(r'prepaid|wallet|credits|workspace balance|account balance|top ?-?up|pre-loaded', txt, re.I): t.append('prepaid_credits')
    if re.search(r'pay-?as-?you-?go|pay per|pay-per|per-call|per call|per-request|per request|per-run|usage-based|billed per|only on successful', txt, re.I): t.append('payg')
    if re.search(r'subscription plans|monthly subscription|monthly plans|monthly prepaid subscription|per-api plan|per-product plan|\$\d[\d,.]*\s*/\s*month|/month\b', txt, re.I): t.append('subscription')
    if re.search(r'x402', txt, re.I): t.append('x402')
    if re.search(r'no (platform )?account', txt, re.I): t.append('no_account')
    return t

def rnd(v): return float(f'{v:.10g}')
def money(v):
    if v is None: return None
    s = f'{v:.10f}'.rstrip('0').rstrip('.')
    return '$' + (s or '0')

def normalize(usd, unit):
    """per_call_usd_normalized + the basis the number is per. Anything else stays null."""
    if usd is None: return None, None
    u = (unit or '').strip().lower()
    if re.match(r'^per (call|run|request)\b', u): return rnd(usd), 'per_call'
    if re.match(r'^per result\b', u): return rnd(usd), 'per_result'
    if re.match(r'^per (1k|1,000|1000)\b', u): return rnd(usd / 1000.0), 'per_1k_unit'
    return None, None

def direct_route(r, st):
    usd = r.get('vendor_per_call_usd')
    link = next((u for u in (r.get('docs_url'), r.get('url'), r.get('pricing_url'), r.get('signup_url')) if url_ok(u)), None)
    return {'kind': 'direct', 'source_slug': 'direct', 'source_name': r.get('name') or r['id'], 'link': link,
            'price': {'usd': usd, 'unit': 'per call' if usd is not None else None,
                      'text': (money(usd) + ' per call') if usd is not None else None,
                      'per_call_usd_normalized': rnd(usd) if usd is not None else None,
                      'normalized_basis': 'per_call' if usd is not None else None},
            'signup': {'methods': [m for m in (r.get('signup_method') or []) if m != 'sales-only'],
                       'requires_card': r.get('requires_card'), 'requires_phone': r.get('requires_phone'),
                       'sales_call': bool(r.get('sales_only')), 'kyc_or_captcha': r.get('kyc_or_captcha')},
            'payment_model': r.get('billing_model'), 'payment_methods': [], 'vendor_key_needed': True,
            'free_tier': {'available': r.get('free_tier'), 'note': r.get('free_tier_note')},
            'rate_limits': None,
            'coverage': {'endpoints_exposed': 'all' if st != 'no-public-api' else None, 'example_endpoint': None,
                         'note': None if st != 'no-public-api' else "No public self-serve API on the vendor's own pages."},
            'verified': bool(r.get('verified')), 'verified_at': str(r.get('checked_date') or TODAY), 'source_url': link}

def ptext(t):
    """Tidy a listed price string: drop the listing's own endpoint prefix and badge chrome, keep the figure."""
    if not t: return None
    t = ' '.join(t.split())
    t = re.sub(r'^pricing[:\s]+', '', t, flags=re.I)
    t = re.sub(r'^[a-z0-9_.-]+\s+/\S*\s*', '', t)                      # 'edmunds /search_inventory $0.01' -> '$0.01'
    t = re.sub(r'\s*·?\s*\bnot run\b', '', t, flags=re.I)              # catalog status chip
    t = re.sub(r'\s*·?\s*\b(?:\d+(?:\.\d+)?%?|no|zero)\s*markup\b', '', t, flags=re.I)
    t = re.sub(r'\$\s+(?=[\d.])', '$', t)
    t = re.sub(r'(?<=\d)(?=per\b)', ' ', t)
    return re.sub(r'\s+', ' ', t).strip(' ·,;') or None

def agg_route(rt):
    s, name = source_ident(rt.get('source'))
    a = AGG.get(s)
    n, basis = normalize(rt.get('price_usd'), rt.get('price_unit'))
    fc = free_credit(a) if a else None
    link = rt.get('link') if url_ok(rt.get('link')) else None
    return {'kind': 'aggregator', 'source_slug': s, 'source_name': name, 'link': link,
            'price': {'usd': rt.get('price_usd'), 'unit': rt.get('price_unit'), 'text': ptext(rt.get('price_text')),
                      'per_call_usd_normalized': n, 'normalized_basis': basis},
            'signup': {'methods': (a or {}).get('signup_methods') or [], 'requires_card': (a or {}).get('requires_card'),
                       'requires_phone': None, 'sales_call': False, 'kyc_or_captcha': None},
            'payment_model': pay_model(a) if a else [], 'payment_methods': (a or {}).get('payment_methods') or [],
            'vendor_key_needed': None if s in KEY_UNKNOWN else False,
            'free_tier': {'available': True, 'note': fc} if fc else {'available': None, 'note': None},
            'rate_limits': rate_limits(a) if a else None,
            'coverage': {'endpoints_exposed': rt.get('endpoints'), 'example_endpoint': rt.get('example_endpoint'),
                         'note': clean_note(rt.get('verified_note'))},
            'verified': bool(rt.get('verified')), 'verified_at': str((a or {}).get('checked_date') or TODAY),
            'source_url': link, 'aggregator_page': f'{SITE}/apis/aggregators/{s}/' if a else None}

VENDOR_ROUTES = json.load(open(os.path.join(RDIR, 'vendor-routes.json')))

def routes_for(r, st):
    out = [direct_route(r, st)]
    for rt in VENDOR_ROUTES.get(r['id'], []): out.append(agg_route(rt))
    return out

# ---------- when to pick ----------
def nm(rs):
    n = [r['source_name'] for r in rs]
    return n[0] if len(n) == 1 else ', '.join(n[:-1]) + ' and ' + n[-1]
def rw(rs): return ('route', 'is') if len(rs) == 1 else ('routes', 'are')
def vb(rs, v): return v + ('s' if len(rs) == 1 else '')
def brief(t, n=120):
    t = ' '.join((t or '').split())
    if len(t) <= n: return t
    return t[:n].rsplit(' ', 1)[0].rstrip(' ,;.') + '…'

def when_to_pick(r, st, routes):
    """2-4 factual bullets, built only from the route fields above. No ratios, no 'cheaper'."""
    d, A = routes[0], routes[1:]
    if not A: return []
    B, date = [], d['verified_at']
    nocard = [a for a in A if a['signup']['requires_card'] is False and a['signup']['methods']]
    selfserve = [a for a in A if a['signup']['methods'] or 'no_account' in a['payment_model']]
    if st in ('no-public-api', 'sales-only') and selfserve:
        w, v = rw(selfserve)
        why = 'sales only' if r.get('sales_only') else 'no public API on the vendor pages'
        B.append(f"No self-serve direct route ({why}); the {nm(selfserve)} {w} {v} self-serve.")
    elif d['signup']['requires_card'] is True and nocard:
        a = nocard[0]
        extra = ' and prepaid credit' if 'prepaid_credits' in a['payment_model'] else ''
        B.append(f"Direct signup requires a card; the {a['source_name']} route needs only {', '.join(a['signup']['methods'][:3])} sign-in{extra}.")
    elif d['signup']['requires_card'] is False and nocard:
        B.append(f"Neither the direct signup nor the {nm(nocard)} {rw(nocard)[0]} {vb(nocard, 'ask')} for a card.")
    cov = [a for a in A if isinstance(a['coverage']['endpoints_exposed'], int)]
    if cov:
        lst = ', '.join(f"{a['source_name']} exposes {a['coverage']['endpoints_exposed']} endpoint{'' if a['coverage']['endpoints_exposed'] == 1 else 's'}" for a in cov)
        B.append(f"Only the direct route exposes all endpoints; {lst}." if st not in ('no-public-api', 'sales-only')
                 else f"{lst}; the vendor publishes no self-serve API we could confirm.")
    priced = [x for x in routes if x['price']['text']]
    if len(priced) > 1:
        B.append('Listed prices: ' + '; '.join(f"direct {x['price']['text']}" if x['kind'] == 'direct' else f"{x['source_name']} {x['price']['text']}" for x in priced) + '.')
    uv = [a for a in A if not a['verified']]
    if uv:
        w, v = rw(uv)
        B.append(f"The {nm(uv)} {w} {v} listed with no price readable there on {date}.")
    xs = [a for a in A if 'x402' in a['payment_model']]
    if xs:
        B.append(f"The {nm(xs)} {rw(xs)[0]} can be paid per call in USDC over x402.")
    if d['free_tier']['available'] and d['free_tier']['note']:
        B.append(f"Direct free tier: {brief(d['free_tier']['note'], 110)}")
    fc = [a for a in A if a['free_tier']['available']]
    if fc and len(B) < 4:
        B.append(f"The {nm(fc)} {rw(fc)[0]} {vb(fc, 'start')} new accounts with free credit.")
    keyless = [a for a in A if a['vendor_key_needed'] is False]
    if keyless:
        B.append(f"The direct route needs your own vendor key; the {nm(keyless)} {rw(keyless)[0]} {vb(keyless, 'use')} the aggregator's key.")
    uk = [a for a in A if a['vendor_key_needed'] is None]
    if uk:
        B.append(f"We did not confirm whether the {nm(uk)} {rw(uk)[0]} {vb(uk, 'need')} your own vendor key.")
    if len(B) < 2:
        B.append(f"{len(routes)} routes checked on {date}: direct and {nm(A)}.")
    return B[:4]

# ---------- json rows ----------
def public(r):
    st = status(r)
    out = {'slug': slug(r), 'name': r.get('name') or r['id'], 'category': r.get('category'), 'status': st,
           'summary': r.get('what_it_does'), 'checked_date': str(r.get('checked_date') or TODAY),
           'listed_by': [CATS[c][0] for c in catalogs(r)], 'docs_url': r.get('docs_url') if url_ok(r.get('docs_url')) else None,
           'page': f'{SITE}/apis/{slug(r)}/'}
    if st != 'no-public-api':
        out.update(base_url=r.get('base_url'), auth={'type': r.get('auth_type'), 'header': r.get('auth_header'), 'format': r.get('auth_format')},
                   signup={'methods': r.get('signup_method') or [], 'url': r.get('signup_url') if url_ok(r.get('signup_url')) else None,
                           'requires_card': r.get('requires_card'), 'requires_phone': r.get('requires_phone'), 'notes': r.get('kyc_or_captcha')})
    if st == 'verified':
        out.update(billing_model=r.get('billing_model'), billing_unit=r.get('billing_unit'), free_tier=r.get('free_tier'),
                   free_tier_note=r.get('free_tier_note'), min_topup_usd=r.get('min_topup'),
                   plans=[{k: p.get(k) for k in ('name', 'price', 'period_or_unit', 'note')} for p in (r.get('plans') or [])],
                   pricing_url=r.get('pricing_url') if url_ok(r.get('pricing_url')) else None)
    rt = routes_for(r, st)
    out['routes'] = rt
    out['when_to_pick'] = when_to_pick(r, st, rt)
    out['sources'] = [u for u in (r.get('source_urls') or []) if url_ok(u)]
    out['collection_scope'], out['visibility'], out['visibility_note'] = vendor_collection(r)
    # ND-8 structured core fields: pass through as-is when the source row has
    # them, null when it doesn't. A structured `auth` dict is a superset of
    # the legacy {type, header, format} shape (it adds docs_url), so it
    # replaces the legacy object built above; otherwise keep that legacy
    # object when present.
    out['auth'] = r.get('auth') if isinstance(r.get('auth'), dict) else out.get('auth')
    for k in ('official_docs_url', 'pricing', 'endpoints', 'endpoints_note'):
        out[k] = r.get(k)
    # ND-13: cost_badge is derived upstream (ND-12) -- never recompute, default
    # to gray for a row with no gate verdict. alternatives passes vendor_id/why/
    # access_gate through as-is, adding the resolved page/name for rendering.
    out['cost_badge'] = r.get('cost_badge') or 'gray'
    # ND-18: FREE/PAYG/SUBS label built from cost_badge + pricing above -- same
    # no-new-data rule, computed once here and read everywhere downstream.
    out['cost_label'] = cost_label(r)
    alts = r.get('alternatives')
    def alt_json(a):
        name, path = alt_link(a['vendor_id'])
        return dict(a, name=name, page=f'{SITE}{path}' if path else None)
    out['alternatives'] = [alt_json(a) for a in alts] if alts is not None else None
    out['alternatives_note'] = r.get('alternatives_note')
    return out

# ALL_ROWS keeps every vendor (hidden ones get their page generated too, so a
# direct URL still works); `rows` is the listing/browsing surface -- hidden
# rows (the LLM set-aside) are left out of the /apis/ index, llms.txt and the
# apis.json count/counts, same rule src/apis.ts and the CLI/MCP apply.
ALL_ROWS = sorted((public(r) for r in ENTRIES if r.get('conflicts_or_notes') != 'not yet researched'), key=lambda x: x['name'].lower())
rows = [x for x in ALL_ROWS if x['visibility'] != 'hidden']
hidden_rows = [x for x in ALL_ROWS if x['visibility'] == 'hidden']
HIDDEN_SLUGS = {x['slug'] for x in hidden_rows}

# ---------- aggregator profiles ----------
# Unfiltered on purpose: an aggregator's own "vendors routed through it" count
# is not one of the listing surfaces the LLM set-aside excludes from.
VEND = {a['slug']: [] for a in AGGS}
for x in ALL_ROWS:
    for rt in x['routes'][1:]:
        if rt['source_slug'] in VEND:
            VEND[rt['source_slug']].append({'slug': x['slug'], 'name': x['name'], 'category': x['category'],
                                            'page': f'{SITE}/apis/{x["slug"]}/', 'price_text': rt['price']['text'],
                                            'example_endpoint': rt['coverage']['example_endpoint'],
                                            'endpoints_exposed': rt['coverage']['endpoints_exposed'],
                                            'verified': rt['verified'], 'listing_url': rt['link']})

def agg_public(a):
    v = sorted(VEND.get(a['slug'], []), key=lambda d: d['name'].lower())
    return {'slug': a['slug'], 'name': a['name'], 'url': a.get('url'), 'what_it_is': a.get('what_it_is'),
            'api_base_url': a.get('api_base_url'), 'auth': {'header': a.get('auth_header'), 'format': a.get('auth_format')},
            'signup': {'methods': a.get('signup_methods') or [], 'url': a.get('signup_url') if url_ok(a.get('signup_url')) else None,
                       'requires_card': a.get('requires_card')},
            'billing_model': a.get('billing_model'), 'payment_model': pay_model(a), 'payment_methods': a.get('payment_methods') or [],
            'fee_or_markup_policy': a.get('fee_or_markup_policy'), 'free_credit': free_credit(a), 'rate_limits': rate_limits(a),
            'provider_count_claimed': a.get('provider_count_claimed'),
            'docs_url': a.get('docs_url') if url_ok(a.get('docs_url')) else None,
            'pricing_url': a.get('pricing_url') if url_ok(a.get('pricing_url')) else None,
            'verified': bool(a.get('verified')), 'checked_date': str(a.get('checked_date') or TODAY),
            'sources': [u for u in (a.get('source_urls') or []) if url_ok(u)],
            'page': f'{SITE}/apis/aggregators/{a["slug"]}/', 'vendor_count': len(v), 'vendors': v,
            'collection_scope': a.get('collection_scope') or 'aggregator',
            'visibility': a.get('visibility') or 'listed', 'visibility_note': a.get('visibility_note')}

aggs = [agg_public(a) for a in sorted(AGGS, key=lambda a: (-len(VEND.get(a['slug'], [])), a['name'].lower()))]
# The aggregator-index listing and llms.txt leave out hidden aggregators (the
# OpenRouter override); each one still gets its own page (see the write loop
# below, which iterates the unfiltered `aggs`).
VISIBLE_AGGS = [a for a in aggs if a['visibility'] != 'hidden']

# ---------- html ----------
def page(title, desc, path, body, extra_head=''):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}</title>
<meta name="description" content="{E(desc)}">
<link rel="canonical" href="{SITE}{path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:url" content="{SITE}{path}">
<meta property="og:site_name" content="SkeletonKey">
<meta property="og:title" content="{E(title)}">
<meta property="og:description" content="{E(desc)}">
<meta property="og:image" content="{SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The skeletonkey wordmark with a brass key mark on warm cream paper.">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F1ECE2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14110C" media="(prefers-color-scheme: dark)">
<link rel="preload" href="/fonts/fraunces.woff2?v=4" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/manrope.woff2?v=4" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css?v=7">
<link rel="stylesheet" href="/apis/apis.css?v=3">
<link rel="alternate" type="application/json" href="/apis.json">
{extra_head}</head>
<body class="apis-page">
<a class="skip" href="#main">Skip to content</a>

{HEAD}
<main id="main" class="apis-main"><div class="wrap">
{body}
</div></main>
{FOOT}
</body>
</html>
'''

def badge(st):
    """Sales-only/no-public-api still get a status badge; the old Verified/
    Unverified badges are dropped everywhere (ND-18)."""
    return f'<span class="ap-badge ap-{st}">{LABEL[st]}</span>' if st in LABEL else ''
def yn(v): return '—' if v is None else ('Yes' if v else 'No')

COST_LABEL_TITLE = {'FREE': 'Free to use, no subscription', 'PAYG': 'Pay as you go, no subscription',
                     'SUBS': 'Subscription required for API access'}

def cost_pill(x):
    """Small pill, FREE/PAYG/SUBS text only; '' when the row has no cost label (ND-18)."""
    cl = x.get('cost_label')
    if not cl: return ''
    text = cl
    if cl == 'SUBS':
        mm = (x.get('pricing') or {}).get('min_monthly_usd')
        if mm is not None: text = f'{cl} · {money(mm)}/mo'
    cls = 'ap-cost-green' if cl in ('FREE', 'PAYG') else 'ap-cost-red'
    title = COST_LABEL_TITLE[cl]
    return f'<span class="ap-badge {cls}" title="{E(title)}" aria-label="{E(cl + ": " + title)}">{E(text)}</span>'
def ext(u, t): return f'<a href="{E(u)}" rel="noopener nofollow">{E(t)}</a>' if u else E(t)

def why_html(why):
    """Render the trailing source URL in an alternative's one-line `why` as a link, not raw text."""
    m = re.search(r'(https?://\S+)\s*$', why or '')
    if not m: return E(why)
    return E((why[:m.start()]).rstrip()) + f' <a href="{E(m.group(1))}" rel="noopener nofollow">source</a>'

def alt_item(a):
    name, link = alt_link(a['vendor_id'])
    n = f'<a href="{E(link)}">{E(name)}</a>' if link else E(name)
    label = ALT_GATE_LABEL.get(a.get('access_gate'), E(a.get('access_gate') or ''))
    return (f'<li><span class="ap-alt-name">{n}</span> <span class="ap-alt-gate">{E(label)}</span>'
            f'<p class="ap-alt-why">{why_html(a.get("why"))}</p></li>')

def cost_section(x):
    """ND-18: the cost label, first screen. FREE/PAYG are one line (PAYG with a
    prepaid_min gate names the minimum top-up next to the pill); SUBS is a
    callout naming the subscription floor plus the pay-as-you-go/prepaid
    alternatives to route around it. Rows with no label (gray/unknown
    cost_badge, or sold only through a sales call) show nothing here, except a
    neutral alternatives list for contact_sales rows that have one."""
    cl = x.get('cost_label')
    p = x.get('pricing') or {}
    gate = p.get('api_access_gate')
    if not cl:
        alts = x.get('alternatives')
        if gate == 'contact_sales' and alts:
            return (f'<section class="ap-card" id="cost"><h2>Other ways to get access</h2>'
                     f'<ul class="ap-alt">{"".join(alt_item(a) for a in ordered_alts(alts))}</ul></section>')
        return ''
    pill = cost_pill(x)
    if cl == 'PAYG' and gate == 'prepaid_min':
        note = (f'· {money(p["min_prepay_usd"])} minimum top-up' if p.get('min_prepay_usd') is not None
                else '· minimum top-up required')
        return f'<p class="ap-cost">{pill} <span class="ap-cost-note">{E(note)}</span></p>'
    if cl in ('FREE', 'PAYG'):
        return f'<p class="ap-cost">{pill}</p>'
    # SUBS
    if p.get('min_monthly_usd') is not None:
        heading, text = 'Subscription required for API access', f'API access needs a paid plan from {money(p["min_monthly_usd"])}/month.'
    else:
        heading, text = 'Subscription required for API access', "API access needs a paid plan; the cheapest plan with API access isn't published clearly."
    src = p.get('gate_source_url')
    out = (f'<p class="ap-cost">{pill}</p>'
           f'<section class="ap-card ap-cost-red" id="cost"><h2>{E(heading)}</h2>'
           f'<p>{E(text)}{" " + ext(src, "Source") if src else ""}</p>')
    alts, note = x.get('alternatives'), x.get('alternatives_note')
    if alts:
        out += ('<h3>No subscription? Get credits here instead</h3>'
                 f'<ul class="ap-alt">{"".join(alt_item(a) for a in ordered_alts(alts))}</ul>')
    elif note:
        out += f'<p class="ap-note">{E(note)}</p>'
    return out + '</section>'

PRICING_MODEL_LABEL = {'free': 'Free', 'freemium': 'Freemium', 'pay_as_you_go': 'Pay as you go',
                        'subscription': 'Subscription', 'prepaid_credits': 'Prepaid credits',
                        'contact_sales': 'Contact sales', 'unknown': 'Unknown'}

def pricing_card(x):
    """ND-8 pricing block as its own card -- independent of the ND-7 `status`
    pricing section above (verified plans) and the ND-13 cost badge/callout."""
    p = x.get('pricing') or {}
    if not any(p.get(k) is not None for k in ('model', 'free_tier', 'starting_price_usd', 'unit', 'pricing_url', 'notes')):
        return ''
    price = (money(p['starting_price_usd']) + (f' {E(p["unit"])}' if p.get('unit') else '')) if p.get('starting_price_usd') is not None and x.get('status') == 'verified' else '—'
    return ('<section class="ap-card" id="pricing-overview"><h2>Pricing summary</h2><dl class="ap-dl">'
            f'<dt>Model</dt><dd>{E(PRICING_MODEL_LABEL.get(p.get("model"), p.get("model")) or "—")}</dd>'
            f'<dt>Free tier</dt><dd>{yn(p.get("free_tier"))}</dd>'
            f'<dt>Starting price</dt><dd>{price}</dd>'
            f'<dt>Pricing page</dt><dd>{ext(p.get("pricing_url"), p.get("pricing_url")) if p.get("pricing_url") else "—"}</dd>'
            f'<dt>Notes</dt><dd>{E(p.get("notes") or "—")}</dd></dl></section>')

def route_row(rt):
    if rt['kind'] == 'direct':
        head = ext(rt['link'], 'Direct') + f'<span class="ap-ex">{E(rt["source_name"])}</span>'
    else:
        n = f'<a href="/apis/aggregators/{E(rt["source_slug"])}/">{E(rt["source_name"])}</a>' if rt.get('aggregator_page') else E(rt['source_name'])
        head = n + (f'<span class="ap-ex">{ext(rt["link"], "listing")} <span aria-hidden="true">&#8599;</span></span>' if rt['link'] else '')
    p = rt['price']
    price = E(p['text']) if p['text'] else ('No price published' if rt['verified'] else 'No price confirmed')
    s = rt['signup']
    if s['sales_call'] and not s['methods']: signup = 'Sales only'
    else: signup = E(', '.join(s['methods'])) if s['methods'] else 'No account needed'
    signup += f'<span class="ap-ex">card: {yn(s["requires_card"]).lower()}</span>'
    pay = ', '.join(rt['payment_model']) if isinstance(rt['payment_model'], list) else (rt['payment_model'] or '')
    ep = rt['coverage']['endpoints_exposed']
    cov = 'All endpoints' if ep == 'all' else (f'{ep} endpoint{"" if ep == 1 else "s"}' if isinstance(ep, int) else '—')
    if rt['coverage']['example_endpoint']: cov += f'<span class="ap-ex">e.g. {E(rt["coverage"]["example_endpoint"])}</span>'
    ft = rt['free_tier']
    return (f'<tr{"" if rt["verified"] else " class=\'ap-unverified\'"}><th scope="row">{head}</th>'
            f'<td data-label="Price">{price}</td><td data-label="Signup">{signup}</td>'
            f'<td data-label="Payment">{E(pay) if pay else "—"}</td>'
            f'<td data-label="Vendor key">{"Unknown" if rt["vendor_key_needed"] is None else yn(rt["vendor_key_needed"])}</td>'
            f'<td data-label="Free tier">{yn(ft["available"])}</td>'
            f'<td data-label="Coverage">{cov}</td></tr>')

def routes_section(x):
    rts = x['routes']
    if len(rts) < 2: return ''
    hdr = ''.join(f'<th scope="col">{c}</th>' for c in ('Route', 'Price', 'Signup', 'Payment', 'Vendor key', 'Free tier', 'Coverage'))
    body = ''.join(route_row(rt) for rt in rts)
    notes = []
    for rt in rts:
        bits = [rt['coverage']['note']] if rt['coverage']['note'] else []
        if rt['free_tier']['note'] and rt['kind'] == 'aggregator': bits.append(f'Free credit or trial: {rt["free_tier"]["note"]}')
        if bits:
            label = 'Direct' if rt['kind'] == 'direct' else rt['source_name']
            notes.append(f'<dt>{E(label)}</dt><dd>{E(" ".join(bits))}</dd>')
    pick = ''.join(f'<li>{E(b)}</li>' for b in x['when_to_pick'])
    # ND-9: this table is a reference comparison, not the recommended path -- an
    # aggregator route bills through its own key, not a key of yours, so it is
    # no longer pitched as a substitute for registering your own account above.
    return ('<section class="ap-card" id="routes"><h2>Other routes (reference only)</h2>'
            f'<p class="ap-note">For comparison: besides registering your own account (see <a href="#register">Register locally</a> above), '
            f'this data has also shown up through <a href="/apis/aggregators/">aggregator gateways</a>, each billed through that gateway\'s own key, not yours. '
            f'SkeletonKey does not recommend routing your calls through a gateway key instead of your own account. '
            f'Every figure here is ours, read on the checked date; routes with no price readable there show none confirmed.</p>'
            f'<div class="ap-scroll"><table class="ap-table ap-routes"><thead><tr>{hdr}</tr></thead><tbody>{body}</tbody></table></div>'
            + (f'<h3>What differs between them</h3><ul class="ap-pick">{pick}</ul>' if pick else '')
            + (f'<h3>Route notes</h3><dl class="ap-dl ap-rnotes">{"".join(notes)}</dl>' if notes else '')
            + '</section>')

def endpoint_row(e):
    docs = ext(e.get('docs_url'), 'Docs') if e.get('docs_url') else '—'
    return (f'<tr><th scope="row"><code>{E(e.get("method"))} {E(e.get("path"))}</code></th>'
            f'<td data-label="Does">{E(e.get("summary") or "—")}</td>'
            f'<td data-label="Returns">{E(e.get("returns") or "—")}</td>'
            f'<td data-label="Docs">{docs}</td></tr>')

def endpoints_section(x):
    """First-screen structured core fields (ND-9), straight from ND-8's schema:
    the vendor's own official docs link, and its documented endpoints. `null`
    means not yet verified; `[]` means verified that there is nothing to list,
    with endpoints_note saying why -- never invented."""
    docs = x.get('official_docs_url')
    eps = x.get('endpoints')
    head = ('<section class="ap-card" id="api-surface"><h2>API surface</h2>'
             f'<dl class="ap-dl"><dt>Official docs</dt><dd>{ext(docs, docs) if docs else "Not yet confirmed"}</dd></dl>')
    if eps is None:
        body = '<p class="ap-note">Endpoints: not yet confirmed.</p>'
    elif len(eps) == 0:
        body = f'<p class="ap-note">Endpoints: {E(x.get("endpoints_note") or "no officially documented self-serve API.")}</p>'
    else:
        hdr = ''.join(f'<th scope="col">{c}</th>' for c in ('Endpoint', 'Does', 'Returns', 'Docs'))
        rows_ = ''.join(endpoint_row(e) for e in eps)
        body = f'<div class="ap-scroll"><table class="ap-table"><thead><tr>{hdr}</tr></thead><tbody>{rows_}</tbody></table></div>'
    return head + body + '</section>'

def shelved_notice(scope, note):
    """ND-9b: a visible flag on a hidden page's own body, saying why it's set
    aside -- the page is otherwise rendered exactly as a listed one (hidden is
    not deleted, so the facts below it still load)."""
    reason = note or ('SkeletonKey currently sets LLM-model APIs aside from its default catalog while it focuses on tool and data APIs for agents.'
                       if scope == 'llm' else 'This entry is currently set aside from the default catalog.')
    return (f'<section class="ap-card ap-shelved" id="shelved"><h2>Shelved</h2>'
            f'<p>{E(reason)} The page stays up and the data is kept here -- it is just left out of the API index, '
            f'search, llms.txt and sitemap by default.</p></section>')

def register_section(x):
    """Guidance (ND-9): registration happens on the person's own machine,
    through their own SkeletonKey install -- this website never collects,
    forwards or stores a key."""
    setup = f'Install SkeletonKey on your own machine (<a href="/#install">setup</a>: <code>npx -y @dormy/skeletonkey init</code>)'
    if x['status'] == 'no-public-api':
        body = (f'{setup}. This vendor publishes no self-serve API of its own to register for, so there is no vendor '
                 'key for SkeletonKey to hold here -- the aggregator listings below are the only programmatic path we found, '
                 'each billed through that gateway\'s own key, not yours.')
    else:
        body = (f'This page does not collect your key. {setup}, then let your agent find and register {E(x["name"])} '
                 'for you: it signs up on the vendor\'s own pages under your own account, sign-up codes and payment '
                 'stay with you, and the key it gets back is saved to your own local vault &mdash; never shown to an AI '
                 'assistant, and never sent to this site.')
    return f'<section class="ap-card ap-register" id="register"><h2>Register locally with SkeletonKey</h2><p>{body}</p></section>'

def vendor_body(x):
    meta = badge(x['status']) + (' <span class="ap-badge ap-shelved-badge">Shelved</span>' if x['visibility'] == 'hidden' else '')
    b = [f'<nav class="ap-crumb" aria-label="Breadcrumb"><a href="/apis/">API index</a> <span aria-hidden="true">/</span> {E(x["category"])}</nav>',
         f'<h1 class="ap-title">{E(x["name"])}</h1>', f'<p class="ap-meta">{meta} <span>Checked {E(x["checked_date"])}</span></p>']
    b.append(cost_section(x))
    if x['visibility'] == 'hidden': b.append(shelved_notice(x.get('collection_scope'), x.get('visibility_note')))
    if x.get('summary'): b.append(f'<p class="ap-lede">{E(x["summary"])}</p>')
    # ND-9: structured endpoint/docs data and the local-registration guidance
    # go first, so they are visible without scrolling into Routes.
    b.append(endpoints_section(x))
    b.append(register_section(x))
    if x['status'] == 'no-public-api':
        cats = ' and '.join(f'<a href="{CATS[c][1]}" rel="noopener">{CATS[c][0]}</a>' for c in [k for k, v in CATS.items() if v[0] in x['listed_by']])
        b.append(f'<section class="ap-card"><h2>No public API</h2><p>We found no self-serve developer API from this vendor. Programmatic access is offered through {cats or "an aggregator catalog"}, which collects the data for you.</p></section>')
    else:
        a = x.get('auth') or {}
        hdr = a.get('header') or ''
        if hdr.startswith('query:'): auth = f'Query parameter <code>{E(hdr[6:])}</code>'
        elif hdr: auth = f'<code>{E(hdr)}: {E((a.get("format") or "{key}"))}</code>'
        else: auth = 'Not confirmed'
        b.append('<section class="ap-card"><h2>Connect</h2><dl class="ap-dl">'
                 f'<dt>Base URL</dt><dd>{"<code>"+E(x.get("base_url"))+"</code>" if x.get("base_url") else "Not confirmed"}</dd>'
                 f'<dt>Auth</dt><dd>{E(a.get("type") or "unknown")} · {auth}</dd>'
                 f'<dt>Docs</dt><dd>{"<a href=\""+E(x["docs_url"])+"\" rel=\"noopener\">"+E(x["docs_url"])+"</a>" if x.get("docs_url") else "—"}</dd></dl></section>')
        s = x.get('signup') or {}
        b.append('<section class="ap-card"><h2>Sign up</h2><dl class="ap-dl">'
                 f'<dt>Method</dt><dd>{E(", ".join(s.get("methods") or []) or "Not confirmed")}</dd>'
                 f'<dt>Signup page</dt><dd>{"<a href=\""+E(s["url"])+"\" rel=\"noopener\">"+E(s["url"])+"</a>" if s.get("url") else "—"}</dd>'
                 f'<dt>Card required</dt><dd>{yn(s.get("requires_card"))}</dd><dt>Phone required</dt><dd>{yn(s.get("requires_phone"))}</dd>'
                 + (f'<dt>Other checks</dt><dd>{E(s["notes"])}</dd>' if s.get('notes') else '') + '</dl></section>')
        if x['status'] == 'verified':
            rows_ = ''.join(f'<tr><th scope="row">{E(p.get("name"))}</th><td data-label="Price">{E(p.get("price"))}</td><td data-label="Per">{E(p.get("period_or_unit"))}</td><td data-label="Notes">{E(p.get("note"))}</td></tr>' for p in x.get('plans') or [])
            b.append('<section class="ap-card"><h2>Pricing</h2><dl class="ap-dl">'
                     f'<dt>Model</dt><dd>{E(x.get("billing_model") or "—")}</dd><dt>Unit</dt><dd>{E(x.get("billing_unit") or "—")}</dd>'
                     f'<dt>Free tier</dt><dd>{yn(x.get("free_tier"))}{" · "+E(x["free_tier_note"]) if x.get("free_tier_note") else ""}</dd>'
                     f'<dt>Minimum top-up</dt><dd>{"$"+E(x["min_topup_usd"])+" USD" if x.get("min_topup_usd") is not None else "None stated"}</dd></dl>'
                     + (f'<div class="ap-scroll"><table class="ap-table"><thead><tr><th scope="col">Plan</th><th scope="col">Price</th><th scope="col">Per</th><th scope="col">Notes</th></tr></thead><tbody>{rows_}</tbody></table></div>' if rows_ else '')
                     + (f'<p class="ap-note">Prices as shown on the <a href="{E(x["pricing_url"])}" rel="noopener">vendor pricing page</a> on {E(x["checked_date"])}. Check there before you buy.</p>' if x.get('pricing_url') else '') + '</section>')
        else:
            why = 'This vendor sells through its sales team and publishes no prices.' if x['status'] == 'sales-only' else 'We could not confirm pricing on the vendor\'s own pages, so we show none.'
            b.append(f'<section class="ap-card"><h2>Pricing</h2><p>{why} We never show a price unless it was confirmed on the vendor\'s own pages.</p></section>')
    b.append(pricing_card(x))
    if x['listed_by']: b.append(f'<p class="ap-small">Listed in: {E(", ".join(x["listed_by"]))}.</p>')
    if x['sources']: b.append('<section class="ap-card"><h2>Sources</h2><ul class="ap-src">' + ''.join(f'<li><a href="{E(u)}" rel="noopener nofollow">{E(u)}</a></li>' for u in x['sources']) + '</ul></section>')
    # ND-9: aggregator routes are reference material, not the main path -- kept
    # last, after the vendor's own facts and sources.
    b.append(routes_section(x))
    return '\n'.join(c for c in b if c)

def agg_body(a):
    meta = ('<span class="ap-badge ap-shelved-badge">Shelved</span>' if a['visibility'] == 'hidden' else '')
    b = [f'<nav class="ap-crumb" aria-label="Breadcrumb"><a href="/apis/">API index</a> <span aria-hidden="true">/</span> <a href="/apis/aggregators/">Aggregators</a></nav>',
         f'<h1 class="ap-title">{E(a["name"])}</h1>',
         f'<p class="ap-meta">{meta} <span>Checked {E(a["checked_date"])}</span></p>']
    if a['visibility'] == 'hidden': b.append(shelved_notice(a.get('collection_scope'), a.get('visibility_note')))
    if a['what_it_is']: b.append(f'<p class="ap-lede">{E(a["what_it_is"])}</p>')
    # ND-9: a directory entry, not a recommended way to connect -- said up
    # front on every aggregator page, not only the ones whose own `what_it_is`
    # text happens to mention it.
    b.append('<section class="ap-card ap-caution"><h2>Before you route through this</h2>'
             '<p>SkeletonKey lists aggregator gateways as directory entries, not as a recommended access layer. '
             'A gateway holds one key that stands in for many vendors; keeping your own account and key with each '
             'vendor keeps you in control of your own data, limits and billing. '
             '<a href="/#install">Register locally with SkeletonKey</a> instead where you can &mdash; the details '
             'below are what we read on this gateway\'s own pages, for reference.</p></section>')
    if not a['verified']: b.append('<section class="ap-card"><h2>Not confirmed</h2><p>We could not read this gateway\'s own pages on the checked date, so nothing below is confirmed. Treat it as a lead.</p></section>')
    au = a['auth']
    hdr = au.get('header') or ''
    if hdr.startswith('query:'): auth = f'Query parameter <code>{E(hdr[6:])}</code>'
    elif hdr: auth = f'<code>{E(hdr)}: {E(au.get("format") or "{key}")}</code>'
    else: auth = 'No key (open endpoint)' if a['slug'] == 'agentic-market' else 'Not confirmed'
    b.append('<section class="ap-card"><h2>Connect</h2><dl class="ap-dl">'
             f'<dt>Site</dt><dd>{"<a href=\""+E(a["url"])+"\" rel=\"noopener\">"+E(a["url"])+"</a>" if a.get("url") else "—"}</dd>'
             f'<dt>API base URL</dt><dd>{"<code>"+E(a["api_base_url"])+"</code>" if a.get("api_base_url") else "Not confirmed"}</dd>'
             f'<dt>Auth</dt><dd>{auth}</dd>'
             f'<dt>Docs</dt><dd>{"<a href=\""+E(a["docs_url"])+"\" rel=\"noopener\">"+E(a["docs_url"])+"</a>" if a.get("docs_url") else "—"}</dd>'
             f'<dt>Catalog size claimed</dt><dd>{E(a["provider_count_claimed"] or "—")}</dd></dl></section>')
    s = a['signup']
    b.append('<section class="ap-card"><h2>Sign up</h2><dl class="ap-dl">'
             f'<dt>Methods</dt><dd>{E(", ".join(s["methods"])) if s["methods"] else "No account needed"}</dd>'
             f'<dt>Signup page</dt><dd>{"<a href=\""+E(s["url"])+"\" rel=\"noopener\">"+E(s["url"])+"</a>" if s.get("url") else "—"}</dd>'
             f'<dt>Card required</dt><dd>{yn(s["requires_card"])}</dd>'
             f'<dt>Free credit or trial</dt><dd>{E(a["free_credit"] or "None stated")}</dd></dl></section>')
    b.append('<section class="ap-card"><h2>Billing</h2><dl class="ap-dl">'
             f'<dt>Payment model</dt><dd>{E(", ".join(a["payment_model"]) or "—")}</dd>'
             f'<dt>How it bills</dt><dd>{E(a["billing_model"] or "Not confirmed")}</dd>'
             f'<dt>Payment methods</dt><dd>{E(", ".join(a["payment_methods"]) or "—")}</dd>'
             f'<dt>Fees stated</dt><dd>{E(a["fee_or_markup_policy"] or "None stated")}</dd>'
             f'<dt>Rate limits</dt><dd>{E(a["rate_limits"] or "None published")}</dd>'
             f'<dt>Pricing page</dt><dd>{"<a href=\""+E(a["pricing_url"])+"\" rel=\"noopener\">"+E(a["pricing_url"])+"</a>" if a.get("pricing_url") else "—"}</dd></dl></section>')
    if a['vendors']:
        # ND-9b: hidden LLM vendors are left off this list by default (listing
        # surface, same rule as the /apis/ index) -- noted as a count, not deleted;
        # their routes and apis.json's own vendor_count still carry them unfiltered.
        visible_v = [v for v in a['vendors'] if v['slug'] not in HIDDEN_SLUGS]
        hidden_n = len(a['vendors']) - len(visible_v)
        hidden_note = f' {hidden_n} more hidden LLM vendor{"" if hidden_n == 1 else "s"} routed here {"is" if hidden_n == 1 else "are"} not shown by default.' if hidden_n else ''
        if visible_v:
            li = ''.join(f'<li><a href="/apis/{E(v["slug"])}/"><span class="ap-name">{E(v["name"])}</span>'
                         f'<span class="ap-cat">{E(v["category"])}</span>'
                         f'<span class="ap-sum">{E(v["price_text"] or "No price confirmed")}'
                         f'{" · e.g. "+E(v["example_endpoint"]) if v.get("example_endpoint") else ""}</span></a></li>' for v in visible_v)
            b.append(f'<h2 class="ap-h2">Vendors routed through {E(a["name"])} ({len(visible_v)})</h2>'
                     f'<p class="ap-note">Prices are the cheapest listing we read on this gateway for that vendor on {E(a["checked_date"])}. Open a vendor page for the side-by-side route table.{hidden_note}</p>'
                     f'<ul class="ap-list">{li}</ul>')
        else:
            b.append(f'<section class="ap-card"><h2>Vendors routed through it</h2><p>{hidden_n} vendor{"" if hidden_n == 1 else "s"} routed here are hidden LLM entries, not shown by default.</p></section>')
    else:
        b.append(f'<section class="ap-card"><h2>Vendors routed through it</h2><p>None of the {len(rows)} vendors in our index were checked against this gateway.</p></section>')
    if a['sources']: b.append('<section class="ap-card"><h2>Sources</h2><ul class="ap-src">' + ''.join(f'<li><a href="{E(u)}" rel="noopener nofollow">{E(u)}</a></li>' for u in a['sources']) + '</ul></section>')
    return '\n'.join(b)

def agg_index_body(aggs_list):
    li = ''.join(f'<li><a href="/apis/aggregators/{E(a["slug"])}/"><span class="ap-name">{E(a["name"])}</span>'
                 f'<span class="ap-cat">{a["vendor_count"]} vendor{"" if a["vendor_count"] == 1 else "s"} routed'
                 f'{" · "+E(", ".join(a["payment_model"])) if a["payment_model"] else ""}</span>'
                 f'<span class="ap-sum">{E(brief(a["what_it_is"], 180))}</span></a></li>' for a in aggs_list)
    nv = sum(1 for a in aggs_list if a['verified'])
    return (f'<nav class="ap-crumb" aria-label="Breadcrumb"><a href="/apis/">API index</a> <span aria-hidden="true">/</span> Aggregators</nav>'
            f'<h1 class="ap-title">Aggregator gateways</h1>'
            f'<p class="ap-lede">{len(aggs_list)} gateways that resell or index other vendors\' APIs behind one account, one key and one balance. '
            f'{nv} checked on their own docs and pricing pages, {len(aggs_list)-nv} not checked. Each vendor page lists its routes side by side so you can see what a gateway gives up in coverage. '
            f'Machine-readable: <a href="/apis.json">/apis.json</a>.</p>'
            f'<p class="ap-note">These are directory entries, not a recommended way to connect: a gateway key stands in for many vendors at once. '
            f'<a href="/#install">Register locally with SkeletonKey</a> and keep your own account and key with each vendor where you can.</p>'
            f'<ul class="ap-list">{li}</ul>'
            f'<p class="ap-small">Payment model tokens come from our own reading of each gateway\'s billing pages: '
            f'<code>prepaid_credits</code>, <code>payg</code>, <code>subscription</code>, <code>x402</code>, <code>no_account</code>.</p>')

out = os.path.join(OUT_ROOT, 'apis'); shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
shutil.copy(os.path.join(ROOT, 'scripts', 'apis.css'), os.path.join(out, 'apis.css'))
# Every vendor's own page is generated, hidden or not: a direct URL keeps
# working, which is what makes "hidden" recoverable rather than deleted.
NOINDEX = '<meta name="robots" content="noindex">\n'
for x in ALL_ROWS:
    os.makedirs(os.path.join(out, x['slug']))
    open(os.path.join(out, x['slug'], 'index.html'), 'w').write(page(f'{x["name"]} API — SkeletonKey API index', (x.get('summary') or x['name'])[:155], f'/apis/{x["slug"]}/', vendor_body(x), extra_head=NOINDEX if x['visibility'] == 'hidden' else ''))
os.makedirs(os.path.join(out, 'aggregators'))
open(os.path.join(out, 'aggregators', 'index.html'), 'w').write(page('Aggregator gateways — SkeletonKey API index', f'{len(VISIBLE_AGGS)} API aggregator gateways compared on signup, payment, vendor key and coverage.', '/apis/aggregators/', agg_index_body(VISIBLE_AGGS)))
for a in aggs:
    os.makedirs(os.path.join(out, 'aggregators', a['slug']))
    open(os.path.join(out, 'aggregators', a['slug'], 'index.html'), 'w').write(
        page(f'{a["name"]} — aggregator gateway — SkeletonKey', (a['what_it_is'] or a['name'])[:155], f'/apis/aggregators/{a["slug"]}/', agg_body(a), extra_head=NOINDEX if a['visibility'] == 'hidden' else ''))

cats = sorted({x['category'] for x in rows})
cnt = {s: sum(x['status'] == s for x in rows) for s in STATUSES}
nrt = sum(len(x['routes']) for x in rows)
cost_counts = {g: sum((x.get('cost_badge') or 'gray') == g for x in rows) for g in ('green', 'red', 'gray')}
label_counts = {l: sum(x.get('cost_label') == l for x in rows) for l in ('FREE', 'PAYG', 'SUBS')}
# ND-18: default list order is FREE, then PAYG (none-gated before prepaid_min), then SUBS, then no
# label -- a separate, stable-sorted copy so every other use of `rows` keeps its alphabetical order.
list_rows = sorted(rows, key=cost_sort_key)
COST_OPTS = [('free', 'FREE'), ('payg', 'PAYG'), ('subs', 'SUBS')]
items = ''.join(f'<li class="ap-item" data-cat="{E(x["category"])}" data-status="{x["status"]}" data-cost="{(x.get("cost_label") or "").lower()}" data-q="{E((x["name"]+" "+(x.get("summary") or "")+" "+x["category"]).lower())}"><a href="/apis/{x["slug"]}/"><span class="ap-name">{E(x["name"])}</span><span class="ap-badges">{badge(x["status"])}{cost_pill(x)}</span><span class="ap-cat">{E(x["category"])}</span><span class="ap-sum">{E(x.get("summary") or "")}</span></a></li>' for x in list_rows)
body = f'''<h1 class="ap-title">API index</h1>
<p class="ap-lede">{len(rows)} APIs and data sources an agent might want, with auth, base URL, pricing and signup notes taken from each vendor's own docs and pricing pages. {cnt["sales-only"]} sales only, {cnt["no-public-api"]} with no public API. {label_counts["FREE"]} FREE, {label_counts["PAYG"]} PAYG, {label_counts["SUBS"]} SUBS. Machine-readable: <a href="/apis.json">/apis.json</a> and <a href="/llms.txt">/llms.txt</a>.</p>
<p class="ap-navline">Every vendor page also lists its <strong>routes</strong>: direct from the vendor, or through one of <a href="/apis/aggregators/">{len(aggs)} aggregator gateways</a> that already hold the key — {nrt} routes in all, compared on price, signup, payment, vendor key and coverage.</p>
<form class="ap-filters" role="search" onsubmit="return false">
  <label>Search <input id="ap-q" type="search" placeholder="e.g. search, email, weather" autocomplete="off"></label>
  <label>Category <select id="ap-cat"><option value="">All categories</option>{''.join(f'<option value="{E(c)}">{E(c)}</option>' for c in cats)}</select></label>
  <label>Status <select id="ap-st"><option value="">All statuses</option>{''.join(f'<option value="{s}">{STATUS_FILTER_LABEL[s]}</option>' for s in STATUSES if s in STATUS_FILTER_LABEL)}</select></label>
  <label>Cost <select id="ap-cost"><option value="">All</option>{''.join(f'<option value="{g}">{E(l)}</option>' for g, l in COST_OPTS)}</select></label>
</form>
<p class="ap-count" id="ap-count" aria-live="polite">{len(rows)} shown</p>
<ul class="ap-list" id="ap-list">{items}</ul>
<p class="ap-small">Prices change, so confirm on the vendor's site before you pay.</p>
<script>
(function(){{var q=document.getElementById('ap-q'),c=document.getElementById('ap-cat'),s=document.getElementById('ap-st'),v=document.getElementById('ap-cost'),n=document.getElementById('ap-count'),li=[].slice.call(document.querySelectorAll('.ap-item'));
var p=new URLSearchParams(location.search);q.value=p.get('q')||'';c.value=p.get('category')||'';s.value=p.get('status')||'';v.value=p.get('cost')||'';
function f(){{var t=q.value.trim().toLowerCase(),k=0;li.forEach(function(e){{var ok=(!t||e.dataset.q.indexOf(t)>-1)&&(!c.value||e.dataset.cat===c.value)&&(!s.value||e.dataset.status===s.value)&&(!v.value||e.dataset.cost===v.value);e.hidden=!ok;if(ok)k++}});n.textContent=k+' shown'}}
[q,c,s,v].forEach(function(e){{e.addEventListener('input',f)}});f();}})();
</script>'''
open(os.path.join(out, 'index.html'), 'w').write(page('API index — SkeletonKey', f'{len(rows)} APIs with auth, base URLs, pricing and signup details.', '/apis/', body))

by_src = {}
for x in rows:
    for rt in x['routes']: by_src[rt['source_slug']] = by_src.get(rt['source_slug'], 0) + 1
vrt = sum(1 for x in rows for rt in x['routes'] if rt['verified'])
json.dump({'name': 'SkeletonKey API index', 'url': f'{SITE}/apis/', 'generated': str(OVERLAY.get('checked')), 'count': len(rows), 'counts': cnt,
           'cost_badge_counts': cost_counts,
           'cost_label_counts': label_counts,
           'hidden_count': len(hidden_rows),
           'route_counts': {'total': nrt, 'verified': vrt, 'by_source': dict(sorted(by_src.items(), key=lambda kv: -kv[1]))},
           'note': 'Rows checked against the vendor\'s own pages on checked_date carry prices; rows we could not check '
                   'there carry none. hidden_count rows (collection_scope "llm", set aside 2026-11-24) are excluded from '
                   'count/counts and from the /apis/ index and llms.txt, but stay in `apis` below and keep their own page.',
           'schema': f'{SITE}/llms.txt', 'apis': ALL_ROWS, 'aggregators': aggs},
          open(os.path.join(OUT_ROOT, 'apis.json'), 'w'), indent=1, ensure_ascii=False, default=str)

L = ['# SkeletonKey API index', '', f'> {len(rows)} APIs and data sources for agents, with auth header, base URL, pricing and signup facts checked against each vendor\'s own pages, plus {nrt} routes ({vrt} checked) to reach them: direct from the vendor or through one of {len(VISIBLE_AGGS)} aggregator gateways. Full data: {SITE}/apis.json', '',
     'Status: `verified` = pricing and auth read on the vendor\'s own site; `unverified` = not checked, no prices shown; `sales-only` = no public prices; `no-public-api` = reachable only through an aggregator catalog.', '',
     '## Quick start', '',
     '1. Install: `npx -y @dormy/skeletonkey init`. No SkeletonKey account and no server; this sets a local passphrase and registers the MCP server and skill for Claude Code and Codex.',
     f'2. Find an API: browse {SITE}/directory/ yourself, or let your agent search the same local index with `find_api("web scraping")`.',
     '3. Create the vendor account (coming in v0.4): `skeletonkey signup start <vendor>`, finish the captcha/terms/payment yourself in the browser, then `skeletonkey signup complete <vendor> --account <name>` (the key is entered through a hidden input and stored in your vault). Already have a key: `skeletonkey account add <name> --vendor <id> --store-key --domain <d>`.',
     '4. Use it: calls go through the local proxy, which injects the key at request time. The agent never sees it.',
     '5. Weekly monitoring (coming in v0.4): `skeletonkey monitor run` sends a system notification on anomalies and writes a redacted report, read back with `skeletonkey monitor report --latest`.', '',
     '## /apis.json schema', '',
     'Top level: `name`, `url`, `generated`, `count`, `counts` (per status), `cost_badge_counts`, `cost_label_counts`, `route_counts` {`total`, `verified`, `by_source`}, `note`, `apis` (array of vendors), `aggregators` (array of gateway profiles).', '',
     'Vendor object: `slug`, `name`, `category`, `status`, `summary`, `checked_date`, `listed_by`, `docs_url`, `page`, `sources`. When status is not no-public-api it also has `base_url`, `auth` {`type`,`header`,`format`} and `signup` {`methods`,`url`,`requires_card`,`requires_phone`,`notes`}. Checked vendors (`status` `verified`) add `billing_model`, `billing_unit`, `free_tier`, `free_tier_note`, `min_topup_usd`, `plans[]` {`name`,`price`,`period_or_unit`,`note`} and `pricing_url`. Every vendor has `routes[]`, `when_to_pick[]`, `pricing` (ND-8 block, or null), a `cost_badge` and a `cost_label`.', '',
     '`cost_badge` (`green`|`red`|`gray`) tells you at a glance whether the API is reachable free or pay-as-you-go (`green`), forces a recurring subscription or sales call (`red`), or was never gate-checked (`gray`, the default when absent). It is derived from `pricing.api_access_gate` (`none`|`prepaid_min` -> green; `subscription_required`|`contact_sales` -> red; `unknown`|null -> gray) and is never hand-filled. `cost_label` (`FREE`|`PAYG`|`SUBS`|null) is the short cost pill shown on list and detail pages, derived from `cost_badge` plus `pricing`: `FREE` and `PAYG` need no subscription (`PAYG` may carry a prepaid minimum top-up); `SUBS` needs a recurring subscription for API access, in which case `alternatives[]`/`alternatives_note` point to a no-subscription route; `null` means the row has no confirmed-enough signal to label (a `gray` `cost_badge`, or access sold only through a sales call). `pricing` also carries `min_monthly_usd` (the subscription floor, only set when the gate is `subscription_required`), `min_prepay_usd` (the prepaid floor, only set when the gate is `prepaid_min`), and `gate_source_url` (the vendor pricing page the gate was read from). On a `SUBS` vendor, `alternatives[]` lists cheaper routes to the same capability -- each `{vendor_id, name, page, why, access_gate}` (`name`/`page` resolved to a vendor or aggregator page) -- or `alternatives_note` explains why there is nowhere else to go.', '',
     'Route object (`routes[]`, first element is always the direct vendor route, then one per aggregator listing):', '',
     '- `kind`: `direct` or `aggregator`.',
     '- `source_slug`, `source_name`: `direct` for the vendor itself, otherwise the aggregator slug (see below) and its name.',
     '- `link` / `source_url`: the exact page the figures were read on. Aggregator routes also carry `aggregator_page`.',
     '- `price`: {`usd`, `unit`, `text` (as listed), `per_call_usd_normalized`, `normalized_basis`}. `per_call_usd_normalized` is `usd` when the unit is per call/run/request (`normalized_basis` `per_call`), `usd` when the unit is per result (`per_result`, so cost per call depends on results returned), `usd/1000` when the unit is per 1,000 of something (`per_1k_unit`), and null for any other unit — monthly plans, per-token and per-second prices are not normalized. Direct prices are the lowest per-call rate derivable from the vendor\'s own pricing page.',
     '- `signup`: {`methods`, `requires_card`, `requires_phone`, `sales_call`, `kyc_or_captcha`}. `sales_call` is true for direct routes sold only through a sales team.',
     '- `payment_model`: for direct routes the vendor\'s billing model string; for aggregator routes a list of normalized tokens — `prepaid_credits`, `payg`, `subscription`, `x402`, `no_account`.',
     '- `payment_methods`: list, from the aggregator profile (empty for direct routes).',
     '- `vendor_key_needed`: true for direct routes, false for gateways that bill you themselves, null where we did not confirm it (Apify Store and RapidAPI listings).',
     '- `free_tier`: {`available`, `note`}. Direct routes take both from the vendor row; aggregator routes set `available` true only when the profile states a free signup credit, and `note` is that statement.',
     '- `rate_limits`: published limit as stated in our profile notes, else null.',
     '- `coverage`: {`endpoints_exposed` (`"all"` for a direct route, an integer where a gateway\'s endpoint count was counted, else null), `example_endpoint`, `note` (what we saw on the listing)}.',
     '- `verified`: whether a price was actually read on that route; `verified_at`: the date it was read.', '',
     '`when_to_pick[]`: 2-4 short factual sentences generated from the route fields above (card and signup differences, endpoint coverage, listed prices side by side, x402, routes with no confirmed price, vendor key). They state prices but never compare them in words.', '',
     'Aggregator object (`aggregators[]`): `slug`, `name`, `url`, `what_it_is`, `api_base_url`, `auth` {`header`,`format`}, `signup` {`methods`,`url`,`requires_card`}, `billing_model`, `payment_model` (same tokens as above), `payment_methods`, `fee_or_markup_policy`, `free_credit`, `rate_limits`, `provider_count_claimed`, `docs_url`, `pricing_url`, `verified`, `checked_date`, `sources`, `page`, `vendor_count`, `vendors[]` {`slug`,`name`,`category`,`page`,`price_text`,`example_endpoint`,`endpoints_exposed`,`verified`,`listing_url`}.', '',
     '## Aggregator gateways', '',
     f'- [All gateways]({SITE}/apis/aggregators/): compare signup, payment model, vendor key and coverage.']
for a in VISIBLE_AGGS:
    L.append(f'- [{a["name"]}]({a["page"]}): {"checked" if a["verified"] else "not checked"}, {a["vendor_count"]} vendors routed. {brief(a["what_it_is"], 160)}')
L.append('')
for c in cats:
    L.append(f'## {c}')
    for x in rows:
        if x['category'] == c:
            bit = llms_cost_bit(x)
            L.append(f'- [{x["name"]}]({x["page"]}): {STATUS_PROSE[x["status"]]}. {(x.get("summary") or "").strip()}' + (f' ({bit})' if bit else ''))
    L.append('')
open(os.path.join(OUT_ROOT, 'llms.txt'), 'w').write('\n'.join(L))
print('pages', len(rows), cnt)
print('aggregator pages', len(aggs), {a['slug']: a['vendor_count'] for a in aggs})
print('routes total', nrt, '| verified', vrt, '| by source', dict(sorted(by_src.items(), key=lambda kv: -kv[1])))

# The pages just written change the URL set, so refresh the sitemap with them.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_sitemap
print(f'sitemap: {len(build_sitemap.write_sitemap(OUT_ROOT))} urls -> {os.path.join(OUT_ROOT, "sitemap.xml")}')
