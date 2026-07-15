#!/usr/bin/env python3
"""
Migrate mmeaf files to current schema conventions.

Changes applied (all idempotent):
  1. anchor_kind="span" → anchor_kind="textlet"  in mm:slot elements
  2. mm:frame_schemas / mm:frame_schema / mm:frames / mm:frame  element names
     → mm:pattern_schemas / mm:pattern_schema / mm:patterns / mm:pattern
  3. EAF token tier IDs: TIER_ID="tokens:<participant>" → TIER_ID="tokens:utterance:<participant>"
     and matching PARENT_REF="tokens:<participant>" → PARENT_REF="tokens:utterance:<participant>"
     (only renames tiers whose token-suffix contains no colon, i.e. the old flat format)
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path


# 1. anchor_kind="span" → "textlet" inside mm:slot opening tags
_SLOT_SPAN_RE = re.compile(
    r'(<mm:slot\b[^>]*?\banchor_kind=)"span"',
    re.DOTALL,
)

# 2. Element renames – applied in longest-first order so no partial match issues.
#    Each tuple is (old_token, new_token); simple string replacement on the whole text.
_ELEMENT_RENAMES: list[tuple[str, str]] = [
    ('mm:frame_schemas', 'mm:pattern_schemas'),
    ('mm:frame_schema',  'mm:pattern_schema'),
    ('mm:frames',        'mm:patterns'),
    ('mm:frame',         'mm:pattern'),
]

# 3. Token tier renames: TIER_ID="tokens:<no-colon-suffix>" → "tokens:utterance:<suffix>"
#    The negative lookahead (?!utterance:) prevents double-migration.
_TOKEN_TIER_RE = re.compile(
    r'((?:TIER_ID|PARENT_REF)="tokens:)(?!utterance:)([^"]+)(")',
)


def migrate_text(text: str) -> tuple[str, int]:
    """Return (migrated_text, total_change_count)."""
    count = 0

    # 1. anchor_kind
    text, n = _SLOT_SPAN_RE.subn(r'\1"textlet"', text)
    count += n

    # 2. element renames
    for old, new in _ELEMENT_RENAMES:
        new_text = text.replace(old, new)
        if new_text != text:
            count += text.count(old)
            text = new_text

    # 3. token tier renames
    text, n = _TOKEN_TIER_RE.subn(r'\1utterance:\2\3', text)
    count += n

    return text, count


def migrate_file(path: Path, *, dry_run: bool, backup: bool) -> bool:
    """Migrate one file in-place. Returns True if any changes were made."""
    original = path.read_text(encoding='utf-8')
    migrated, count = migrate_text(original)
    if count == 0:
        return False

    print(f'{path}: {count} change(s)')
    if dry_run:
        return True

    if backup:
        shutil.copy2(path, path.with_suffix(path.suffix + '.bak'))

    path.write_text(migrated, encoding='utf-8')
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='+', help='mmeaf files or directories to migrate')
    parser.add_argument('--dry-run', '-n', action='store_true',
                        help='Print what would change without writing files')
    parser.add_argument('--no-backup', action='store_true',
                        help='Skip creating .bak backups before overwriting')
    args = parser.parse_args()

    changed = 0
    unchanged = 0

    for raw in args.paths:
        p = Path(raw)
        candidates: list[Path] = []
        if p.is_dir():
            candidates = sorted(p.rglob('*.mmeaf'))
        elif p.is_file():
            candidates = [p]
        else:
            print(f'warning: {p} not found, skipping', file=sys.stderr)
            continue

        for f in candidates:
            if migrate_file(f, dry_run=args.dry_run, backup=not args.no_backup):
                changed += 1
            else:
                unchanged += 1

    suffix = ' (dry run)' if args.dry_run else ''
    print(f'\n{changed} file(s) updated, {unchanged} already up to date{suffix}')


if __name__ == '__main__':
    main()
