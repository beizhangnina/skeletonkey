#!/usr/bin/env python3
"""Build data/apis/<category>.yaml from the cached aggregator catalogs.

Sources (all public, unauthenticated - see ../README.md for method):
  raw/glasser_public_catalog.json   GET https://api.glasser.ai/public/catalog
  raw/monid_providers.json          GET https://api.monid.ai/public/v1/providers
  raw/monid_endpoints.json          GET https://api.monid.ai/public/v1/endpoints
  raw/monid_resources.json          GET https://api.monid.ai/public/v1/resources
  raw/flatkey_models_extracted.json parsed from https://flatkey.ai/models

Everything below `main()` only runs from the CLI (`if __name__ == '__main__'`)
and needs `raw/`. Everything above it -- the row serialiser (`emit_row`) and
the ND-8 field-preservation merge (`merge_preserved`) -- has no raw/
dependency, so it can be imported and tested on its own.
"""
import datetime, json, os, collections
import curated
import validate

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'raw')
OUT = os.path.join(HERE, '..')
CHECKED = '2026-10-24'

def r(p): return json.load(open(os.path.join(RAW, p)))

# ---- slug normalisation across catalogs -------------------------------------
ALIAS = {
 'levels.fyi': 'levels-fyi', 'cars.com': 'cars-com', 'bid.cars': 'bid-cars',
 'hunterio': 'hunter', 'context.dev': 'context-dev', 'homes.com': 'homes-com',
 'web3.career': 'web3-career', 'censusdata.xyz': 'censusdata-xyz',
 'gemini': 'google-gemini', 'alibaba': 'alibaba-cloud',
}
# Monid names a provider by one of its endpoint hostnames, so a slug is often a
# subdomain of the vendor's own domain. Map the registrable domain to our id and
# ignore whatever subdomain sits in front of it.
HOST_PID = {
 'blockrun.ai': 'blockrun', 'strale.io': 'strale', 'itsgloria.ai': 'gloria',
 'browserbase.com': 'browserbase', 'quicknode.com': 'quicknode',
 'emc2ai.io': 'emc2ai', 'capminal.ai': 'capminal', 'kadec0.xyz': 'kadec0',
}


def monid_pid(slug):
    """Monid's provider slug -> our id, or the slug itself when unmapped."""
    if slug in ALIAS:
        return ALIAS[slug]
    labels = slug.split('.')
    for i in range(len(labels) - 1):
        pid = HOST_PID.get('.'.join(labels[i:]))
        if pid:
            return pid
    return slug
# glasser's "alibaba" is the Alibaba.com marketplace, monid's is Alibaba Cloud;
# glasser's "census" is the Census Bureau itself, not the censusdata.xyz wrapper.
G_ALIAS = {'alibaba': 'alibaba-com', 'census': 'us-census-bureau'}

FK_VENDOR = {
 'Anthropic': 'anthropic', 'OpenAI': 'openai', 'Google': 'google-gemini',
 'Alibaba': 'alibaba-cloud', 'Alibaba (China)': 'alibaba-cloud', 'Qwen': 'alibaba-cloud',
 'DeepSeek': 'deepseek', 'Z.ai': 'zhipu-ai', 'Zhipu AI': 'zhipu-ai',
 'Moonshot AI': 'moonshot-ai', 'MiniMax': 'minimax', 'Minimax': 'minimax',
 'xAI': 'xai', 'Macaron': 'macaron', 'Sonilo': 'sonilo', 'ByteDance': 'bytedance',
 'TypeSafe AI': 'typesafe',
}
# upstream inference routes flatkey lists in its Providers facet
FK_ROUTE = {
 'Amazon Bedrock': 'amazon-bedrock', 'Claude Platform on AWS': 'amazon-bedrock',
 'Azure': 'microsoft-azure-ai', 'Baidu': 'baidu-qianfan',
 'Google AI Studio': 'google-gemini',
}

NAMES = {  # display names for entries that only exist as a flatkey facet label
 'amazon-bedrock': 'Amazon Bedrock', 'microsoft-azure-ai': 'Microsoft Azure AI',
 'baidu-qianfan': 'Baidu AI Cloud (Qianfan)', 'anthropic': 'Anthropic',
 'deepseek': 'DeepSeek', 'zhipu-ai': 'Z.ai (Zhipu AI)', 'moonshot-ai': 'Moonshot AI',
 'xai': 'xAI', 'macaron': 'Macaron', 'sonilo': 'Sonilo',
 'alibaba-cloud': 'Alibaba Cloud Model Studio', 'alibaba-com': 'Alibaba.com',
 'us-census-bureau': 'US Census Bureau', 'google-gemini': 'Google Gemini',
 'kadec0': 'kadec0', 'capminal': 'Capminal', 'emc2ai': 'EMC2 AI', 'gloria': 'Gloria',
 'browserbase': 'Browserbase', 'quicknode': 'QuickNode',
 'strale': 'Strale', 'hunter': 'Hunter', 'levels-fyi': 'Levels.fyi',
 'cars-com': 'Cars.com', 'bid-cars': 'bid.cars', 'homes-com': 'Homes.com',
 'web3-career': 'Web3 Career', 'blockrun': 'BlockRun', 'context-dev': 'Context.dev',
 'censusdata-xyz': 'censusdata.xyz', 'typesafe': 'TypeSafe', 'minimax': 'MiniMax',
 'bytedance': 'ByteDance', 'openai': 'OpenAI', 'sfs': 'Simple FS',
}

# ---- row emission ------------------------------------------------------------
ORDER = ['id', 'name', 'capability', 'category', 'provider_url', 'docs_url',
         'access_mode', 'signup', 'signup_automatable', 'min_topup',
         'billing_unit', 'free_tier', 'auth_type', 'seen_in', 'tos_notes',
         'source_url', 'checked_date']

# The five ND-8 structured core fields (../README.md "The structured core
# fields (ND-8)"), in the order they are emitted after ORDER.
STRUCTURED_FIELDS = ['official_docs_url', 'auth', 'pricing', 'endpoints',
                      'endpoints_note']
AUTH_KEYS = ['type', 'header', 'format', 'docs_url']
PRICING_KEYS = ['model', 'free_tier', 'starting_price_usd', 'unit',
                'pricing_url', 'notes']
ENDPOINT_KEYS = ['method', 'path', 'summary', 'returns', 'docs_url']


def q(v):
    if v is None: return 'null'
    s = str(v)
    return '"%s"' % s.replace('\\', '\\\\').replace('"', '\\"')


def yval(v):
    """One YAML scalar in `q()`'s quoting style, extended to bool/number/date
    -- types `q()` never has to carry (every ORDER field is a string or
    null), but the ND-8 nested fields and generic preserved extras do
    (`pricing.free_tier`, `pricing.starting_price_usd`, a hand-filled
    `checked_date` inside some other shard key, ...). A bare (unquoted) date
    round-trips as a `datetime.date` under PyYAML and as an equivalent string
    under validate.py's fallback reader -- the same deliberate asymmetry the
    top-level `checked_date` field already relies on."""
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, (int, float)):
        return str(v)
    return q(v)


def _mapping_lines(d, keys, indent):
    pad = ' ' * indent
    return ['%s%s: %s' % (pad, k, yval(d.get(k))) for k in keys]


# ---- generic serialiser for preserved extra keys ----------------------------
# Anything a shard row carries that build.py neither generates (ORDER) nor has
# a fixed nested shape for (the ND-8 STRUCTURED_FIELDS above) round-trips
# through these instead -- see merge_preserved() and ../README.md's
# "Preserving hand-filled fields" section. They cover every value shape
# PyYAML and the fallback reader agree on: mappings, lists of scalars, lists
# of mappings, nested mappings, multi-line strings (as a `|-` block, chomped
# so neither reader has to agree on a trailing newline), booleans, numbers,
# null and dates.

def _is_inline_scalar(v):
    """True when `v` prints on the same line as its key/dash. The one
    exception is a string containing a newline, which needs a literal block
    instead -- everything else `yval()` already renders as one line."""
    return not (isinstance(v, str) and '\n' in v)


def _literal_block_lines(pad, text):
    body_pad = pad + '  '
    return [(body_pad + line) if line else '' for line in text.split('\n')]


def _emit_entry(pad, key, value):
    """`key: value` at indent `pad`, or `key:` plus a nested block, for any
    value shape this module round-trips through PyYAML and the fallback
    reader identically."""
    if isinstance(value, dict):
        if not value:
            return ['%s%s: {}' % (pad, key)]
        lines = ['%s%s:' % (pad, key)]
        for k, v in value.items():
            lines.extend(_emit_entry(pad + '  ', k, v))
        return lines
    if isinstance(value, list):
        if not value:
            return ['%s%s: []' % (pad, key)]
        lines = ['%s%s:' % (pad, key)]
        for item in value:
            lines.extend(_emit_list_item(pad + '  ', item))
        return lines
    if _is_inline_scalar(value):
        return ['%s%s: %s' % (pad, key, yval(value))]
    lines = ['%s%s: |-' % (pad, key)]
    lines.extend(_literal_block_lines(pad, value))
    return lines


def _emit_list_item(pad, item):
    """One `- ...` list entry at indent `pad` -- a scalar, or the first key
    of a mapping with the rest aligned under it."""
    lead = pad + '- '
    if isinstance(item, dict):
        if not item:
            return ['%s{}' % lead]
        lines = []
        for i, (k, v) in enumerate(item.items()):
            sub = _emit_entry(pad + '  ', k, v)
            if i == 0:
                sub[0] = lead + sub[0][len(pad) + 2:]
            lines.extend(sub)
        return lines
    if _is_inline_scalar(item):
        return ['%s%s' % (lead, yval(item))]
    lines = ['%s|-' % lead]
    lines.extend(_literal_block_lines(pad, item))
    return lines


def emit_row(e):
    """One `apis:` list item as YAML text (lines joined by '\\n', no trailing
    newline): the base ORDER fields, always; then whichever of the five ND-8
    structured fields (official_docs_url, auth, pricing, endpoints,
    endpoints_note -- see ../README.md) are present as a key on `e`, in their
    defined order; then any OTHER key on `e` that is not in ORDER, in the
    order it appears on `e` -- a hand-filled field this module has no fixed
    shape for (`usage_api`, `offering`, `collection_scope`, a future key
    nobody has written yet, ...), serialised generically by `_emit_entry`.

    A field absent from `e` is skipped entirely -- never written as
    `field: null` -- so a row carrying none of them emits exactly what
    build.py emitted before ND-8 existed. Quoting matches `q()`/`yval()`
    throughout, so the output parses back identically with PyYAML and with
    validate.py's no-PyYAML fallback reader.
    """
    lines = []
    first = True
    for k in ORDER:
        v = e[k]
        lead = '  - ' if first else '    '
        first = False
        if k == 'seen_in':
            lines.append('%s%s: [%s]' % (lead, k, ', '.join(q(s) for s in v)))
        elif k == 'checked_date':
            lines.append('%s%s: %s' % (lead, k, v))
        else:
            lines.append('%s%s: %s' % (lead, k, q(v)))

    if 'official_docs_url' in e:
        lines.append('    official_docs_url: %s' % yval(e['official_docs_url']))

    if 'auth' in e:
        auth = e['auth']
        if auth is None:
            lines.append('    auth: null')
        else:
            lines.append('    auth:')
            lines.extend(_mapping_lines(auth, AUTH_KEYS, 6))

    if 'pricing' in e:
        pricing = e['pricing']
        if pricing is None:
            lines.append('    pricing: null')
        else:
            lines.append('    pricing:')
            lines.extend(_mapping_lines(pricing, PRICING_KEYS, 6))

    if 'endpoints' in e:
        eps = e['endpoints']
        if eps is None:
            lines.append('    endpoints: null')
        elif not eps:
            lines.append('    endpoints: []')
        else:
            lines.append('    endpoints:')
            for row in eps:
                first_ep = True
                for k in ENDPOINT_KEYS:
                    pad = '      - ' if first_ep else '        '
                    first_ep = False
                    lines.append('%s%s: %s' % (pad, k, yval(row.get(k))))

    if 'endpoints_note' in e:
        lines.append('    endpoints_note: %s' % yval(e['endpoints_note']))

    for k, v in e.items():
        if k in ORDER or k in STRUCTURED_FIELDS:
            continue
        lines.extend(_emit_entry('    ', k, v))

    return '\n'.join(lines)


def merge_preserved(new_row, old_row):
    """Layer every hand-filled extra field of a previously generated,
    possibly hand-edited shard row (`old_row`) onto a freshly rebuilt
    `new_row`.

    Generic rule: any key on `old_row` that is NOT one of the ORDER fields
    build.py itself computes from raw/ -- the five ND-8 fields
    (../README.md), `offering`, `usage_api`, or any other hand-filled key,
    known to this module or not -- is layered onto `new_row` as long as it is
    present and non-null on `old_row`. A key build.py does generate (ORDER)
    is always left at `new_row`'s freshly computed value, never overridden.

    Precedence (documented in ../README.md):
        existing non-null shard value  >  curated.py value  >  omitted
    `new_row` already carries whatever curated.py supplied for such a field
    (see main()), so this function applies the top rule only: a field that is
    null or absent on `old_row` leaves `new_row`'s value (curated-sourced or
    absent) untouched. build.py never invents a value for one of these
    fields itself -- only `old_row` or curated.py can.
    """
    merged = dict(new_row)
    old_row = old_row or {}
    for key, value in old_row.items():
        if key in ORDER:
            continue
        if value is not None:
            merged[key] = value
    return merged


def load_existing_rows(path):
    """id -> row for a previously generated shard at `path`, or {} when the
    file does not exist yet (first generation of a category). Used only to
    preserve hand-filled extra fields across a rebuild -- see
    merge_preserved."""
    if not os.path.exists(path):
        return {}
    doc = validate.load(path) or {}
    rows = doc.get('apis') or []
    return {row['id']: row for row in rows if isinstance(row, dict) and 'id' in row}


# ---- CLI: regenerate every shard from raw/ ----------------------------------
def main():
    rec = collections.defaultdict(lambda: {
        'seen': set(), 'name': None, 'url': None, 'docs': None,
        'gslug': None, 'mslug': None, 'counts': {}})

    # ---- glasser -------------------------------------------------------------
    g = r('glasser_public_catalog.json')
    for p in g['providers']:
        pid = G_ALIAS.get(p['provider']) or ALIAS.get(p['provider'], p['provider'])
        x = rec[pid]
        x['seen'].add('glasser'); x['name'] = x['name'] or p['label']
        x['gslug'] = p['provider']; x['counts']['glasser'] = p['endpoint_count']

    # ---- monid -----------------------------------------------------------------
    for p in r('monid_providers.json')['items']:
        pid = monid_pid(p['provider'])
        x = rec[pid]
        x['seen'].add('monid')
        if not x['name'] or x['name'] == p['provider']:
            x['name'] = x['name'] or p['displayName']
        x['url'] = x['url'] or p.get('url')
        x['docs'] = x['docs'] or p.get('docsUrl')
        x['mslug'] = p['provider']; x['counts']['monid'] = p['endpointCount']
    for res in r('monid_resources.json')['items']:
        pid = monid_pid(res['provider'])
        x = rec[pid]
        x['seen'].add('monid')
        x['url'] = x['url'] or res.get('providerUrl')
        x['docs'] = x['docs'] or res.get('providerDocsUrl')
        x['mslug'] = x['mslug'] or res['provider']

    # ---- flatkey ---------------------------------------------------------------
    fk_count = collections.Counter()
    for mo in r('flatkey_models_extracted.json'):
        hit = None
        for nm in (mo.get('author'), mo.get('vendor')):
            if nm in FK_VENDOR:
                hit = FK_VENDOR[nm]; break
        if hit:
            rec[hit]['seen'].add('flatkey'); fk_count[hit] += 1
            rec[hit]['name'] = rec[hit]['name'] or (mo.get('author') or mo.get('vendor'))
        for up in (mo.get('providers') or []):
            pid = FK_VENDOR.get(up) or FK_ROUTE.get(up)
            if pid:
                rec[pid]['seen'].add('flatkey'); fk_count[pid] += 1
    for pid, n in fk_count.items():
        rec[pid]['counts']['flatkey'] = n

    # ---- source_url ------------------------------------------------------------
    monid_tool_pages = set(open(os.path.join(RAW, 'list_monid_tools.txt')).read().split())

    def source_url(pid, x):
        if 'glasser' in x['seen'] and x['gslug']:
            return 'https://glasser.ai/data-sources/%s' % x['gslug']
        if 'monid' in x['seen']:
            for cand in (pid, x['mslug'], (x['mslug'] or '').replace('.', '-')):
                if cand and cand in monid_tool_pages:
                    return 'https://monid.ai/tools/%s' % cand
            return 'https://monid.ai/tools'
        return 'https://flatkey.ai/models'

    stale = sorted(set(curated.P) - set(rec))
    if stale:
        raise SystemExit('curated table out of sync: no raw record for %s' % stale)
    uncurated = sorted(set(rec) - set(curated.P))
    if uncurated:
        print('note: %d catalog slug(s) not in the curated table, skipped: %s'
              % (len(uncurated), uncurated))

    entries = []
    for pid in sorted(set(rec) & set(curated.P)):
        x = rec[pid]
        cat, cap, purl, durl, mode, signup, auth = curated.P[pid]
        tos = curated.TOS[mode] + curated.TOS_EXTRA.get(pid, '')
        row = {
            'id': pid,
            'name': NAMES.get(pid) or x['name'] or pid,
            'capability': cap,
            'category': cat,
            'provider_url': purl or x['url'],
            'docs_url': durl or x['docs'],
            'access_mode': mode,
            'signup': signup,
            'signup_automatable': 'no' if signup == 'sales' else 'unknown',
            'min_topup': None,
            'billing_unit': None,
            'free_tier': None,
            'auth_type': auth,
            'seen_in': sorted(x['seen']),
            'tos_notes': tos,
            'source_url': source_url(pid, x),
            'checked_date': CHECKED,
        }
        # The three aggregator catalogs do not publish a vendor's own docs
        # URL, auth/pricing specifics, endpoint catalog or any other
        # hand-filled extra, so the only way a freshly built row carries one
        # is a non-null value in curated.py's STRUCTURED table (any key, not
        # just the five ND-8 fields -- see ../README.md). merge_preserved()
        # below then lets a value hand-filled directly in the shard itself
        # override this one -- see ../README.md for the full precedence.
        for field, value in (curated.STRUCTURED.get(pid) or {}).items():
            if value is not None:
                row[field] = value
        entries.append(row)

    # ---- emit one YAML shard per category --------------------------------------
    by_cat = collections.defaultdict(list)
    for e in entries: by_cat[e['category']].append(e)

    for cat in sorted(by_cat):
        path = os.path.join(OUT, '%s.yaml' % cat)
        existing = load_existing_rows(path)
        lines = ['# SkeletonKey API index - category: %s' % cat,
                 '# Generated by scripts/build.py from data/apis/raw/. Do not hand-edit.',
                 'apis:']
        for e in sorted(by_cat[cat], key=lambda x: x['id']):
            merged = merge_preserved(e, existing.get(e['id']))
            lines.extend(emit_row(merged).split('\n'))
        open(path, 'w').write('\n'.join(lines) + '\n')

    stats = {
     'deduped_total': len(entries),
     'per_catalog_providers': {
       'glasser': sum(1 for e in entries if 'glasser' in e['seen_in']),
       'monid': sum(1 for e in entries if 'monid' in e['seen_in']),
       'flatkey': sum(1 for e in entries if 'flatkey' in e['seen_in']),
     },
     'per_category': dict(sorted(collections.Counter(e['category'] for e in entries).items())),
     'per_access_mode': dict(sorted(collections.Counter(e['access_mode'] for e in entries).items())),
     'per_signup': dict(sorted(collections.Counter(e['signup'] for e in entries).items())),
     'per_auth_type': dict(sorted(collections.Counter(e['auth_type'] for e in entries).items())),
     'provider_url_resolved': sum(1 for e in entries if e['provider_url']),
     'docs_url_resolved': sum(1 for e in entries if e['docs_url']),
     'underlying_endpoint_counts': {
       'glasser_endpoints': g['endpoint_count'],
       'monid_endpoints': len(r('monid_endpoints.json')['items']),
       'monid_resources': len(r('monid_resources.json')['items']),
       'flatkey_models': len(r('flatkey_models_extracted.json')),
     },
    }
    json.dump(stats, open(os.path.join(OUT, 'raw', 'build_stats.json'), 'w'), indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == '__main__':
    main()
