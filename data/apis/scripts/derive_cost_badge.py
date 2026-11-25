#!/usr/bin/env python3
"""Rewrites/inserts/removes `cost_badge` and `pricing.cost_label` lines in
shard YAML files in place, at the text level -- no raw/ required.

build.py already recomputes both on every row it regenerates (see its
README sections "ND-12 pricing gate" and "ND-18b cost_label"), but build.py
cannot run in a clean clone: `data/apis/raw/` is not committed (see
../README.md "Layout"). This script reaches the same result by editing the
shard text directly, touching only `cost_badge` and `pricing.cost_label`
lines and leaving everything else byte-for-byte untouched:

  - A row only gets a `cost_badge` line when its `pricing` block carries an
    `api_access_gate` key (any value, `unknown` included). A row with no
    such key gets NO `cost_badge` line -- a stale one left over from before
    is removed, not merely left wrong.
  - On a gated row, the line is placed exactly where build.py's `emit_row`
    puts it: right after the last of the ND-8/ND-12 structured blocks
    present on the row (`official_docs_url`, `auth`, `pricing`, `endpoints`,
    `endpoints_note`, `alternatives`, `alternatives_note`), before any other
    extra key.
  - A row's `pricing` block only gets a nested `cost_label` line when
    `validate.derive_cost_label(pricing)` is not None. It is placed as the
    LAST key inside the `pricing:` block (after `free_usage_source_url` when
    present), and a stale line is removed outright when the derived value
    is None, same as `cost_badge`. A `pricing: null` block, or a row with no
    `pricing` key at all, is left untouched.

An existing `cost_badge`/`cost_label` line already holding the right value
(or already absent, where none is due) is left alone, so a second run makes
no changes (idempotent).

Usage:
    python3 derive_cost_badge.py [--check] [dir]

--check reports what would change without writing, and exits 1 if anything
would -- the same contract `validate.py`'s exit code follows elsewhere in
this directory. With no `dir`, defaults to the directory this script lives
in (`data/apis`).
"""
import sys, os, glob, re
import validate

ID_RE = re.compile(r'^  - id: "([^"]*)"')
COST_BADGE_RE = re.compile(r'^    cost_badge:\s*(.*)$')
# The ND-8/ND-12 structured blocks, in the order emit_row emits them -- see
# build.py's STRUCTURED_FIELDS / PRICING_GATE_FIELDS and ../README.md.
STRUCTURED_FIELD_RE = re.compile(
    r'^    (official_docs_url|auth|pricing|endpoints|endpoints_note'
    r'|alternatives|alternatives_note):(.*)$')
# The row-level `pricing:` key (exactly 4 leading spaces, so a `pricing_url`
# or similar never matches), and a nested `cost_label` key inside it (6
# leading spaces, matching build.py's `_mapping_lines(pricing, keys, 6)`).
PRICING_LINE_RE = re.compile(r'^    pricing:\s*(.*)$')
COST_LABEL_RE = re.compile(r'^      cost_label:\s*(.*)$')


def row_spans(lines):
    """`[(start, end, id)]` -- `end` exclusive -- for every `- id: "..."` row
    in a shard's lines, in file order."""
    starts = [(i, m.group(1)) for i, line in enumerate(lines)
              for m in [ID_RE.match(line)] if m]
    spans = []
    for idx, (start, pid) in enumerate(starts):
        end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
        spans.append((start, end, pid))
    return spans


def structured_blocks_end(lines, start, end):
    """Index right after the last ND-8/ND-12 structured block present on the
    row (a one-line field, e.g. `pricing: null`, counts as its own whole
    block), or None when the row has none of them -- matching the order
    `emit_row` emits them in, so a newly inserted `cost_badge` lands exactly
    where a build.py rebuild would put it."""
    last = None
    i = start
    while i < end:
        m = STRUCTURED_FIELD_RE.match(lines[i])
        if not m:
            i += 1
            continue
        if m.group(2).strip():
            last = i + 1
            i += 1
            continue
        j = i + 1
        while j < end and (lines[j].startswith('      ') or not lines[j].strip()):
            j += 1
        last = j
        i = j
    return last


def pricing_block_span(lines, start, end):
    """`(block_start, block_end, is_one_liner)` for the row-level `pricing:`
    block within `[start, end)` -- `block_end` exclusive, `block_start` the
    `pricing:` line itself -- or None when the row has no `pricing` key at
    all. `is_one_liner` is True for `pricing: null` (or any other inline
    value), which has no nested keys to touch."""
    for i in range(start, end):
        m = PRICING_LINE_RE.match(lines[i])
        if not m:
            continue
        if m.group(1).strip():
            return i, i + 1, True
        j = i + 1
        while j < end and (lines[j].startswith('      ') or not lines[j].strip()):
            j += 1
        return i, j, False
    return None


def sync_cost_label(lines, start, end, pricing):
    """Inserts/updates/removes the nested `cost_label` line inside this
    row's `pricing:` block, in place. Returns `(end, changed)`: `end` is
    `start`'s row boundary, adjusted for any line inserted/removed here (the
    caller's own `cost_badge` placement -- `structured_blocks_end` -- must
    see the row's true, current boundary). No-ops when `pricing` is absent
    or a one-liner (`pricing: null`)."""
    block = pricing_block_span(lines, start, end)
    if block is None:
        return end, False
    bstart, bend, is_one_liner = block
    if is_one_liner:
        return end, False

    expected = validate.derive_cost_label(pricing) if isinstance(pricing, dict) else None
    existing_idx = None
    for i in range(bstart + 1, bend):
        if COST_LABEL_RE.match(lines[i]):
            existing_idx = i
            break

    if expected is None:
        if existing_idx is not None:
            del lines[existing_idx]
            return end - 1, True
        return end, False

    if existing_idx is not None:
        current = COST_LABEL_RE.match(lines[existing_idx]).group(1).strip().strip('"')
        if current == expected:
            return end, False
        lines[existing_idx] = '      cost_label: "%s"' % expected
        return end, True

    insert_at = bend
    while insert_at > bstart + 1 and lines[insert_at - 1].strip() == '':
        insert_at -= 1
    lines[insert_at:insert_at] = ['      cost_label: "%s"' % expected]
    return end + 1, True


def process(lines, rows):
    """Rewrites `lines` (a list, mutated in place) so every row's
    `cost_badge` matches build.py's rule: present and equal to
    `validate.derive_cost_badge(row['pricing'])` when `row['pricing']` is a
    mapping containing an `api_access_gate` key, absent otherwise. Also
    syncs the nested `pricing.cost_label` (ND-18b) via `sync_cost_label`.
    Returns the ids actually changed (inserted, corrected, or removed) --
    one entry per row, even when both `cost_badge` and `cost_label` changed
    on it."""
    changed = []
    # Walk from the end: inserting/removing a line shifts every later index,
    # and spans were computed once up front from the original (unmutated)
    # text.
    for start, end, pid in reversed(row_spans(lines)):
        row = rows.get(pid)
        if row is None:
            continue
        pricing = row.get('pricing')
        row_changed = False

        # `cost_label` is nested INSIDE the pricing block, which sits before
        # where `cost_badge` gets placed -- sync it first, and use its
        # (possibly adjusted) `end` for the cost_badge placement below.
        end, label_changed = sync_cost_label(lines, start, end, pricing)
        row_changed = row_changed or label_changed

        gated = isinstance(pricing, dict) and 'api_access_gate' in pricing
        expected = validate.derive_cost_badge(pricing) if gated else None

        existing_idx = None
        for i in range(start, end):
            if COST_BADGE_RE.match(lines[i]):
                existing_idx = i
                break

        if expected is None:
            if existing_idx is not None:
                del lines[existing_idx]
                row_changed = True
        elif existing_idx is not None:
            current = COST_BADGE_RE.match(lines[existing_idx]).group(1).strip().strip('"')
            if current != expected:
                lines[existing_idx] = '    cost_badge: "%s"' % expected
                row_changed = True
        else:
            insert_at = structured_blocks_end(lines, start, end)
            if insert_at is None:
                insert_at = end
            # `end` may be end-of-file, where the trailing `\n` split leaves a
            # blank final element -- insert before it, not after, so no blank
            # line opens up ahead of the new key.
            while insert_at > start and lines[insert_at - 1].strip() == '':
                insert_at -= 1
            lines[insert_at:insert_at] = ['    cost_badge: "%s"' % expected]
            row_changed = True

        if row_changed:
            changed.append(pid)

    return changed


def process_file(path):
    """Returns (new_text_or_None, changed_ids) for one shard file. `None`
    means no change is needed (already in sync)."""
    text = open(path).read()
    lines = text.split('\n')
    doc = validate.load(path) or {}
    rows = {row['id']: row for row in (doc.get('apis') or [])
             if isinstance(row, dict) and 'id' in row}
    changed = process(lines, rows)
    if not changed:
        return None, []
    return '\n'.join(lines), changed


def main(argv):
    check = '--check' in argv
    targets = [a for a in argv if a != '--check']
    root = targets[0] if targets else os.path.dirname(os.path.abspath(__file__))

    any_changed = False
    for path in sorted(glob.glob(os.path.join(root, '*.yaml'))):
        new_text, changed = process_file(path)
        if new_text is None:
            continue
        any_changed = True
        name = os.path.basename(path)
        if check:
            print('would update %s: %s' % (name, ', '.join(changed)))
        else:
            open(path, 'w').write(new_text)
            print('updated %s: %s' % (name, ', '.join(changed)))

    if check:
        if any_changed:
            print('FAIL: cost_badge and/or pricing.cost_label out of sync with pricing')
            return 1
        print('OK: cost_badge in sync with pricing.api_access_gate on every row; '
              'pricing.cost_label in sync with pricing on every row')
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
