#!/usr/bin/env python3
"""Schema validator for the SkeletonKey API index shards (data/apis/*.yaml).

Checks, per entry:
  * the required key set, no missing, and no key outside required + optional
  * enum membership for access_mode / signup / signup_automatable / auth_type
  * checked_date is a real ISO date (YYYY-MM-DD)
  * ids unique across every shard, and slug-shaped
  * seen_in is a non-empty subset of {glasser, monid, flatkey}
  * category matches the filename the entry lives in
  * provider_url / docs_url / source_url are http(s) URLs when not null
  * min_topup / billing_unit / free_tier are null or of a sane type
  * the optional `offering` block: a one-line summary, service categories from a
    closed list, approximate counts, what is free, how to connect, the vendor's
    own catalog URL, and at most HIGHLIGHTS_MAX highlighted models/endpoints

`offering` is OPTIONAL on every row: a shard written before the block existed
validates unchanged. It mirrors the `offering:` block src/apis.ts enforces for
apis.yaml, field for field, so one schema covers both files.

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

# Keys a row MAY carry. Everything here is optional and null-when-unknown, so
# adding one to a shard cannot invalidate the rows that do not have it.
OPTIONAL = ['offering']

ENUMS = {
    # `keyless` = the vendor documents no credential at all; `wallet-x402` = the
    # only documented way to pay is a crypto wallet (recorded as a fact about
    # the vendor; SkeletonKey itself pays in fiat only).
    'access_mode': {'intermediary', 'own-account', 'byok', 'keyless',
                    'wallet-x402', 'unknown'},
    'signup': {'self-serve', 'sales', 'waitlist', 'unknown'},
    'signup_automatable': {'yes', 'partial', 'no', 'unknown'},
    'auth_type': {'api_key', 'oauth', 'none', 'unknown'},
}
SOURCES = {'glasser', 'monid', 'flatkey'}
SLUG = re.compile(r'^[a-z0-9][a-z0-9.-]*$')
URL = re.compile(r'^https?://\S+$')

# ---- the optional `offering` block ------------------------------------------
# Kept byte-identical in meaning to src/apis.ts (SERVICE_CATEGORIES,
# CONNECT_AUTH_KINDS, HIGHLIGHT_KINDS, HIGHLIGHTS_MAX, OFFERING_SUMMARY_MAX,
# OFFERING_CATEGORIES_MAX). test/offering.test.ts asserts the two lists have not
# drifted apart, because two validators disagreeing is worse than one.
OFFERING_KEYS = ['summary', 'categories', 'endpoint_count', 'model_count',
                 'count_note', 'free_tier', 'connect', 'catalog_url',
                 'verified_url', 'verified_date', 'source_urls', 'highlights']
SERVICE_CATEGORIES = [
    'llm', 'embeddings', 'rerank', 'image', 'video', 'audio', 'speech', 'ocr',
    'vision', 'moderation', 'translation', 'code', 'agents', 'search',
    'web-scraping', 'data-enrichment', 'seo', 'social', 'ecommerce', 'finance',
    'maps', 'weather', 'email', 'sms', 'analytics', 'advertising', 'science',
    'compute', 'payments', 'other',
]
CONNECT_AUTH_KINDS = ['api_key', 'bearer', 'basic', 'oauth', 'query_param',
                      'none', 'unknown']
HIGHLIGHT_KINDS = ['model', 'endpoint']
HIGHLIGHTS_MAX = 15
OFFERING_SUMMARY_MAX = 200
OFFERING_CATEGORIES_MAX = 12
FREE_TIER_KEYS = ['available', 'what', 'limits', 'requires_key',
                  'requires_account']
CONNECT_KEYS = ['base_url', 'auth', 'auth_header', 'auth_format']
HIGHLIGHT_ROW_KEYS = ['id', 'kind', 'free', 'note', 'url']
HEADER_NAME = re.compile(r'^[^\s:]+$')


# ---- fallback reader (no PyYAML) --------------------------------------------
# A deliberately small, indentation-driven reader for the YAML subset these
# shards use: nested mappings, block and inline lists, quoted/bare scalars and
# folded/literal block scalars. It exists so `validate.py` still runs on a bare
# interpreter -- the original version only understood ONE flat level, which the
# nested `offering:` block broke.
#
# Known limits of the subset, all absent from these files: anchors, aliases,
# multi-document streams, flow mappings (`{a: 1}`), and commas inside an inline
# list's items. PyYAML is used whenever it imports, so these only matter on a
# bare interpreter.

BLOCK_STYLES = ('>', '>-', '>+', '|', '|-', '|+')
# A key is `name:` followed by whitespace or end-of-line -- NOT just a colon,
# or a bare `https://example.com/docs` list item would parse as {https: //...}.
KEY = re.compile(r'^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$')


def _key(text):
    """(key, value) for a `key: value` line, or None when it is not one."""
    match = KEY.match(text)
    if match is None:
        return None
    return match.group(1), (match.group(2) or '').strip()


def _scalar(val):
    """One YAML scalar. A bare date stays a string, as PyYAML's loader would
    give a date object -- both are accepted downstream."""
    val = val.strip()
    if val in ('null', '~', ''):
        return None
    if val == 'true':
        return True
    if val == 'false':
        return False
    if val.startswith('[') and val.endswith(']'):
        inner = val[1:-1].strip()
        if not inner:
            return []
        return [_scalar(part) for part in inner.split(',')]
    if len(val) > 1 and val[0] == val[-1] and val[0] in '"\'':
        body = val[1:-1]
        if val[0] == '"':
            body = body.replace('\\"', '"').replace('\\\\', '\\')
        return body
    if re.match(r'^-?\d+$', val):
        return int(val)
    if re.match(r'^-?\d+\.\d+$', val):
        return float(val)
    return val


class _Reader(object):
    """Lines plus a cursor, skipping blanks and comments on peek."""

    def __init__(self, lines):
        self.lines = lines
        self.i = 0

    def peek(self):
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if not raw.strip() or raw.lstrip().startswith('#'):
                self.i += 1
                continue
            return len(raw) - len(raw.lstrip(' ')), raw.strip()
        return None


def _block_scalar(reader, indent, style):
    parts = []
    while reader.i < len(reader.lines):
        raw = reader.lines[reader.i]
        if not raw.strip():
            parts.append('')
            reader.i += 1
            continue
        if len(raw) - len(raw.lstrip(' ')) <= indent:
            break
        parts.append(raw.strip())
        reader.i += 1
    while parts and parts[-1] == '':
        parts.pop()
    if style[0] == '|':
        return '\n'.join(parts)
    return ' '.join(part for part in parts if part)


def _value(reader, indent, val):
    if val in BLOCK_STYLES:
        return _block_scalar(reader, indent, val)
    if val != '':
        return _scalar(val)
    nxt = reader.peek()
    if nxt is None or nxt[0] <= indent:
        return None
    if nxt[1].startswith('- ') or nxt[1] == '-':
        return _list(reader, nxt[0])
    return _mapping(reader, nxt[0])


def _list(reader, indent):
    items = []
    while True:
        nxt = reader.peek()
        if nxt is None or nxt[0] != indent:
            break
        if not (nxt[1].startswith('- ') or nxt[1] == '-'):
            break
        body = nxt[1][1:].strip()
        reader.i += 1
        pair = _key(body)
        if pair is not None:
            item = {pair[0]: _value(reader, indent + 2, pair[1])}
            item.update(_mapping(reader, indent + 2))
            items.append(item)
        else:
            items.append(_scalar(body))
    return items


def _mapping(reader, indent):
    out = {}
    while True:
        nxt = reader.peek()
        if nxt is None or nxt[0] < indent:
            break
        if nxt[0] > indent or nxt[1].startswith('- '):
            raise ValueError('cannot parse %r at indent %d' % (nxt[1], nxt[0]))
        pair = _key(nxt[1])
        if pair is None:
            raise ValueError('cannot parse %r' % nxt[1])
        reader.i += 1
        out[pair[0]] = _value(reader, indent, pair[1])
    return out


def load(path):
    """Parse a shard. Uses PyYAML when available, else the fallback reader."""
    if yaml is not None:
        with open(path) as fh:
            return yaml.safe_load(fh)
    with open(path) as fh:
        reader = _Reader(fh.read().split('\n'))
    first = reader.peek()
    if first is None:
        return {}
    doc = _mapping(reader, first[0])
    if reader.peek() is not None:
        raise ValueError('%s: trailing content the fallback reader cannot parse' % path)
    return doc


def is_url(v):
    return isinstance(v, str) and bool(URL.match(v))


def flag(errs, where, key, v):
    """Tri-state: True, False, or None for `nobody checked`."""
    if v is not None and not isinstance(v, bool):
        errs.append('%s.%s: expected a boolean or null' % (where, key))


def text(errs, where, key, v):
    if v is not None and not isinstance(v, str):
        errs.append('%s.%s: expected a string or null' % (where, key))


def iso_date(v):
    v = v.isoformat() if isinstance(v, datetime.date) else v
    if not isinstance(v, str):
        return False
    try:
        datetime.date.fromisoformat(v)
    except ValueError:
        return False
    return len(v) == 10


def check_offering(errs, where, off):
    """The optional `offering` block: Layer 1 facts + the Layer 2 sample.

    Every rule here exists to stop a row reading more confidently than the page
    it was read off -- the same reason the apis.yaml validator has them:
      * `summary` is ONE line, so a list of entries stays a list.
      * `categories` comes from a closed list, so the field stays searchable.
      * a free tier that claims to exist has to say WHAT is free.
      * `verified_url` and `verified_date` are required together.
      * `highlights` is capped: it is a sample, and `catalog_url` is the
        vendor's own live list.
    """
    at = '%s.offering' % where
    if off is None:
        return
    if not isinstance(off, dict):
        errs.append('%s: expected a mapping or null' % at)
        return
    for k in off:
        if k not in OFFERING_KEYS:
            errs.append('%s.%s: unknown field' % (at, k))

    summary = off.get('summary')
    if summary is not None:
        if not isinstance(summary, str) or not summary.strip():
            errs.append('%s.summary: expected a non-empty string or null' % at)
        elif '\n' in summary or '\r' in summary:
            errs.append('%s.summary: expected a single line (no line breaks)' % at)
        elif len(summary) > OFFERING_SUMMARY_MAX:
            errs.append('%s.summary: expected at most %d characters, got %d'
                        % (at, OFFERING_SUMMARY_MAX, len(summary)))

    cats = off.get('categories')
    if cats is not None:
        if not isinstance(cats, list) or not cats:
            errs.append('%s.categories: expected a non-empty list or null' % at)
        else:
            bad = [c for c in cats if c not in SERVICE_CATEGORIES]
            if bad:
                errs.append('%s.categories: %s not in %s'
                            % (at, bad, ' | '.join(SERVICE_CATEGORIES)))
            if len(set(cats)) != len(cats):
                errs.append('%s.categories: has duplicates' % at)
            if len(cats) > OFFERING_CATEGORIES_MAX:
                errs.append('%s.categories: expected at most %d categories, got %d'
                            ' -- Layer 1 is a summary'
                            % (at, OFFERING_CATEGORIES_MAX, len(cats)))

    for k in ('endpoint_count', 'model_count'):
        v = off.get(k)
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            errs.append('%s.%s: expected a non-negative integer or null' % (at, k))
    text(errs, at, 'count_note', off.get('count_note'))

    free = off.get('free_tier')
    if free is not None:
        fat = '%s.free_tier' % at
        if not isinstance(free, dict):
            errs.append('%s: expected a mapping or null' % fat)
        else:
            for k in free:
                if k not in FREE_TIER_KEYS:
                    errs.append('%s.%s: unknown field' % (fat, k))
            for k in ('available', 'requires_key', 'requires_account'):
                flag(errs, fat, k, free.get(k))
            text(errs, fat, 'what', free.get('what'))
            text(errs, fat, 'limits', free.get('limits'))
            what = free.get('what')
            if free.get('available') is True and (not isinstance(what, str) or not what.strip()):
                errs.append('%s.what: required when available is true -- say what is'
                            " actually free, in the vendor's own numbers" % fat)
            if free.get('available') is False and isinstance(what, str):
                errs.append('%s.what: must be null when available is false'
                            ' (nothing is free to describe)' % fat)

    conn = off.get('connect')
    if conn is not None:
        cat = '%s.connect' % at
        if not isinstance(conn, dict):
            errs.append('%s: expected a mapping or null' % cat)
        else:
            for k in conn:
                if k not in CONNECT_KEYS:
                    errs.append('%s.%s: unknown field' % (cat, k))
            if conn.get('base_url') is not None and not is_url(conn.get('base_url')):
                errs.append('%s.base_url: expected an http(s) URL or null' % cat)
            auth = conn.get('auth')
            if auth is not None and auth not in CONNECT_AUTH_KINDS:
                errs.append('%s.auth: expected one of %s or null'
                            % (cat, ' | '.join(CONNECT_AUTH_KINDS)))
            header = conn.get('auth_header')
            if header is not None:
                if not isinstance(header, str) or not header.strip():
                    errs.append('%s.auth_header: expected a non-empty header name or null' % cat)
                elif not HEADER_NAME.match(header):
                    errs.append('%s.auth_header: expected a header name only, with no'
                                ' colon or spaces' % cat)
            fmt = conn.get('auth_format')
            if fmt is not None:
                if not isinstance(fmt, str) or not fmt.strip():
                    errs.append('%s.auth_format: expected a non-empty template or null' % cat)
                elif '{key}' not in fmt:
                    errs.append('%s.auth_format: must contain the {key} placeholder' % cat)
                if not isinstance(header, str):
                    errs.append('%s.auth_header: required when auth_format is set'
                                ' (which header holds it?)' % cat)
            # `auth: none` is a statement that there is no credential. A header
            # name beside it means one of the two came off the wrong page.
            if auth == 'none' and isinstance(header, str):
                errs.append('%s.auth: "none" contradicts auth_header %r -- use'
                            ' `unknown` if nobody checked' % (cat, header))

    if off.get('catalog_url') is not None and not is_url(off.get('catalog_url')):
        errs.append('%s.catalog_url: expected an http(s) URL or null' % at)
    if off.get('verified_url') is not None and not is_url(off.get('verified_url')):
        errs.append('%s.verified_url: expected an http(s) URL or null' % at)

    date = off.get('verified_date')
    if date is not None:
        if not iso_date(date):
            errs.append('%s.verified_date: expected an ISO date (YYYY-MM-DD) or null' % at)
        elif off.get('verified_url') is None:
            errs.append('%s.verified_url: required when verified_date is set'
                        ' (verified where?)' % at)
    elif off.get('verified_url') is not None:
        errs.append('%s.verified_date: required when verified_url is set'
                    ' (verified when?)' % at)

    srcs = off.get('source_urls')
    if srcs is not None:
        if not isinstance(srcs, list) or any(not is_url(u) for u in srcs):
            errs.append('%s.source_urls: expected a list of http(s) URLs or null' % at)

    hi = off.get('highlights')
    if hi is None:
        return
    hat = '%s.highlights' % at
    if not isinstance(hi, list):
        errs.append('%s: expected a list or null' % hat)
        return
    if not hi:
        errs.append('%s: expected a non-empty list or null (null means none recorded)' % hat)
        return
    if len(hi) > HIGHLIGHTS_MAX:
        errs.append('%s: expected at most %d entries, got %d -- highlights are a'
                    ' sample, not the catalog (point an agent at'
                    ' offering.catalog_url)' % (hat, HIGHLIGHTS_MAX, len(hi)))
    seen = set()
    for n, row in enumerate(hi):
        rat = '%s[%d]' % (hat, n)
        if not isinstance(row, dict):
            errs.append('%s: expected a mapping' % rat)
            continue
        for k in row:
            if k not in HIGHLIGHT_ROW_KEYS:
                errs.append('%s.%s: unknown field' % (rat, k))
        rid = row.get('id')
        if not isinstance(rid, str) or not rid.strip():
            errs.append("%s.id: expected a non-empty string (the vendor's own model"
                        ' id or path)' % rat)
        elif rid in seen:
            errs.append('%s.id: duplicate highlight %r' % (rat, rid))
        else:
            seen.add(rid)
        if row.get('kind') not in HIGHLIGHT_KINDS:
            errs.append('%s.kind: expected one of %s'
                        % (rat, ' | '.join(HIGHLIGHT_KINDS)))
        flag(errs, rat, 'free', row.get('free'))
        text(errs, rat, 'note', row.get('note'))
        if row.get('url') is not None and not is_url(row.get('url')):
            errs.append('%s.url: expected an http(s) URL or null' % rat)


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
                if k not in REQUIRED and k not in OPTIONAL:
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

            if 'offering' in e:
                check_offering(errs, where, e['offering'])

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
