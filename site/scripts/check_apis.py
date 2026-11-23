"""Link checks + Chromium/WebKit screenshots for the API index.  python3 scripts/check_apis.py http://127.0.0.1:8899"""
import sys, os, re, glob, json, time, asyncio, subprocess, concurrent.futures as cf
from html.parser import HTMLParser
BASE = sys.argv[1].rstrip('/'); PUB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public')
SHOTS = os.path.join(os.path.dirname(PUB), 'shots', 'apis'); os.makedirs(SHOTS, exist_ok=True)
class P(HTMLParser):
    def __init__(s): super().__init__(); s.l = []
    def handle_starttag(s, t, a):
        for k, v in a:
            if k in ('href', 'src') and v: s.l.append(v)
VPAGES = [f for f in glob.glob(os.path.join(PUB, 'apis', '*', 'index.html')) if os.path.basename(os.path.dirname(f)) != 'aggregators']
APAGES = glob.glob(os.path.join(PUB, 'apis', 'aggregators', '*', 'index.html')) + [os.path.join(PUB, 'apis', 'aggregators', 'index.html')]
files = sorted(set([os.path.join(PUB, 'index.html'), os.path.join(PUB, 'apis', 'index.html')] + VPAGES + APAGES))
print(f'pages crawled: {len(files)} ({len(VPAGES)} under /apis/, {len(APAGES)} aggregator pages)')
internal, external, bad = set(), set(), []
for f in files:
    p = P(); p.feed(open(f).read())
    for u in p.l:
        if u.startswith('http'): external.add(u)
        elif u.startswith('/'): internal.add(u.split('#')[0].split('?')[0])
for u in sorted(internal):
    path = os.path.join(PUB, u.lstrip('/'))
    if not (os.path.isfile(path) or os.path.isfile(os.path.join(path, 'index.html'))): bad.append(u)
print(f'internal links: {len(internal)} unique, {len(bad)} broken', bad[:10])
J = json.load(open(os.path.join(PUB, 'apis.json'))); print('apis.json parses')
# every aggregator profile and every route source must have a page on disk
need = {a['slug'] for a in J['aggregators']} | {rt['source_slug'] for x in J['apis'] for rt in x['routes'] if rt.get('aggregator_page')}
missing = [s_ for s_ in sorted(need) if not os.path.isfile(os.path.join(PUB, 'apis', 'aggregators', s_, 'index.html'))]
nrt = sum(len(x['routes']) for x in J['apis'])
print(f'apis.json: {len(J["apis"])} vendors, {nrt} routes, {J["route_counts"]["verified"]} verified, {len(J["aggregators"])} aggregators, {len(missing)} missing aggregator pages', missing)
def code(u):
    for attempt in range(3):
        r = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-L', '-m', '15', '-A', 'Mozilla/5.0', u], capture_output=True, text=True)
        # 000 is curl failing to get an answer at all: a dead host, but also what 24 concurrent
        # requests to one domain look like. Retry before calling it dead, so the dead list means something.
        if r.stdout != '000': break
        time.sleep(2 + 3 * attempt)
    return u, r.stdout
with cf.ThreadPoolExecutor(24) as ex: res = list(ex.map(code, sorted(external)))
dead = [(u, c) for u, c in res if c in ('404', '410', '000') ]
blocked = [(u, c) for u, c in res if c not in ('404', '410', '000') and not c.startswith(('2', '3'))]
print(f'external links: {len(external)} unique, {len(dead)} dead (404/410/unreachable), {len(blocked)} bot-blocked/other')
json.dump({'dead': dead, 'blocked': blocked}, open(os.path.join(SHOTS, 'external_links.json'), 'w'), indent=1)
from playwright.async_api import async_playwright
SHOT_CAP = 4   # screenshots stay capped: pages x 2 viewports x 2 browsers
PAGES = (sys.argv[2:] or ['/apis/', '/apis/zillow/', '/apis/aggregators/'])[:SHOT_CAP]
async def main():
    async with async_playwright() as p:
        for name in ('chromium', 'webkit'):
            b = await getattr(p, name).launch()
            for w, tag in ((1280, 'desktop'), (390, 'mobile')):
                pg = await b.new_page(viewport={'width': w, 'height': 900}); errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)))
                for path in PAGES:
                    await pg.goto(BASE + path, wait_until='networkidle')
                    out = os.path.join(SHOTS, f"{name}-{tag}-{path.strip('/').replace('/', '_') or 'home'}.png")
                    await pg.screenshot(path=out, full_page=True, clip=None) if await pg.evaluate("document.body.scrollHeight")<16000 else await pg.screenshot(path=out, clip={"x":0,"y":0,"width":pg.viewport_size["width"],"height":4000}); print('shot', out)
                if tag == 'desktop':
                    await pg.goto(BASE + '/apis/'); await pg.fill('#ap-q', 'weather'); n1 = await pg.inner_text('#ap-count')
                    await pg.fill('#ap-q', ''); await pg.select_option('#ap-st', 'verified'); n2 = await pg.inner_text('#ap-count')
                    print(name, 'filter weather ->', n1, '| status verified ->', n2, '| js errors', errs)
                await pg.close()
            await b.close()
asyncio.run(main())
