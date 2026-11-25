#!/usr/bin/env python3
"""Rewrites/inserts `cost_badge` lines in shard YAML files in place, at the
text level -- no raw/ required.

build.py already recomputes `cost_badge` on every row it regenerates (see
its README section "ND-12 pricing gate"), but build.py cannot run in a clean
clone: `data/apis/raw/` is not committed (see ../README.md "Layout"). This
script reaches the same result -- `cost_badge` in sync with
`pricing.api_access_gate` -- by editing the shard text directly, touching
only `cost_badge` lines and leaving everything else byte-for-byte untouched.

For each row, the line is placed right after the row's `pricing:` block, or
as the last key of the row when it has no `pricing` block. An existing
`cost_badge` line already holding the right value is left alone, so a second
run makes no changes (idempotent).

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
PRICING_RE = re.compile(r'^    pricing:(.*)$')


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


def pricing_block_end(lines, start, end):
    """Index right after the row's `pricing:` block (one-line `pricing: null`
    counts as the whole block), or None when the row has no `pricing` key."""
    for i in range(start, end):
        m = PRICING_RE.match(lines[i])
        if not m:
            continue
        if m.group(1).strip():
            return i + 1
        j = i + 1
        while j < end and (lines[j].startswith('      ') or not lines[j].strip()):
            j += 1
        return j
    return None


def process(lines, rows):
    """Rewrites `lines` (a list, mutated in place) so every row's
    `cost_badge` matches `validate.derive_cost_badge(row['pricing'])`.
    Returns the ids actually changed (inserted or corrected)."""
    changed = []
    # Walk from the end: inserting a line shifts every later index, and
    # spans were computed once up front from the original (unmutated) text.
    for start, end, pid in reversed(row_spans(lines)):
        row = rows.get(pid)
        if row is None:
            continue
        expected = validate.derive_cost_badge(row.get('pricing'))

        existing_idx = None
        for i in range(start, end):
            if COST_BADGE_RE.match(lines[i]):
                existing_idx = i
                break

        if existing_idx is not None:
            current = COST_BADGE_RE.match(lines[existing_idx]).group(1).strip().strip('"')
            if current == expected:
                continue
            lines[existing_idx] = '    cost_badge: "%s"' % expected
            changed.append(pid)
            continue

        insert_at = pricing_block_end(lines, start, end)
        if insert_at is None:
            insert_at = end
        # `end` may be end-of-file, where the trailing `\n` split leaves a
        # blank final element -- insert before it, not after, so no blank
        # line opens up ahead of the new key.
        while insert_at > start and lines[insert_at - 1].strip() == '':
            insert_at -= 1
        lines[insert_at:insert_at] = ['    cost_badge: "%s"' % expected]
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
            print('FAIL: cost_badge out of sync with pricing.api_access_gate')
            return 1
        print('OK: cost_badge in sync with pricing.api_access_gate on every row')
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
