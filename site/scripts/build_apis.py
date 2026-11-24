"""Generate /apis/, /apis/<slug>/, /apis/aggregators/, /apis.json and /llms.txt from the staging index.
    python3 scripts/build_apis.py [index.yaml]
Routes and aggregator profiles are read from <index dir>/routes/.
"""
import sys, os, re, json, html, shutil, yaml
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
SRC = sys.argv[1] if len(sys.argv) > 1 else '/workspace/skeletonkey-index-research/index.yaml'
RDIR = os.path.join(os.path.dirname(os.path.abspath(SRC)), 'routes')
SITE = 'https://skeletonkey.run'
TODAY = '2026-10-26'
doc = yaml.safe_load(open(SRC))
E = lambda s: html.escape('' if s is None else str(s))
home = open(os.path.join(PUB, 'index.html')).read()
HEAD = re.search(r'<header class="site-head">.*?</header>', home, re.S).group(0).replace(' aria-current="page"', '')
HEAD = HEAD.replace('<a class="head-link"', '<a class="head-link head-apis" href="/apis/">API index</a>\n    <a class="head-link"', 1)
FOOT = re.search(r'<footer class="site-foot">.*?</footer>', home, re.S).group(0)
CATS = {'glasser': ('Glasser', 'https://glasser.ai'), 'monid': ('Monid', 'https://monid.ai'), 'flatkey': ('Flatkey', 'https://flatkey.ai')}

AGGS = json.load(open(os.path.join(RDIR, 'aggregators.json')))
AGG = {a['slug']: a for a in AGGS}
SRC_MAP = {'glasser': 'glasser', 'monid': 'monid', 'flatkey': 'flatkey', 'apify': 'apify-store', 'rapidapi': 'rapidapi'}
KEY_UNKNOWN = {'apify-store', 'rapidapi'}   # third-party listings: we did not confirm whether a vendor key is needed

def status(r):
    if r.get('no_public_api'): return 'no-public-api'
    if r.get('sales_only'): return 'sales-only'
    return 'verified' if r.get('verified') else 'unverified'
LABEL = {'verified': 'Verified', 'unverified': 'Unverified', 'sales-only': 'Sales only', 'no-public-api': 'No public API'}

def catalogs(r):
    s = r.get('seen_in')
    return {'both': ['glasser', 'monid'], 'glasser': ['glasser'], 'monid': ['monid'], 'existing': ['flatkey']}.get(s, [])

def clean_note(t):
    if not t: return t
    t = re.sub(r",?\s*(each\s+)?(tagged|with)\s+(&#x27;|['\u2018\u2019\"])?(0|zero|no)\s+markup(&#x27;|['\u2018\u2019\"])?", "", t, flags=re.I)
    t = re.sub(r"\s*(&#x27;|['\"])?(0|zero|no)\s+markup(&#x27;|['\"])?", "", t, flags=re.I)
    t = re.sub(r",\s*with cheaper per-comment events listed lower down", ", with per-comment events also listed", t)
    return t

def slug(r): return re.sub(r'[^a-z0-9-]', '-', r['id'].lower())

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

def routes_for(r, st):
    out = [direct_route(r, st)]
    f = os.path.join(RDIR, r['id'] + '.json')
    if os.path.isfile(f):
        for rt in (json.load(open(f)).get('routes') or []): out.append(agg_route(rt))
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
                 else f"{lst}; the vendor publishes no self-serve API we could verify.")
    priced = [x for x in routes if x['price']['text']]
    if len(priced) > 1:
        B.append('Listed prices: ' + '; '.join(f"direct {x['price']['text']}" if x['kind'] == 'direct' else f"{x['source_name']} {x['price']['text']}" for x in priced) + '.')
    uv = [a for a in A if not a['verified']]
    if uv:
        w, v = rw(uv)
        B.append(f"The {nm(uv)} {w} {v} listed unverified: no price was readable there on {date}.")
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
    # ND-8 structured core fields: pass through as-is when the source row has
    # them, null when it doesn't. A structured `auth` dict is a superset of
    # the legacy {type, header, format} shape (it adds docs_url), so it
    # replaces the legacy object built above; otherwise keep that legacy
    # object when present.
    out['auth'] = r.get('auth') if isinstance(r.get('auth'), dict) else out.get('auth')
    for k in ('official_docs_url', 'pricing', 'endpoints', 'endpoints_note'):
        out[k] = r.get(k)
    return out

rows = sorted((public(r) for r in doc['entries'] if r.get('conflicts_or_notes') != 'not yet researched'), key=lambda x: x['name'].lower())

# ---------- aggregator profiles ----------
VEND = {a['slug']: [] for a in AGGS}
for x in rows:
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
            'page': f'{SITE}/apis/aggregators/{a["slug"]}/', 'vendor_count': len(v), 'vendors': v}

aggs = [agg_public(a) for a in sorted(AGGS, key=lambda a: (-len(VEND.get(a['slug'], [])), a['name'].lower()))]

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
<link rel="stylesheet" href="/styles.css?v=4">
<link rel="stylesheet" href="/apis/apis.css?v=2">
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

def badge(st): return f'<span class="ap-badge ap-{st}">{LABEL[st]}</span>'
def vbadge(v): return f'<span class="ap-badge ap-verified">Verified</span>' if v else '<span class="ap-badge ap-unverified">Unverified</span>'
def yn(v): return '—' if v is None else ('Yes' if v else 'No')
def ext(u, t): return f'<a href="{E(u)}" rel="noopener nofollow">{E(t)}</a>' if u else E(t)

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
    return (f'<tr{"" if rt["verified"] else " class=\'ap-r-unver\'"}><th scope="row">{head}</th>'
            f'<td data-label="Price">{price}</td><td data-label="Signup">{signup}</td>'
            f'<td data-label="Payment">{E(pay) if pay else "—"}</td>'
            f'<td data-label="Vendor key">{"Unknown" if rt["vendor_key_needed"] is None else yn(rt["vendor_key_needed"])}</td>'
            f'<td data-label="Free tier">{yn(ft["available"])}</td>'
            f'<td data-label="Coverage">{cov}</td>'
            f'<td data-label="Verified">{vbadge(rt["verified"])}</td></tr>')

def routes_section(x):
    rts = x['routes']
    if len(rts) < 2: return ''
    hdr = ''.join(f'<th scope="col">{c}</th>' for c in ('Route', 'Price', 'Signup', 'Payment', 'Vendor key', 'Free tier', 'Coverage', 'Verified'))
    body = ''.join(route_row(rt) for rt in rts)
    notes = []
    for rt in rts:
        bits = [rt['coverage']['note']] if rt['coverage']['note'] else []
        if rt['free_tier']['note'] and rt['kind'] == 'aggregator': bits.append(f'Free credit or trial: {rt["free_tier"]["note"]}')
        if bits:
            label = 'Direct' if rt['kind'] == 'direct' else rt['source_name']
            notes.append(f'<dt>{E(label)}</dt><dd>{E(" ".join(bits))}</dd>')
    pick = ''.join(f'<li>{E(b)}</li>' for b in x['when_to_pick'])
    return ('<section class="ap-card" id="routes"><h2>Routes</h2>'
            f'<p class="ap-note">Ways to reach this data: direct from the vendor, or through an <a href="/apis/aggregators/">aggregator gateway</a> that already holds the key. '
            f'Every figure here is ours, read on the checked date; unverified routes carry no confirmed price.</p>'
            f'<div class="ap-scroll"><table class="ap-table ap-routes"><thead><tr>{hdr}</tr></thead><tbody>{body}</tbody></table></div>'
            + (f'<h3>When to pick which</h3><ul class="ap-pick">{pick}</ul>' if pick else '')
            + (f'<h3>Route notes</h3><dl class="ap-dl ap-rnotes">{"".join(notes)}</dl>' if notes else '')
            + '</section>')

def vendor_body(x):
    b = [f'<nav class="ap-crumb" aria-label="Breadcrumb"><a href="/apis/">API index</a> <span aria-hidden="true">/</span> {E(x["category"])}</nav>',
         f'<h1 class="ap-title">{E(x["name"])}</h1>', f'<p class="ap-meta">{badge(x["status"])} <span>Checked {E(x["checked_date"])}</span></p>']
    if x.get('summary'): b.append(f'<p class="ap-lede">{E(x["summary"])}</p>')
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
            b.append(f'<section class="ap-card"><h2>Pricing</h2><p>{why} Unverified rows never show a price.</p></section>')
    b.append(routes_section(x))
    if x['listed_by']: b.append(f'<p class="ap-small">Listed in: {E(", ".join(x["listed_by"]))}.</p>')
    if x['sources']: b.append('<section class="ap-card"><h2>Sources</h2><ul class="ap-src">' + ''.join(f'<li><a href="{E(u)}" rel="noopener nofollow">{E(u)}</a></li>' for u in x['sources']) + '</ul></section>')
    return '\n'.join(c for c in b if c)

def agg_body(a):
    b = [f'<nav class="ap-crumb" aria-label="Breadcrumb"><a href="/apis/">API index</a> <span aria-hidden="true">/</span> <a href="/apis/aggregators/">Aggregators</a></nav>',
         f'<h1 class="ap-title">{E(a["name"])}</h1>',
         f'<p class="ap-meta">{vbadge(a["verified"])} <span>Checked {E(a["checked_date"])}</span></p>']
    if a['what_it_is']: b.append(f'<p class="ap-lede">{E(a["what_it_is"])}</p>')
    if not a['verified']: b.append('<section class="ap-card"><h2>Unverified</h2><p>We could not read this gateway\'s own pages on the checked date, so nothing below is confirmed. Treat it as a lead.</p></section>')
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
        li = ''.join(f'<li><a href="/apis/{E(v["slug"])}/"><span class="ap-name">{E(v["name"])}</span>{vbadge(v["verified"])}'
                     f'<span class="ap-cat">{E(v["category"])}</span>'
                     f'<span class="ap-sum">{E(v["price_text"] or "No price confirmed")}'
                     f'{" · e.g. "+E(v["example_endpoint"]) if v.get("example_endpoint") else ""}</span></a></li>' for v in a['vendors'])
        b.append(f'<h2 class="ap-h2">Vendors routed through {E(a["name"])} ({a["vendor_count"]})</h2>'
                 f'<p class="ap-note">Prices are the cheapest listing we read on this gateway for that vendor on {E(a["checked_date"])}. Open a vendor page for the side-by-side route table.</p>'
                 f'<ul class="ap-list">{li}</ul>')
    else:
        b.append(f'<section class="ap-card"><h2>Vendors routed through it</h2><p>None of the {len(rows)} vendors in our index were checked against this gateway.</p></section>')
    if a['sources']: b.append('<section class="ap-card"><h2>Sources</h2><ul class="ap-src">' + ''.join(f'<li><a href="{E(u)}" rel="noopener nofollow">{E(u)}</a></li>' for u in a['sources']) + '</ul></section>')
    return '\n'.join(b)

def agg_index_body():
    li = ''.join(f'<li><a href="/apis/aggregators/{E(a["slug"])}/"><span class="ap-name">{E(a["name"])}</span>{vbadge(a["verified"])}'
                 f'<span class="ap-cat">{a["vendor_count"]} vendor{"" if a["vendor_count"] == 1 else "s"} routed'
                 f'{" · "+E(", ".join(a["payment_model"])) if a["payment_model"] else ""}</span>'
                 f'<span class="ap-sum">{E(brief(a["what_it_is"], 180))}</span></a></li>' for a in aggs)
    nv = sum(1 for a in aggs if a['verified'])
    return (f'<nav class="ap-crumb" aria-label="Breadcrumb"><a href="/apis/">API index</a> <span aria-hidden="true">/</span> Aggregators</nav>'
            f'<h1 class="ap-title">Aggregator gateways</h1>'
            f'<p class="ap-lede">{len(aggs)} gateways that resell or index other vendors\' APIs behind one account, one key and one balance. '
            f'{nv} verified on their own docs and pricing pages, {len(aggs)-nv} unverified. Each vendor page lists its routes side by side so you can see what a gateway gives up in coverage. '
            f'Machine-readable: <a href="/apis.json">/apis.json</a>.</p>'
            f'<ul class="ap-list">{li}</ul>'
            f'<p class="ap-small">Payment model tokens come from our own reading of each gateway\'s billing pages: '
            f'<code>prepaid_credits</code>, <code>payg</code>, <code>subscription</code>, <code>x402</code>, <code>no_account</code>.</p>')

out = os.path.join(PUB, 'apis'); shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
shutil.copy(os.path.join(ROOT, 'scripts', 'apis.css'), os.path.join(out, 'apis.css'))
for x in rows:
    os.makedirs(os.path.join(out, x['slug']))
    open(os.path.join(out, x['slug'], 'index.html'), 'w').write(page(f'{x["name"]} API — SkeletonKey API index', (x.get('summary') or x['name'])[:155], f'/apis/{x["slug"]}/', vendor_body(x)))
os.makedirs(os.path.join(out, 'aggregators'))
open(os.path.join(out, 'aggregators', 'index.html'), 'w').write(page('Aggregator gateways — SkeletonKey API index', f'{len(aggs)} API aggregator gateways compared on signup, payment, vendor key and coverage.', '/apis/aggregators/', agg_index_body()))
for a in aggs:
    os.makedirs(os.path.join(out, 'aggregators', a['slug']))
    open(os.path.join(out, 'aggregators', a['slug'], 'index.html'), 'w').write(
        page(f'{a["name"]} — aggregator gateway — SkeletonKey', (a['what_it_is'] or a['name'])[:155], f'/apis/aggregators/{a["slug"]}/', agg_body(a)))

cats = sorted({x['category'] for x in rows})
cnt = {s: sum(x['status'] == s for x in rows) for s in LABEL}
nrt = sum(len(x['routes']) for x in rows)
items = ''.join(f'<li class="ap-item" data-cat="{E(x["category"])}" data-status="{x["status"]}" data-q="{E((x["name"]+" "+(x.get("summary") or "")+" "+x["category"]).lower())}"><a href="/apis/{x["slug"]}/"><span class="ap-name">{E(x["name"])}</span>{badge(x["status"])}<span class="ap-cat">{E(x["category"])}</span><span class="ap-sum">{E(x.get("summary") or "")}</span></a></li>' for x in rows)
body = f'''<h1 class="ap-title">API index</h1>
<p class="ap-lede">{len(rows)} APIs and data sources an agent might want, each checked against the vendor's own docs and pricing pages. {cnt["verified"]} verified, {cnt["unverified"]} unverified, {cnt["sales-only"]} sales only, {cnt["no-public-api"]} with no public API. Machine-readable: <a href="/apis.json">/apis.json</a> and <a href="/llms.txt">/llms.txt</a>.</p>
<p class="ap-navline">Every vendor page also lists its <strong>routes</strong>: direct from the vendor, or through one of <a href="/apis/aggregators/">{len(aggs)} aggregator gateways</a> that already hold the key — {nrt} routes in all, compared on price, signup, payment, vendor key and coverage.</p>
<form class="ap-filters" role="search" onsubmit="return false">
  <label>Search <input id="ap-q" type="search" placeholder="e.g. search, email, weather" autocomplete="off"></label>
  <label>Category <select id="ap-cat"><option value="">All categories</option>{''.join(f'<option value="{E(c)}">{E(c)}</option>' for c in cats)}</select></label>
  <label>Status <select id="ap-st"><option value="">All statuses</option>{''.join(f'<option value="{s}">{l}</option>' for s, l in LABEL.items())}</select></label>
</form>
<p class="ap-count" id="ap-count" aria-live="polite">{len(rows)} shown</p>
<ul class="ap-list" id="ap-list">{items}</ul>
<p class="ap-small">Verified means pricing and auth were read on the vendor's own pages on the checked date. Prices change, so confirm on the vendor's site before you pay.</p>
<script>
(function(){{var q=document.getElementById('ap-q'),c=document.getElementById('ap-cat'),s=document.getElementById('ap-st'),n=document.getElementById('ap-count'),li=[].slice.call(document.querySelectorAll('.ap-item'));
var p=new URLSearchParams(location.search);q.value=p.get('q')||'';c.value=p.get('category')||'';s.value=p.get('status')||'';
function f(){{var t=q.value.trim().toLowerCase(),k=0;li.forEach(function(e){{var ok=(!t||e.dataset.q.indexOf(t)>-1)&&(!c.value||e.dataset.cat===c.value)&&(!s.value||e.dataset.status===s.value);e.hidden=!ok;if(ok)k++}});n.textContent=k+' shown'}}
[q,c,s].forEach(function(e){{e.addEventListener('input',f)}});f();}})();
</script>'''
open(os.path.join(out, 'index.html'), 'w').write(page('API index — SkeletonKey', f'{len(rows)} APIs with verified auth, base URLs, pricing and signup details.', '/apis/', body))

by_src = {}
for x in rows:
    for rt in x['routes']: by_src[rt['source_slug']] = by_src.get(rt['source_slug'], 0) + 1
vrt = sum(1 for x in rows for rt in x['routes'] if rt['verified'])
json.dump({'name': 'SkeletonKey API index', 'url': f'{SITE}/apis/', 'generated': str(doc.get('checked_date')), 'count': len(rows), 'counts': cnt,
           'route_counts': {'total': nrt, 'verified': vrt, 'by_source': dict(sorted(by_src.items(), key=lambda kv: -kv[1]))},
           'note': 'Verified rows were read on the vendor\'s own pages on checked_date. Unverified rows carry no prices.',
           'schema': f'{SITE}/llms.txt', 'apis': rows, 'aggregators': aggs},
          open(os.path.join(PUB, 'apis.json'), 'w'), indent=1, ensure_ascii=False, default=str)

L = ['# SkeletonKey API index', '', f'> {len(rows)} APIs and data sources for agents, with auth header, base URL, pricing and signup facts checked against each vendor\'s own pages, plus {nrt} routes ({vrt} verified) to reach them: direct from the vendor or through one of {len(aggs)} aggregator gateways. Full data: {SITE}/apis.json', '',
     'Status: verified = pricing and auth read on the vendor site; unverified = not confirmed, no prices shown; sales-only = no public prices; no-public-api = reachable only through an aggregator catalog.', '',
     '## /apis.json schema', '',
     'Top level: `name`, `url`, `generated`, `count`, `counts` (per status), `route_counts` {`total`, `verified`, `by_source`}, `note`, `apis` (array of vendors), `aggregators` (array of gateway profiles).', '',
     'Vendor object: `slug`, `name`, `category`, `status`, `summary`, `checked_date`, `listed_by`, `docs_url`, `page`, `sources`. When status is not no-public-api it also has `base_url`, `auth` {`type`,`header`,`format`} and `signup` {`methods`,`url`,`requires_card`,`requires_phone`,`notes`}. Verified vendors add `billing_model`, `billing_unit`, `free_tier`, `free_tier_note`, `min_topup_usd`, `plans[]` {`name`,`price`,`period_or_unit`,`note`} and `pricing_url`. Every vendor has `routes[]` and `when_to_pick[]`.', '',
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
     '`when_to_pick[]`: 2-4 short factual sentences generated from the route fields above (card and signup differences, endpoint coverage, listed prices side by side, x402, unverified routes, vendor key). They state prices but never compare them in words.', '',
     'Aggregator object (`aggregators[]`): `slug`, `name`, `url`, `what_it_is`, `api_base_url`, `auth` {`header`,`format`}, `signup` {`methods`,`url`,`requires_card`}, `billing_model`, `payment_model` (same tokens as above), `payment_methods`, `fee_or_markup_policy`, `free_credit`, `rate_limits`, `provider_count_claimed`, `docs_url`, `pricing_url`, `verified`, `checked_date`, `sources`, `page`, `vendor_count`, `vendors[]` {`slug`,`name`,`category`,`page`,`price_text`,`example_endpoint`,`endpoints_exposed`,`verified`,`listing_url`}.', '',
     '## Aggregator gateways', '',
     f'- [All gateways]({SITE}/apis/aggregators/): compare signup, payment model, vendor key and coverage.']
for a in aggs:
    L.append(f'- [{a["name"]}]({a["page"]}): {"verified" if a["verified"] else "unverified"}, {a["vendor_count"]} vendors routed. {brief(a["what_it_is"], 160)}')
L.append('')
for c in cats:
    L.append(f'## {c}')
    for x in rows:
        if x['category'] == c:
            L.append(f'- [{x["name"]}]({x["page"]}): {x["status"]}. {(x.get("summary") or "").strip()}')
    L.append('')
open(os.path.join(PUB, 'llms.txt'), 'w').write('\n'.join(L))
print('pages', len(rows), cnt)
print('aggregator pages', len(aggs), {a['slug']: a['vendor_count'] for a in aggs})
print('routes total', nrt, '| verified', vrt, '| by source', dict(sorted(by_src.items(), key=lambda kv: -kv[1])))

# The pages just written change the URL set, so refresh the sitemap with them.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_sitemap
print(f'sitemap: {len(build_sitemap.write_sitemap())} urls -> public/sitemap.xml')
