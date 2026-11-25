#!/usr/bin/env python3
"""Schema validator for the SkeletonKey API index shards (data/apis/*.yaml).

Checks, per entry:
  * the required key set, no missing, and no key outside required + optional
  * enum membership for access_mode / signup / signup_automatable / auth_type
  * checked_date is a real ISO date (YYYY-MM-DD)
  * ids unique across every shard, and slug-shaped
  * seen_in is a non-empty subset of {glasser, monid, flatkey, vendor-direct}
  * the optional `access_modes` list, for a vendor documenting more than one way
    in, whose first element must equal access_mode
  * category matches the filename the entry lives in
  * provider_url / docs_url / source_url are http(s) URLs when not null
  * min_topup / billing_unit / free_tier are null or of a sane type
  * the optional `offering` block: a one-line summary, service categories from a
    closed list, approximate counts, what is free, how to connect, the vendor's
    own catalog URL, and at most HIGHLIGHTS_MAX highlighted models/endpoints
  * the optional `usage_api` block: whether the vendor documents an API to
    check your own usage/spend/quota, and the method/path/docs_url for it
  * the optional structured core fields (ND-8): `official_docs_url`, `auth`,
    `pricing`, `endpoints` and `endpoints_note` -- the vendor's own docs URL,
    how its endpoint is credentialed, what it charges, and a capped list of
    its documented endpoints
  * the optional `pricing.cost_label` (ND-18b): FREE | PAYG | SUBS, derived
    from `pricing.api_access_gate` and `pricing.model`, plus the hand-filled
    `pricing.free_usage_source_url` FREE requires -- see derive_cost_label()

`offering`, `usage_api` and the ND-8 fields are OPTIONAL on every row: a shard
written before they existed validates unchanged. They mirror the blocks
src/apis.ts enforces for apis.yaml, field for field, so one schema covers both files.

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
# adding one to a shard cannot invalidate the rows that do not have it. This is
# the list the "unexpected key" check reads: a row carrying none of them is
# exactly as valid as it was before any of them existed.
OPTIONAL = ['offering', 'access_modes', 'official_docs_url', 'auth', 'pricing',
            'endpoints', 'endpoints_note', 'alternatives', 'alternatives_note',
            'cost_badge', 'collection_scope', 'visibility', 'visibility_note',
            'usage_api']

# ---- catalog scope (Bei, 2026-11-24) ----------------------------------------
# Kept byte-identical in meaning to src/apis.ts (COLLECTION_SCOPES, VISIBILITIES,
# VISIBILITY_NOTE_MAX, TOOL_SCOPE_CATEGORIES). test/collection-scope.test.ts
# asserts the two lists have not drifted apart.
COLLECTION_SCOPES = ['tool', 'data', 'aggregator', 'llm']
VISIBILITIES = ['listed', 'hidden']
VISIBILITY_NOTE_MAX = 300
TOOL_SCOPE_CATEGORIES = {
    'generative-media', 'web-search', 'web-scraping', 'seo-marketing',
    'developer-infra', 'communications', 'contact-verification',
}


def effective_collection_scope(category, collection_scope=None):
    """Mirrors src/apis.ts effectiveCollectionScope for a shard row (always has
    a category, so the access_mode fallback there never applies here)."""
    if collection_scope:
        return collection_scope
    if category == 'llm-models':
        return 'llm'
    if category in TOOL_SCOPE_CATEGORIES:
        return 'tool'
    return 'data'


def effective_visibility(category, collection_scope=None, visibility=None):
    """Mirrors src/apis.ts effectiveVisibility for a shard row."""
    if visibility:
        return visibility
    return 'hidden' if effective_collection_scope(category, collection_scope) == 'llm' else 'listed'


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
# Where a row's facts came from. The three aggregator catalogs build.py reads,
# plus `vendor-direct` for a row read off the VENDOR's own pages with no
# aggregator in the loop (build.py emits it for curated.VENDOR_DIRECT ids; the
# TypeScript side calls the same set SHARD_SEEN_IN_SOURCES in src/apis.ts).
SOURCES = {'glasser', 'monid', 'flatkey', 'vendor-direct'}
VENDOR_DIRECT = 'vendor-direct'
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

# ---- the optional `usage_api` block -----------------------------------------
# Whether the vendor documents an API to check your OWN usage/spend/quota,
# separate from the product API the rest of the row describes. Kept
# byte-identical in meaning to src/apis.ts's `validateUsageApi`.
USAGE_API_KEYS = ['available', 'method', 'path', 'docs_url', 'limits', 'notes',
                  'checked_date']
USAGE_API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

# ---- the structured core fields (ND-8) --------------------------------------
# Kept byte-identical in meaning to src/apis.ts (AUTH_TYPES, PRICING_MODELS,
# HTTP_METHODS, ENDPOINTS_MAX, ENDPOINT_SUMMARY_MAX, ENDPOINT_RETURNS_MAX,
# PRICING_NOTES_MAX, ENDPOINTS_NOTE_MAX). test/structured-fields.test.ts
# asserts the lists have not drifted apart.
AUTH_TYPES = ['api_key', 'bearer', 'oauth2', 'basic', 'none', 'other', 'unknown']
PRICING_MODELS = ['free', 'freemium', 'pay_as_you_go', 'subscription',
                  'prepaid_credits', 'contact_sales', 'unknown']
HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
ENDPOINTS_MAX = 50
ENDPOINT_SUMMARY_MAX = 200
ENDPOINT_RETURNS_MAX = 200
PRICING_NOTES_MAX = 300
ENDPOINTS_NOTE_MAX = 300
AUTH_KEYS = ['type', 'header', 'format', 'docs_url']
PRICING_KEYS = ['model', 'free_tier', 'starting_price_usd', 'unit',
                'pricing_url', 'notes', 'api_access_gate', 'min_monthly_usd',
                'min_prepay_usd', 'gate_source_url', 'free_usage_source_url',
                'cost_label']
ENDPOINT_ROW_KEYS = ['method', 'path', 'summary', 'returns', 'docs_url']

# ---- the pricing gate (ND-12) ------------------------------------------------
# Kept byte-identical in meaning to src/apis.ts (API_ACCESS_GATES,
# ALTERNATIVE_ACCESS_GATES, COST_BADGES, ALTERNATIVES_WHY_MAX,
# ALTERNATIVES_NOTE_MAX). test/pricing-gate.test.ts asserts the lists have not
# drifted apart.
API_ACCESS_GATES = ['none', 'prepaid_min', 'subscription_required',
                     'contact_sales', 'unknown']
# `unknown` says nothing about how the ALTERNATIVE itself is gated, so it is
# excluded from the gates an alternatives[] row may cite.
ALTERNATIVE_ACCESS_GATES = ['none', 'prepaid_min', 'subscription_required',
                             'contact_sales']
GATED_ACCESS_GATES = ('subscription_required', 'contact_sales')
COST_BADGES = ['green', 'red', 'gray']
ALTERNATIVES_WHY_MAX = 200
ALTERNATIVES_NOTE_MAX = 300
ALTERNATIVE_ROW_KEYS = ['vendor_id', 'why', 'access_gate']

# ---- the cost label (ND-18b) -------------------------------------------------
# Kept byte-identical in meaning to src/apis.ts (COST_LABELS, deriveCostLabel).
# test/pricing-gate.test.ts (or a sibling cost-label test) asserts the two
# lists and the derivation have not drifted apart.
COST_LABELS = ['FREE', 'PAYG', 'SUBS']

HERE = os.path.dirname(os.path.abspath(__file__))
# The repo's own apis.yaml, fixed relative to this script -- NOT relative to
# whatever shard directory a caller passes to main(). A vendor_id may point at
# a root apis.yaml entry regardless of which shard directory is being checked.
REPO_APIS_YAML = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'apis.yaml'))


def derive_cost_badge(pricing):
    """`pricing` -> `cost_badge`. The one place this mapping is computed, so
    this validator (which only checks a hand-filled value agrees) and
    build.py (which writes the computed value) can never drift apart."""
    if not isinstance(pricing, dict):
        return 'gray'
    gate = pricing.get('api_access_gate')
    if gate in ('none', 'prepaid_min'):
        return 'green'
    if gate in ('subscription_required', 'contact_sales'):
        return 'red'
    return 'gray'


def derive_cost_label(pricing):
    """`pricing` -> `pricing.cost_label` (ND-18b/d): 'FREE' | 'PAYG' | 'SUBS' |
    None. The one place this mapping is computed, so this validator (which
    only checks a value already on the row agrees) and build.py (which
    writes the computed value) can never drift apart. See ../README.md
    "ND-18b cost_label" for the full rule table.

    SUBS only when `api_access_gate` is itself `subscription_required`.
    `pricing.model` is never consulted -- a vendor billing itself as a
    subscription says nothing about whether the API *access* requires one;
    only a verified gate does. FREE requires BOTH a verified `none` gate AND
    a sourced http(s) `free_usage_source_url` -- `prepaid_min` is never FREE
    even when a trial/signup credit exists.
    """
    if not isinstance(pricing, dict):
        return None
    gate = pricing.get('api_access_gate')

    if gate == 'subscription_required':
        return 'SUBS'

    if gate == 'none':
        url = pricing.get('free_usage_source_url')
        if isinstance(url, str) and url.startswith('http'):
            return 'FREE'
        return 'PAYG'

    if gate == 'prepaid_min':
        return 'PAYG'

    return None  # unknown, contact_sales, missing, or any other gate


def collect_known_vendor_ids(root):
    """Every id an `alternatives[].vendor_id` may reference: every shard
    row's `id` across every *.yaml in `root`, plus every entry `name` in the
    repo's own apis.yaml. Best-effort: a file that fails to parse (e.g.
    apis.yaml read by the no-PyYAML fallback reader, which does not cover its
    full structure) contributes no ids rather than raising."""
    ids = set()
    for path in sorted(glob.glob(os.path.join(root, '*.yaml'))):
        try:
            doc = load(path)
        except Exception:
            continue
        if not isinstance(doc, dict):
            continue
        for e in (doc.get('apis') or []):
            if isinstance(e, dict) and isinstance(e.get('id'), str):
                ids.add(e['id'])
    if os.path.exists(REPO_APIS_YAML):
        try:
            doc = load(REPO_APIS_YAML)
        except Exception:
            doc = None
        if isinstance(doc, dict):
            for e in (doc.get('entries') or []):
                if isinstance(e, dict) and isinstance(e.get('name'), str):
                    ids.add(e['name'])
        else:
            ids |= scan_apis_yaml_entry_names(REPO_APIS_YAML)
    return ids


ENTRY_NAME_LINE = re.compile(r'^  - name:\s*(.+?)\s*$')


def scan_apis_yaml_entry_names(path):
    """Entry names from the repo's apis.yaml by a plain line scan, for when
    `load()` can't turn the whole file into a dict (the fallback reader only
    covers the shard subset of YAML, not apis.yaml's full structure). Looks
    for the top-level entries list's `  - name: <value>` lines, quotes
    stripped, appearing after the top-level `entries:` line."""
    names = set()
    in_entries = False
    with open(path) as fh:
        for line in fh:
            line = line.rstrip('\n')
            if line == 'entries:':
                in_entries = True
                continue
            if not in_entries:
                continue
            match = ENTRY_NAME_LINE.match(line)
            if match is None:
                continue
            value = match.group(1)
            if len(value) > 1 and value[0] == value[-1] and value[0] in '"\'':
                value = value[1:-1]
            names.add(value)
    return names


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


def check_access_modes(errs, where, e):
    """The optional `access_modes` list: every way in the vendor documents.

    Element 0 must equal `access_mode`, the single field every reader uses --
    mirrors validateAccessModes() in src/apis.ts, including the message.
    """
    modes = e.get('access_modes')
    if modes is None:
        return
    allowed = ENUMS['access_mode']
    if not isinstance(modes, list):
        errs.append('%s.access_modes: expected a list or null' % where)
        return
    if not modes:
        errs.append('%s.access_modes: expected a non-empty list or null '
                    '(null means access_mode is the whole story)' % where)
        return
    if len(modes) > len(allowed):
        errs.append('%s.access_modes: expected at most %d modes, got %d'
                    % (where, len(allowed), len(modes)))
    seen = set()
    for i, m in enumerate(modes):
        if m not in allowed:
            errs.append('%s.access_modes[%d]: expected one of %s'
                        % (where, i, sorted(allowed)))
            continue
        if m in seen:
            errs.append('%s.access_modes[%d]: duplicate mode %r' % (where, i, m))
        seen.add(m)
    if modes[0] != e.get('access_mode'):
        errs.append('%s.access_modes[0]: must match access_mode %r -- the primary '
                    'mode is the one SkeletonKey actually uses'
                    % (where, e.get('access_mode')))


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


def check_usage_api(errs, where, ua):
    """The optional `usage_api` block: does the vendor expose an API to check
    your OWN usage/spend/quota, separate from the product API the rest of the
    row describes. Mirrors src/apis.ts's `validateUsageApi`, field for field:
      * `available` and `checked_date` are required keys.
      * `method`/`path` are required, non-null, when available is true.
      * `docs_url` is required, non-null, whenever available is true or false.
    """
    at = '%s.usage_api' % where
    if ua is None:
        return
    if not isinstance(ua, dict):
        errs.append('%s: expected a mapping or null' % at)
        return
    for k in ua:
        if k not in USAGE_API_KEYS:
            errs.append('%s.%s: unknown field' % (at, k))

    if 'available' not in ua:
        errs.append('%s.available: missing (use null if unknown)' % at)
    available = ua.get('available')
    flag(errs, at, 'available', available)

    method = ua.get('method')
    if method is not None and method not in USAGE_API_METHODS:
        errs.append('%s.method: expected one of %s or null'
                    % (at, ' | '.join(USAGE_API_METHODS)))
    text(errs, at, 'path', ua.get('path'))
    text(errs, at, 'limits', ua.get('limits'))
    text(errs, at, 'notes', ua.get('notes'))

    docs_url = ua.get('docs_url')
    if docs_url is not None and not is_url(docs_url):
        errs.append('%s.docs_url: expected an http(s) URL or null' % at)

    if available is True:
        if not isinstance(method, str) or not method.strip():
            errs.append('%s.method: required when available is true'
                        ' (how is it called?)' % at)
        path = ua.get('path')
        if not isinstance(path, str) or not path.strip():
            errs.append('%s.path: required when available is true'
                        ' (what is the endpoint?)' % at)
    if available is True or available is False:
        if not isinstance(docs_url, str) or not docs_url.strip():
            errs.append('%s.docs_url: required when available is true or false'
                        ' (where was this verified?)' % at)

    if 'checked_date' not in ua:
        errs.append('%s.checked_date: missing (when was this checked?)' % at)
    else:
        checked = ua.get('checked_date')
        if not iso_date(checked):
            errs.append('%s.checked_date: expected an ISO date (YYYY-MM-DD)' % at)


def check_collection(errs, where, e):
    """The optional `collection_scope` / `visibility` / `visibility_note` fields.

    `visibility: hidden` is deliberately NOT required to carry a note -- same
    rule as the TS validator.
    """
    scope = e.get('collection_scope')
    if scope is not None and scope not in COLLECTION_SCOPES:
        errs.append('%s.collection_scope: must be one of %s' % (where, ', '.join(COLLECTION_SCOPES)))
    visibility = e.get('visibility')
    if visibility is not None and visibility not in VISIBILITIES:
        errs.append('%s.visibility: must be one of %s' % (where, ', '.join(VISIBILITIES)))
    note = e.get('visibility_note')
    if note is not None:
        if not isinstance(note, str) or not note.strip():
            errs.append('%s.visibility_note: expected a non-empty string or null' % where)
        elif '\n' in note or '\r' in note:
            errs.append('%s.visibility_note: expected a single line (no line breaks)' % where)
        elif len(note) > VISIBILITY_NOTE_MAX:
            errs.append('%s.visibility_note: expected at most %d characters, got %d'
                        % (where, VISIBILITY_NOTE_MAX, len(note)))


def check_structured_fields(errs, where, e, known_vendor_ids):
    """The five structured core fields (ND-8): `official_docs_url`, `auth`,
    `pricing`, `endpoints`, `endpoints_note`, plus the ND-12 pricing-gate
    fields nested in `pricing` and the top-level `alternatives` /
    `alternatives_note` / `cost_badge`. All optional, all null-when-unknown,
    mirroring src/apis.ts field for field.

    `known_vendor_ids` is only used for `alternatives[].vendor_id`
    cross-referencing -- see check_alternatives."""
    if e.get('official_docs_url') is not None and not is_url(e.get('official_docs_url')):
        errs.append('%s.official_docs_url: expected an http(s) URL or null' % where)
    check_auth(errs, where, e.get('auth'))
    check_pricing(errs, where, e.get('pricing'))
    check_endpoints(errs, where, e)
    check_alternatives(errs, where, e, known_vendor_ids)
    check_cost_badge(errs, where, e)


def check_auth(errs, where, auth):
    """`auth`: how the vendor's endpoint is credentialed. `type` is required
    whenever the block exists; `header`/`format` must be null when `type` is
    `none`, and `format` must carry a `<...>` placeholder, never a real key."""
    at = '%s.auth' % where
    if auth is None:
        return
    if not isinstance(auth, dict):
        errs.append('%s: expected a mapping or null' % at)
        return
    for k in auth:
        if k not in AUTH_KEYS:
            errs.append('%s.%s: unknown field' % (at, k))
    if 'type' not in auth:
        errs.append('%s.type: missing (required when auth is set)' % at)
    elif auth.get('type') not in AUTH_TYPES:
        errs.append('%s.type: expected one of %s' % (at, ' | '.join(AUTH_TYPES)))
    header = auth.get('header')
    if header is not None:
        if not isinstance(header, str) or not header.strip():
            errs.append('%s.header: expected a non-empty header name or null' % at)
        elif not HEADER_NAME.match(header):
            errs.append('%s.header: expected a header name only, with no colon'
                        ' or spaces' % at)
    fmt = auth.get('format')
    if fmt is not None:
        if not isinstance(fmt, str) or not fmt.strip():
            errs.append('%s.format: expected a non-empty template or null' % at)
        elif not re.search(r'<[^<>]+>', fmt):
            errs.append('%s.format: must contain a <...> placeholder' % at)
    if auth.get('type') == 'none':
        if isinstance(header, str):
            errs.append('%s.header: must be null when type is none' % at)
        if isinstance(fmt, str):
            errs.append('%s.format: must be null when type is none' % at)
    if auth.get('docs_url') is not None and not is_url(auth.get('docs_url')):
        errs.append('%s.docs_url: expected an http(s) URL or null' % at)


def check_pricing(errs, where, pricing):
    """`pricing`: what the vendor charges. `starting_price_usd` is never
    guessed, the same rule `min_topup` and `billing` follow elsewhere."""
    at = '%s.pricing' % where
    if pricing is None:
        return
    if not isinstance(pricing, dict):
        errs.append('%s: expected a mapping or null' % at)
        return
    for k in pricing:
        if k not in PRICING_KEYS:
            errs.append('%s.%s: unknown field' % (at, k))
    model = pricing.get('model')
    if model is not None and model not in PRICING_MODELS:
        errs.append('%s.model: expected one of %s or null'
                    % (at, ' | '.join(PRICING_MODELS)))
    flag(errs, at, 'free_tier', pricing.get('free_tier'))
    price = pricing.get('starting_price_usd')
    if price is not None:
        if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0:
            errs.append('%s.starting_price_usd: expected a non-negative number'
                        ' or null' % at)
    text(errs, at, 'unit', pricing.get('unit'))
    if pricing.get('pricing_url') is not None and not is_url(pricing.get('pricing_url')):
        errs.append('%s.pricing_url: expected an http(s) URL or null' % at)
    notes = pricing.get('notes')
    if notes is not None:
        if not isinstance(notes, str) or not notes.strip():
            errs.append('%s.notes: expected a non-empty string or null' % at)
        elif '\n' in notes or '\r' in notes:
            errs.append('%s.notes: expected a single line (no line breaks)' % at)
        elif len(notes) > PRICING_NOTES_MAX:
            errs.append('%s.notes: expected at most %d characters, got %d'
                        % (at, PRICING_NOTES_MAX, len(notes)))

    # ---- the pricing gate (ND-12) --------------------------------------------
    gate = pricing.get('api_access_gate')
    if gate is not None and gate not in API_ACCESS_GATES:
        errs.append('%s.api_access_gate: expected one of %s or null'
                    % (at, ' | '.join(API_ACCESS_GATES)))
    min_monthly = pricing.get('min_monthly_usd')
    if min_monthly is not None:
        if isinstance(min_monthly, bool) or not isinstance(min_monthly, (int, float)) or min_monthly < 0:
            errs.append('%s.min_monthly_usd: expected a non-negative number or null' % at)
        if gate != 'subscription_required':
            errs.append('%s.min_monthly_usd: only allowed when pricing.api_access_gate'
                        ' is subscription_required' % at)
    min_prepay = pricing.get('min_prepay_usd')
    if min_prepay is not None:
        if isinstance(min_prepay, bool) or not isinstance(min_prepay, (int, float)) or min_prepay < 0:
            errs.append('%s.min_prepay_usd: expected a non-negative number or null' % at)
        if gate != 'prepaid_min':
            errs.append('%s.min_prepay_usd: only allowed when pricing.api_access_gate'
                        ' is prepaid_min' % at)
    gate_source_url = pricing.get('gate_source_url')
    if gate_source_url is not None and not is_url(gate_source_url):
        errs.append('%s.gate_source_url: expected an http(s) URL or null' % at)
    if gate is not None and gate != 'unknown' and gate_source_url is None:
        errs.append('%s.gate_source_url: required when pricing.api_access_gate is set'
                    ' and not unknown (what proves the gate?)' % at)

    # ---- the cost label (ND-18b) ----------------------------------------------
    expected_label = derive_cost_label(pricing)
    if 'cost_label' in pricing:
        got_label = pricing.get('cost_label')
        # Presence is only ever valid when expected_label is NOT None -- a
        # key present (any value, explicit null included) while the derived
        # value is None is rejected just like a mismatch, not silently
        # accepted because None == None.
        if expected_label is None or got_label != expected_label:
            errs.append('%s.cost_label: derived field; expected %s from pricing,'
                        ' got %s (do not hand-edit; run build)'
                        % (at, expected_label, got_label))

    free_url = pricing.get('free_usage_source_url')
    has_free_url = 'free_usage_source_url' in pricing
    if has_free_url and free_url is not None and not is_url(free_url):
        errs.append('%s.free_usage_source_url: expected an http(s) URL or null' % at)
    if expected_label == 'FREE':
        if not (isinstance(free_url, str) and free_url.startswith('http')):
            errs.append('%s.free_usage_source_url: required when the derived'
                        ' cost_label is FREE (what proves the free allowance?)' % at)
    elif has_free_url:
        errs.append('%s.free_usage_source_url: only allowed when the derived'
                    ' cost_label is FREE' % at)


def check_alternatives(errs, where, e, known_vendor_ids):
    """`alternatives` + `alternatives_note` (ND-12): required together with
    `pricing.api_access_gate` in {subscription_required, contact_sales} --
    that is the whole point: a row that forces a recurring fee or a sales
    call must say where else to go. Forbidden otherwise, so the field can
    never read as "checked" on a row nobody gated. `vendor_id` must resolve
    to a real index entry (never invented), never the row's own id, and
    never repeated within one list."""
    pricing = e.get('pricing')
    gate = pricing.get('api_access_gate') if isinstance(pricing, dict) else None
    gated = gate in GATED_ACCESS_GATES
    alts = e.get('alternatives')
    note = e.get('alternatives_note')
    self_id = e.get('id')

    if gated:
        if not isinstance(alts, list):
            errs.append('%s.alternatives: required (a list) when pricing.api_access_gate'
                        ' is subscription_required or contact_sales' % where)
        else:
            seen = set()
            for n, row in enumerate(alts):
                rat = '%s.alternatives[%d]' % (where, n)
                if not isinstance(row, dict):
                    errs.append('%s: expected a mapping' % rat)
                    continue
                for k in row:
                    if k not in ALTERNATIVE_ROW_KEYS:
                        errs.append('%s.%s: unknown field' % (rat, k))
                vid = row.get('vendor_id')
                valid_vid = isinstance(vid, str) and vid.strip() != ''
                if not valid_vid:
                    errs.append('%s.vendor_id: expected a non-empty string' % rat)
                elif vid == self_id:
                    errs.append("%s.vendor_id: must not equal this row's own id" % rat)
                elif vid in seen:
                    errs.append('%s.vendor_id: duplicate vendor_id %r' % (rat, vid))
                elif vid not in known_vendor_ids:
                    errs.append('%s.vendor_id: unknown vendor %r -- not a shard id or'
                                ' apis.yaml name' % (rat, vid))
                if valid_vid:
                    seen.add(vid)
                why = row.get('why')
                if not isinstance(why, str) or not why.strip():
                    errs.append('%s.why: expected a non-empty string' % rat)
                elif '\n' in why or '\r' in why:
                    errs.append('%s.why: expected a single line (no line breaks)' % rat)
                elif len(why) > ALTERNATIVES_WHY_MAX:
                    errs.append('%s.why: expected at most %d characters, got %d'
                                % (rat, ALTERNATIVES_WHY_MAX, len(why)))
                access_gate = row.get('access_gate')
                if access_gate not in ALTERNATIVE_ACCESS_GATES:
                    errs.append('%s.access_gate: expected one of %s'
                                % (rat, ' | '.join(ALTERNATIVE_ACCESS_GATES)))
            if isinstance(alts, list) and not alts:
                if not isinstance(note, str) or not note.strip():
                    errs.append('%s.alternatives: expected a non-empty alternatives_note'
                                ' when alternatives is [] -- say where else to go' % where)
    elif alts is not None:
        errs.append('%s.alternatives: must be absent or null unless pricing.api_access_gate'
                    ' is subscription_required or contact_sales' % where)

    if note is not None:
        if not isinstance(note, str) or not note.strip():
            errs.append('%s.alternatives_note: expected a non-empty string or null' % where)
        elif '\n' in note or '\r' in note:
            errs.append('%s.alternatives_note: expected a single line (no line breaks)' % where)
        elif len(note) > ALTERNATIVES_NOTE_MAX:
            errs.append('%s.alternatives_note: expected at most %d characters, got %d'
                        % (where, ALTERNATIVES_NOTE_MAX, len(note)))
        if not gated:
            errs.append('%s.alternatives_note: must be absent or null unless'
                        ' pricing.api_access_gate is subscription_required or'
                        ' contact_sales' % where)


def check_cost_badge(errs, where, e):
    """A hand-filled `cost_badge`, if present, must equal
    `derive_cost_badge(pricing)` exactly. `cost_badge` is written by
    build.py and never hand-filled, so this is the only check it gets --
    absence is always valid (old data, or a row build.py has not
    regenerated yet)."""
    if 'cost_badge' not in e:
        return
    expected = derive_cost_badge(e.get('pricing'))
    got = e.get('cost_badge')
    if got != expected:
        errs.append('%s.cost_badge: derived field; expected %s from'
                    ' pricing.api_access_gate, got %s (do not hand-edit; run build)'
                    % (where, expected, got))


def check_endpoints(errs, where, e):
    """`endpoints` + `endpoints_note`: `null` means not verified yet, `[]`
    means verified that there is no official self-serve API surface to list
    -- and an empty list REQUIRES `endpoints_note` to say why."""
    note = e.get('endpoints_note')
    if note is not None:
        if not isinstance(note, str) or not note.strip():
            errs.append('%s.endpoints_note: expected a non-empty string or null' % where)
        elif '\n' in note or '\r' in note:
            errs.append('%s.endpoints_note: expected a single line (no line'
                        ' breaks)' % where)
        elif len(note) > ENDPOINTS_NOTE_MAX:
            errs.append('%s.endpoints_note: expected at most %d characters, got %d'
                        % (where, ENDPOINTS_NOTE_MAX, len(note)))

    eps = e.get('endpoints')
    if eps is None:
        return
    at = '%s.endpoints' % where
    if not isinstance(eps, list):
        errs.append('%s: expected a list or null' % at)
        return
    if not eps:
        if not isinstance(note, str) or not note.strip():
            errs.append('%s: expected a non-empty endpoints_note when endpoints'
                        ' is [] -- say why there is no API surface to list' % at)
        return
    if len(eps) > ENDPOINTS_MAX:
        errs.append('%s: expected at most %d entries, got %d'
                    % (at, ENDPOINTS_MAX, len(eps)))
    seen = set()
    for n, row in enumerate(eps):
        rat = '%s[%d]' % (at, n)
        if not isinstance(row, dict):
            errs.append('%s: expected a mapping' % rat)
            continue
        for k in row:
            if k not in ENDPOINT_ROW_KEYS:
                errs.append('%s.%s: unknown field' % (rat, k))
        method = row.get('method')
        if method not in HTTP_METHODS:
            errs.append('%s.method: must be one of %s' % (rat, ', '.join(HTTP_METHODS)))
        p = row.get('path')
        path_key = ''
        if not isinstance(p, str) or not p.strip():
            errs.append('%s.path: expected a non-empty string starting with "/"' % rat)
        elif not p.startswith('/'):
            errs.append('%s.path: expected a path starting with "/"' % rat)
        elif re.search(r'\s', p):
            errs.append('%s.path: expected no whitespace' % rat)
        else:
            path_key = p
        if isinstance(method, str) and path_key:
            key = '%s %s' % (method, path_key)
            if key in seen:
                errs.append('%s: duplicate method+path %r' % (rat, key))
            else:
                seen.add(key)
        summary = row.get('summary')
        if summary is not None:
            if not isinstance(summary, str) or not summary.strip():
                errs.append('%s.summary: expected a non-empty string or null' % rat)
            elif '\n' in summary or '\r' in summary:
                errs.append('%s.summary: expected a single line (no line breaks)' % rat)
            elif len(summary) > ENDPOINT_SUMMARY_MAX:
                errs.append('%s.summary: expected at most %d characters, got %d'
                            % (rat, ENDPOINT_SUMMARY_MAX, len(summary)))
        returns = row.get('returns')
        if returns is not None:
            if not isinstance(returns, str) or not returns.strip():
                errs.append('%s.returns: expected a non-empty string or null' % rat)
            elif '\n' in returns or '\r' in returns:
                errs.append('%s.returns: expected a single line (no line breaks)' % rat)
            elif len(returns) > ENDPOINT_RETURNS_MAX:
                errs.append('%s.returns: expected at most %d characters, got %d'
                            % (rat, ENDPOINT_RETURNS_MAX, len(returns)))
        if row.get('docs_url') is not None and not is_url(row.get('docs_url')):
            errs.append('%s.docs_url: expected an http(s) URL or null' % rat)


def main(root):
    errs, seen_ids, total = [], {}, 0
    files = sorted(glob.glob(os.path.join(root, '*.yaml')))
    if not files:
        print('FAIL: no *.yaml shards found in %s' % root)
        return 1

    # Computed once, scanning every shard in `root` plus the repo's own
    # apis.yaml -- see collect_known_vendor_ids. Needed up front because a row
    # near the top of one shard may cite a vendor_id defined in a shard
    # processed later.
    known_ids = collect_known_vendor_ids(root)

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

            check_access_modes(errs, where, e)

            if 'offering' in e:
                check_offering(errs, where, e['offering'])
            check_structured_fields(errs, where, e, known_ids)

            check_collection(errs, where, e)

            if 'usage_api' in e:
                check_usage_api(errs, where, e['usage_api'])

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
