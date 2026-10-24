#!/usr/bin/env python3
"""Build data/apis/<category>.yaml from the cached aggregator catalogs.

Sources (all public, unauthenticated - see ../README.md for method):
  raw/glasser_public_catalog.json   GET https://api.glasser.ai/public/catalog
  raw/monid_providers.json          GET https://api.monid.ai/public/v1/providers
  raw/monid_endpoints.json          GET https://api.monid.ai/public/v1/endpoints
  raw/monid_resources.json          GET https://api.monid.ai/public/v1/resources
  raw/flatkey_models_extracted.json parsed from https://flatkey.ai/models
"""
import json, os, collections
import curated

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'raw')
OUT = os.path.join(HERE, '..')
CHECKED = '2026-10-24'

def r(p): return json.load(open(os.path.join(RAW, p)))

# ---- slug normalisation across catalogs -------------------------------------
ALIAS = {
 'levels.fyi': 'levels-fyi', 'cars.com': 'cars-com', 'bid.cars': 'bid-cars',
 'hunterio': 'hunter', 'context.dev': 'context-dev', 'homes.com': 'homes-com',
 'web3.career': 'web3-career', 'blockrun.ai': 'blockrun', 'api.strale.io': 'strale',
 'api.itsgloria.ai': 'gloria', 'x402.browserbase.com': 'browserbase',
 'x402.quicknode.com': 'quicknode', 'google-trends.use.x402atlas.com': 'x402atlas',
 'censusdata.xyz': 'censusdata-xyz', 'emc2ai.io': 'emc2ai',
 'www.capminal.ai': 'capminal', 'api.kadec0.xyz': 'kadec0',
 'gemini': 'google-gemini', 'alibaba': 'alibaba-cloud',
}
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

rec = collections.defaultdict(lambda: {
    'seen': set(), 'name': None, 'url': None, 'docs': None,
    'gslug': None, 'mslug': None, 'counts': {}})

# ---- glasser ---------------------------------------------------------------
g = r('glasser_public_catalog.json')
for p in g['providers']:
    pid = G_ALIAS.get(p['provider']) or ALIAS.get(p['provider'], p['provider'])
    x = rec[pid]
    x['seen'].add('glasser'); x['name'] = x['name'] or p['label']
    x['gslug'] = p['provider']; x['counts']['glasser'] = p['endpoint_count']

# ---- monid -----------------------------------------------------------------
for p in r('monid_providers.json')['items']:
    pid = ALIAS.get(p['provider'], p['provider'])
    x = rec[pid]
    x['seen'].add('monid')
    if not x['name'] or x['name'] == p['provider']:
        x['name'] = x['name'] or p['displayName']
    x['url'] = x['url'] or p.get('url')
    x['docs'] = x['docs'] or p.get('docsUrl')
    x['mslug'] = p['provider']; x['counts']['monid'] = p['endpointCount']
for res in r('monid_resources.json')['items']:
    pid = ALIAS.get(res['provider'], res['provider'])
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

NAMES = {  # display names for entries that only exist as a flatkey facet label
 'amazon-bedrock': 'Amazon Bedrock', 'microsoft-azure-ai': 'Microsoft Azure AI',
 'baidu-qianfan': 'Baidu AI Cloud (Qianfan)', 'anthropic': 'Anthropic',
 'deepseek': 'DeepSeek', 'zhipu-ai': 'Z.ai (Zhipu AI)', 'moonshot-ai': 'Moonshot AI',
 'xai': 'xAI', 'macaron': 'Macaron', 'sonilo': 'Sonilo',
 'alibaba-cloud': 'Alibaba Cloud Model Studio', 'alibaba-com': 'Alibaba.com',
 'us-census-bureau': 'US Census Bureau', 'google-gemini': 'Google Gemini',
 'kadec0': 'kadec0', 'capminal': 'Capminal', 'emc2ai': 'EMC2 AI', 'gloria': 'Gloria',
 'x402atlas': 'x402 Atlas', 'browserbase': 'Browserbase', 'quicknode': 'QuickNode',
 'strale': 'Strale', 'hunter': 'Hunter', 'levels-fyi': 'Levels.fyi',
 'cars-com': 'Cars.com', 'bid-cars': 'bid.cars', 'homes-com': 'Homes.com',
 'web3-career': 'Web3 Career', 'blockrun': 'BlockRun', 'context-dev': 'Context.dev',
 'censusdata-xyz': 'censusdata.xyz', 'typesafe': 'TypeSafe', 'minimax': 'MiniMax',
 'bytedance': 'ByteDance', 'openai': 'OpenAI', 'sfs': 'Simple FS',
}

missing = sorted(set(rec) - set(curated.P))
extra = sorted(set(curated.P) - set(rec))
if missing or extra:
    raise SystemExit('curated table out of sync: missing=%s extra=%s' % (missing, extra))

entries = []
for pid in sorted(rec):
    x = rec[pid]
    cat, cap, purl, durl, mode, signup, auth = curated.P[pid]
    tos = curated.TOS[mode] + curated.TOS_EXTRA.get(pid, '')
    entries.append({
        'id': pid,
        'name': NAMES.get(pid) or x['name'] or pid,
        'capability': cap,
        'category': cat,
        'provider_url': purl or x['url'],
        'docs_url': durl or x['docs'],
        'access_mode': mode,
        'signup': signup,
        'signup_automatable': ('no' if signup == 'sales'
                               else 'yes' if mode == 'x402' else 'unknown'),
        'min_topup': None,
        'billing_unit': None,
        'free_tier': None,
        'auth_type': auth,
        'seen_in': sorted(x['seen']),
        'tos_notes': tos,
        'source_url': source_url(pid, x),
        'checked_date': CHECKED,
    })

# ---- emit one YAML shard per category --------------------------------------
ORDER = ['id', 'name', 'capability', 'category', 'provider_url', 'docs_url',
         'access_mode', 'signup', 'signup_automatable', 'min_topup',
         'billing_unit', 'free_tier', 'auth_type', 'seen_in', 'tos_notes',
         'source_url', 'checked_date']

def q(v):
    if v is None: return 'null'
    s = str(v)
    return '"%s"' % s.replace('\\', '\\\\').replace('"', '\\"')

by_cat = collections.defaultdict(list)
for e in entries: by_cat[e['category']].append(e)

for cat in sorted(by_cat):
    lines = ['# SkeletonKey API index - category: %s' % cat,
             '# Generated by scripts/build.py from data/apis/raw/. Do not hand-edit.',
             'apis:']
    for e in sorted(by_cat[cat], key=lambda x: x['id']):
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
    open(os.path.join(OUT, '%s.yaml' % cat), 'w').write('\n'.join(lines) + '\n')

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
