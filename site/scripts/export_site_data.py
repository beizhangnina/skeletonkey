"""Regenerate the committed site data snapshot from the external research index.

    python3 scripts/export_site_data.py --index /path/to/index.yaml

Reads the index file plus <index dir>/routes/{aggregators.json,dead_urls.txt,
<id>.json}. Writes, under site/data/:

  vendor-research.json   -- {"checked", "vendors": {id: {...}}}
                             One object per index entry, holding only the
                             research-only fields build_apis.py actually reads
                             that the repo's data/apis/*.yaml shards don't
                             carry (what_it_does, url, signup_url, ...). The
                             shards remain canonical for everything else,
                             including the ND-7/ND-8 structured fields. Does
                             not record the external index's own path -- it's
                             a local research-tree location, not repo data.
  routes/aggregators.json   -- copied as-is
  routes/dead_urls.txt      -- copied as-is
  routes/vendor-routes.json -- {id: [route, ...]} consolidated from every
                                <id>.json that matches an id in the index

This is the only script in the repo that reads outside the repo. build_apis.py
itself never imports or references the external path -- see site/README.md.
"""
import argparse
import json
import os
import shutil
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # site/
SITE_DATA = os.path.join(ROOT, 'data')

# Keys build_apis.py reads off an index entry. Most of these are fields the
# shards never carry at all (what_it_does, url, signup_url, ...). A few --
# docs_url, min_topup, billing_unit, free_tier -- are nominally shard-canonical
# fields too, but today EVERY shard row has them null (a known research gap,
# see data/apis/README.md's "Other field coverage"): without a fallback here,
# merging would silently wipe values the site currently shows. The merge in
# build_apis.py always prefers a non-null shard value over this overlay, so a
# future shard fill takes over the moment it lands with no change here. Keep
# this list in sync with the field names actually read there -- no other
# index field (catalog_url, hand_check, hand_check_notes, price_conflict,
# conflicts_or_notes, ...) belongs in the overlay: those are internal
# research-process notes, never published, and build_apis.py's one use of
# conflicts_or_notes (excluding a row still marked "not yet researched") reads
# it as `r.get(...)`, which is already None-safe -- dropping the key here just
# means that guard never fires, which matches reality: every shard row is
# already a researched, published vendor.
OVERLAY_KEYS = [
    'verified', 'no_public_api', 'sales_only', 'what_it_does', 'url',
    'signup_url', 'signup_method', 'requires_card', 'requires_phone',
    'kyc_or_captcha', 'vendor_per_call_usd', 'billing_model', 'plans',
    'free_tier_note', 'pricing_url', 'base_url', 'auth_header', 'auth_format',
    'source_urls',
    'docs_url', 'min_topup', 'billing_unit', 'free_tier',
]

# The index's own `kyc_or_captcha` text for these 4 ids names the research
# tooling used to check the signup page (Jina, curl, WebFetch), not a fact
# about the vendor. Rewritten here (2026-11-24, Bei) to a neutral description
# of what the page actually shows, using only facts already in the index
# text, so a re-export doesn't bring the tool names back.
KYC_OR_CAPTCHA_OVERRIDE = {
    'bid-cars': 'Signup page is behind a bot/security verification challenge; '
                'the signup form itself was still visible despite the challenge.',
    'cars-com': 'www.cars.com runs a Cloudflare bot check that blocks plain HTTP '
                'requests; the homepage is reachable with full browser rendering. '
                'No captcha requirement documented for signup.',
    'stockanalysis': "Pages are behind a Cloudflare 'Just a moment...' challenge "
                      'that blocks plain HTTP requests (HTTP 403); full browser '
                      'rendering reaches the pages. No captcha requirement '
                      'documented for signup.',
    'clutch': "clutch.co web pages sit behind a Cloudflare 'Just a moment...' "
              'challenge that blocks plain HTTP requests and full browser '
              'rendering alike; a separate bot.clutch.co/mcp endpoint is not '
              'challenged.',
}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--index', required=True, help='path to the external index.yaml')
    args = ap.parse_args()

    index_path = os.path.abspath(args.index)
    rdir = os.path.join(os.path.dirname(index_path), 'routes')
    doc = yaml.safe_load(open(index_path))
    entries = doc.get('entries') or []

    vendors = {
        e['id']: {
            k: (KYC_OR_CAPTCHA_OVERRIDE[e['id']] if k == 'kyc_or_captcha' and e['id'] in KYC_OR_CAPTCHA_OVERRIDE
                else e.get(k))
            for k in OVERLAY_KEYS
        }
        for e in entries
    }
    overlay = {'checked': doc.get('checked_date'), 'vendors': vendors}
    json.dump(overlay, open(os.path.join(SITE_DATA, 'vendor-research.json'), 'w'),
               indent=1, ensure_ascii=False, default=str)

    out_routes = os.path.join(SITE_DATA, 'routes')
    os.makedirs(out_routes, exist_ok=True)
    shutil.copy(os.path.join(rdir, 'aggregators.json'), os.path.join(out_routes, 'aggregators.json'))
    shutil.copy(os.path.join(rdir, 'dead_urls.txt'), os.path.join(out_routes, 'dead_urls.txt'))

    vendor_routes = {}
    for e in entries:
        f = os.path.join(rdir, e['id'] + '.json')
        if os.path.isfile(f):
            routes = (json.load(open(f)).get('routes') or [])
            if routes:
                vendor_routes[e['id']] = routes
    json.dump(vendor_routes, open(os.path.join(out_routes, 'vendor-routes.json'), 'w'),
               indent=1, ensure_ascii=False, default=str)

    print(f'wrote vendor-research.json ({len(vendors)} vendors)')
    print(f'wrote routes/aggregators.json, routes/dead_urls.txt')
    print(f'wrote routes/vendor-routes.json ({len(vendor_routes)} vendors with routes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
