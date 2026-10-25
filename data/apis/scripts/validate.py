#!/usr/bin/env python3
"""Schema validator for the SkeletonKey API index shards (data/apis/*.yaml).

Checks, per entry:
  * exactly the required key set, no extras, no missing
  * enum membership for access_mode / signup / signup_automatable / auth_type
  * checked_date is a real ISO date (YYYY-MM-DD)
  * ids unique across every shard, and slug-shaped
  * seen_in is a non-empty subset of {glasser, monid, flatkey}
  * category matches the filename the entry lives in
  * provider_url / docs_url / source_url are http(s) URLs when not null
  * min_topup / billing_unit / free_tier are null or of a sane type

Exit code 0 = pass, 1 = fail.  Usage: python3 validate.py [dir]
"""
import sys, os, re, glob, datetime

try:
    import yaml
except ImportError:
    yaml = None

REQUIRED = ['id', 'name', 'capability', 'category', 'provider_url', 'docs_url',
            'access_mode', 'signup', 'signup_automatable', 'min_topup',
            'billing_unit', 'free_tier', 'auth_type', 'seen_in', 'tos_notes',
            'source_url', 'checked_date']

ENUMS = {
    'access_mode': {'intermediary', 'own-account', 'byok', 'unknown'},
    'signup': {'self-serve', 'sales', 'waitlist', 'unknown'},
    'signup_automatable': {'yes', 'partial', 'no', 'unknown'},
    'auth_type': {'api_key', 'oauth', 'none', 'unknown'},
}
SOURCES = {'glasser', 'monid', 'flatkey'}
SLUG = re.compile(r'^[a-z0-9][a-z0-9.-]*$')
URL = re.compile(r'^https?://\S+$')


def load(path):
    """Parse a shard. Uses PyYAML when available, else a minimal fallback
    reader for the exact flat shape build.py emits."""
    if yaml is not None:
        with open(path) as fh:
            return yaml.safe_load(fh)
    apis, cur = [], None
    for line in open(path):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if line.startswith('apis:'):
            continue
        m = re.match(r'  (- |  )(\w+): (.*)$', line.rstrip('\n'))
        if not m:
            raise ValueError('%s: cannot parse %r' % (path, line))
        new, key, val = m.group(1) == '- ', m.group(2), m.group(3)
        if new:
            cur = {}
            apis.append(cur)
        if val == 'null':
            v = None
        elif val.startswith('['):
            v = [p.strip().strip('"') for p in val[1:-1].split(',') if p.strip()]
        elif val.startswith('"'):
            v = val[1:-1].replace('\\"', '"').replace('\\\\', '\\')
        else:
            v = val
        cur[key] = v
    return {'apis': apis}


def main(root):
    errs, seen_ids, total = [], {}, 0
    files = sorted(glob.glob(os.path.join(root, '*.yaml')))
    if not files:
        print('FAIL: no *.yaml shards found in %s' % root)
        return 1

    for path in files:
        shard = os.path.splitext(os.path.basename(path))[0]
        doc = load(path)
        if not isinstance(doc, dict) or 'apis' not in doc:
            errs.append('%s: top-level key `apis:` missing' % shard)
            continue
        if not isinstance(doc['apis'], list) or not doc['apis']:
            errs.append('%s: `apis` must be a non-empty list' % shard)
            continue

        for i, e in enumerate(doc['apis']):
            where = '%s[%d]' % (shard, i)
            if not isinstance(e, dict):
                errs.append('%s: entry is not a mapping' % where)
                continue
            where = '%s(%s)' % (shard, e.get('id', '?'))
            total += 1

            for k in REQUIRED:
                if k not in e:
                    errs.append('%s: missing key `%s`' % (where, k))
            for k in e:
                if k not in REQUIRED:
                    errs.append('%s: unexpected key `%s`' % (where, k))

            pid = e.get('id')
            if not isinstance(pid, str) or not SLUG.match(pid or ''):
                errs.append('%s: id must be a lowercase slug' % where)
            elif pid in seen_ids:
                errs.append('%s: duplicate id, also in %s' % (where, seen_ids[pid]))
            else:
                seen_ids[pid] = shard

            for k in ('name', 'capability', 'tos_notes'):
                if not isinstance(e.get(k), str) or not e.get(k, '').strip():
                    errs.append('%s: `%s` must be a non-empty string' % (where, k))

            if e.get('category') != shard:
                errs.append('%s: category %r does not match shard file %r'
                            % (where, e.get('category'), shard))

            for k, allowed in ENUMS.items():
                if e.get(k) not in allowed:
                    errs.append('%s: %s=%r not in %s'
                                % (where, k, e.get(k), sorted(allowed)))

            si = e.get('seen_in')
            if not isinstance(si, list) or not si:
                errs.append('%s: seen_in must be a non-empty list' % where)
            else:
                bad = [s for s in si if s not in SOURCES]
                if bad:
                    errs.append('%s: seen_in has unknown sources %s' % (where, bad))
                if len(set(si)) != len(si):
                    errs.append('%s: seen_in has duplicates' % where)

            for k in ('provider_url', 'docs_url'):
                v = e.get(k)
                if v is not None and not URL.match(str(v)):
                    errs.append('%s: %s=%r is not an http(s) URL' % (where, k, v))
            if not URL.match(str(e.get('source_url'))):
                errs.append('%s: source_url=%r is not an http(s) URL'
                            % (where, e.get('source_url')))

            for k in ('min_topup', 'free_tier'):
                v = e.get(k)
                if v is not None and not isinstance(v, (int, float, str, bool)):
                    errs.append('%s: %s has unsupported type %s'
                                % (where, k, type(v).__name__))
            if e.get('billing_unit') is not None and not isinstance(e['billing_unit'], str):
                errs.append('%s: billing_unit must be a string or null' % where)

            d = e.get('checked_date')
            d = d.isoformat() if isinstance(d, datetime.date) else d
            try:
                datetime.date.fromisoformat(str(d))
            except (ValueError, TypeError):
                errs.append('%s: checked_date=%r is not an ISO date' % (where, d))

    print('shards: %d   entries: %d   unique ids: %d'
          % (len(files), total, len(seen_ids)))
    if errs:
        print('FAIL: %d problem(s)' % len(errs))
        for m in errs[:200]:
            print('  -', m)
        return 1
    print('OK: all entries valid')
    return 0


if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..')
    sys.exit(main(root))
