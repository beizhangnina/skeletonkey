"""Write public/sitemap.xml from the pages in public/, and backfill the OG/Twitter
tags on pages that are missing them.

    python3 scripts/build_sitemap.py

Two jobs, both idempotent:

1. Backfill. Any public/**/index.html that has no og:title gets the same OG set
   the homepage already carries (og:type, og:url, og:site_name, og:title,
   og:description, og:image, og:image:width/height/alt, twitter:card), built from
   that page's own <title> and meta description and its own canonical. Pages that
   already have an og:title are skipped, so the homepage keeps its hand-written
   OG wording and a second run never touches anything.

2. Sitemap. Every public/**/index.html becomes one <url>, located at the page's
   own canonical (so trailing slashes match what the site already serves).
   public/404.html is not an index.html and is never included.

This script does not read the API index yaml. It only looks at the HTML that is
already in public/, so it is safe to run on its own after a content edit.
"""
import os
import re
import sys
import time
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
SITE = 'https://skeletonkey.run'

OG_IMAGE = f'{SITE}/og.png'
OG_IMAGE_WIDTH = '1200'
OG_IMAGE_HEIGHT = '630'
OG_IMAGE_ALT = 'The skeletonkey wordmark with a brass key mark on warm cream paper.'

RE_TITLE = re.compile(r'<title>(.*?)</title>', re.S)
RE_DESC = re.compile(r'<meta\s+name="description"\s+content="(.*?)"\s*>', re.S)
RE_CANON = re.compile(r'<link\s+rel="canonical"\s+href="(.*?)"\s*>', re.S)
RE_CANON_LINE = re.compile(r'(<link\s+rel="canonical"\s+href=".*?"\s*>\s*\n)')
RE_DESC_LINE = re.compile(r'(<meta\s+name="description"\s+content=".*?"\s*>\s*\n)')


def pages():
    """Every index.html under public/, sorted for a stable sitemap."""
    out = []
    for dirpath, dirnames, filenames in os.walk(PUB):
        dirnames.sort()
        if 'index.html' in filenames:
            out.append(os.path.join(dirpath, 'index.html'))
    return sorted(out)


def canonical_of(html):
    m = RE_CANON.search(html)
    return m.group(1).strip() if m else ''


def og_block(title, desc, url):
    """The OG/Twitter set, in the same order the homepage uses."""
    return (f'<meta property="og:type" content="website">\n'
            f'<meta property="og:url" content="{url}">\n'
            f'<meta property="og:site_name" content="SkeletonKey">\n'
            f'<meta property="og:title" content="{title}">\n'
            f'<meta property="og:description" content="{desc}">\n'
            f'<meta property="og:image" content="{OG_IMAGE}">\n'
            f'<meta property="og:image:width" content="{OG_IMAGE_WIDTH}">\n'
            f'<meta property="og:image:height" content="{OG_IMAGE_HEIGHT}">\n'
            f'<meta property="og:image:alt" content="{OG_IMAGE_ALT}">\n'
            f'<meta name="twitter:card" content="summary_large_image">\n')


def inject_og(path):
    """Add the missing OG/Twitter tags to one page. Returns True if it wrote."""
    html = open(path, encoding='utf-8').read()
    if 'og:title' in html:
        return False
    title = RE_TITLE.search(html)
    desc = RE_DESC.search(html)
    canon = RE_CANON.search(html)
    if not (title and desc and canon):
        return False
    url = canon.group(1).strip()
    block = og_block(title.group(1).strip(), desc.group(1).strip(), url)
    # Right after the canonical link, so the head keeps its current order.
    if RE_CANON_LINE.search(html):
        html = RE_CANON_LINE.sub(lambda m: m.group(1) + block, html, count=1)
    elif RE_DESC_LINE.search(html):
        html = RE_DESC_LINE.sub(lambda m: m.group(1) + block, html, count=1)
    else:
        return False
    open(path, 'w', encoding='utf-8').write(html)
    return True


def loc_for(path, html):
    """The absolute URL for a page: its own canonical, else the path under SITE."""
    canon = canonical_of(html)
    if canon.startswith(SITE + '/') or canon == SITE + '/':
        return canon
    rel = os.path.relpath(path, PUB).replace(os.sep, '/')
    if rel == 'index.html':
        return SITE + '/'
    return f'{SITE}/{rel.rsplit("/", 1)[0]}/'


def write_sitemap():
    """Collect every page's URL and write public/sitemap.xml. Returns the locs."""
    urls = []
    for path in pages():
        html = open(path, encoding='utf-8').read()
        url = loc_for(path, html)
        if not url.startswith('https://'):
            raise SystemExit(f'refusing to write a non-https URL: {url}')
        lastmod = time.strftime('%Y-%m-%d', time.localtime(os.path.getmtime(path)))
        urls.append((url, lastmod))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url, lastmod in urls:
        lines.append('  <url>')
        lines.append(f'    <loc>{url}</loc>')
        lines.append(f'    <lastmod>{lastmod}</lastmod>')
        lines.append('  </url>')
    lines.append('</urlset>')
    lines.append('')
    out = os.path.join(PUB, 'sitemap.xml')
    open(out, 'w', encoding='utf-8').write('\n'.join(lines))

    # Fail loudly here rather than shipping a sitemap Google cannot parse.
    tree = ET.parse(out)
    ns = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
    locs = [e.text for e in tree.getroot().findall(f'{ns}url/{ns}loc')]
    assert len(locs) == len(urls), f'wrote {len(urls)} urls but parsed {len(locs)}'
    for loc in locs:
        assert loc.startswith('https://skeletonkey.run/'), f'bad loc: {loc}'
    return locs


def main():
    changed = [p for p in pages() if inject_og(p)]
    locs = write_sitemap()
    print(f'og tags added to {len(changed)} page(s)')
    print(f'sitemap: {len(locs)} urls -> {os.path.join(PUB, "sitemap.xml")}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
