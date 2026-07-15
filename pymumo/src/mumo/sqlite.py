"""Export a MumoDoc to SQLite."""
from __future__ import annotations
import os
import sqlite3
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .doc import MumoDoc

_DDL = """
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  created_at   INTEGER,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS document_metadata (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  key          TEXT,
  value        TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS utterances (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  participant  TEXT,
  ordinal      INTEGER,
  start_time   REAL,
  end_time     REAL,
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  utterance_id TEXT NOT NULL,
  type         TEXT CHECK(type IN ('word', 'ws', 'punct', 'action', 'gap')),
  text         TEXT,
  position     INTEGER,
  start_time   REAL,
  end_time     REAL,
  FOREIGN KEY(document_id)  REFERENCES documents(id),
  FOREIGN KEY(utterance_id) REFERENCES utterances(id)
);

CREATE TABLE IF NOT EXISTS pattern_schemas (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  name         TEXT,
  description  TEXT,
  color        INTEGER,
  hotkey       TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS slot_schemas (
  id               TEXT PRIMARY KEY,
  frame_schema_id  TEXT NOT NULL,
  name             TEXT,
  label            TEXT,
  anchor_kind      TEXT,
  required         INTEGER,
  variadic         INTEGER,
  FOREIGN KEY(frame_schema_id) REFERENCES pattern_schemas(id)
);

CREATE TABLE IF NOT EXISTS patterns (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  schema_id    TEXT NOT NULL,
  note         TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id),
  FOREIGN KEY(schema_id)   REFERENCES pattern_schemas(id)
);

CREATE TABLE IF NOT EXISTS slot_instances (
  id               TEXT PRIMARY KEY,
  pattern_id       TEXT NOT NULL,
  schema_slot_id   TEXT NOT NULL,
  annotation_id    TEXT,
  FOREIGN KEY(pattern_id) REFERENCES patterns(id)
);

CREATE TABLE IF NOT EXISTS metric_values (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_instance_id TEXT NOT NULL,
  schema_id        TEXT,
  value            TEXT,
  FOREIGN KEY(slot_instance_id) REFERENCES slot_instances(id)
);

CREATE TABLE IF NOT EXISTS eaf_tiers (
  tier_name        TEXT NOT NULL,
  document_id      TEXT NOT NULL,
  participant      TEXT,
  linguistic_type  TEXT,
  parent_tier      TEXT,
  PRIMARY KEY(tier_name, document_id),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS eaf_annotations (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL,
  tier_name    TEXT NOT NULL,
  value        TEXT,
  start_time   REAL,
  end_time     REAL,
  parent_id    TEXT,
  FOREIGN KEY(document_id) REFERENCES documents(id)
);
"""


def export_to_sqlite(
    doc: MumoDoc,
    db_path: str,
    doc_id: str | None = None,
    title: str | None = None,
) -> None:
    """
    Export *doc* to a SQLite database at *db_path*.

    The schema is created if it does not exist.  Existing rows for the
    same *doc_id* are replaced, so repeated calls are idempotent.
    """
    if doc_id is None:
        doc_id = os.path.splitext(os.path.basename(doc._mmeaf_path))[0]
    if title is None:
        title = doc_id

    now = int(time.time())
    con = sqlite3.connect(db_path)
    con.executescript(_DDL)

    with con:
        con.execute(
            'INSERT OR REPLACE INTO documents (id, title, created_at, updated_at) VALUES (?,?,?,?)',
            (doc_id, title, now, now),
        )

        # utterances
        for utt in doc._raw['utterances']:
            s = utt['start_ms'] / 1000.0 if utt['start_ms'] is not None else None
            e = utt['end_ms']   / 1000.0 if utt['end_ms']   is not None else None
            con.execute(
                'INSERT OR REPLACE INTO utterances '
                '(id, document_id, participant, ordinal, start_time, end_time) '
                'VALUES (?,?,?,?,?,?)',
                (utt['id'], doc_id, utt['participant'], utt['order'], s, e),
            )

        # tokens
        token_times = doc._raw['token_times']
        pos_counter: dict[str, int] = {}
        for tok in doc._raw['tokens']:
            uid = tok['utt_id']
            pos = pos_counter.get(uid, 0)
            pos_counter[uid] = pos + 1
            times = token_times.get(tok['id'])
            t_s, t_e = (times[0], times[1]) if times else (None, None)
            con.execute(
                'INSERT OR REPLACE INTO tokens '
                '(id, document_id, utterance_id, type, text, position, start_time, end_time) '
                'VALUES (?,?,?,?,?,?,?,?)',
                (tok['id'], doc_id, uid, tok['kind'], tok['text'], pos, t_s, t_e),
            )

        # frame schemas and slot schemas
        for schema in doc._raw['pattern_schemas'].values():
            con.execute(
                'INSERT OR REPLACE INTO pattern_schemas '
                '(id, document_id, name, description, color, hotkey) VALUES (?,?,?,?,?,?)',
                (schema['id'], doc_id, schema['name'],
                 schema.get('description'), schema.get('color'), schema.get('hotkey')),
            )
            for slot in schema['slots']:
                con.execute(
                    'INSERT OR REPLACE INTO slot_schemas '
                    '(id, frame_schema_id, name, label, anchor_kind, required, variadic) '
                    'VALUES (?,?,?,?,?,?,?)',
                    (slot['id'], schema['id'], slot['name'], slot.get('label'),
                     slot.get('anchor_kind'),
                     int(slot.get('required', False)),
                     int(slot.get('variadic', False))),
                )

        # frames, slot instances, metric values
        for frame in doc._raw['patterns'].values():
            con.execute(
                'INSERT OR REPLACE INTO patterns (id, document_id, schema_id, note) VALUES (?,?,?,?)',
                (frame['id'], doc_id, frame['schema_id'], frame.get('note')),
            )
            for slot in frame['slots']:
                con.execute(
                    'INSERT OR REPLACE INTO slot_instances '
                    '(id, pattern_id, schema_slot_id, annotation_id) VALUES (?,?,?,?)',
                    (slot['id'], frame['id'], slot['schema_slot_id'],
                     slot.get('annotation_id') or None),
                )
                for mv in slot.get('metrics', []):
                    con.execute(
                        'INSERT INTO metric_values (slot_instance_id, schema_id, value) '
                        'VALUES (?,?,?)',
                        (slot['id'], mv.get('schema_id'), mv.get('value')),
                    )

        # EAF tiers and annotations
        for tier_name, (aligned, ref, attrs, _) in doc.tiers.items():
            con.execute(
                'INSERT OR REPLACE INTO eaf_tiers '
                '(tier_name, document_id, participant, linguistic_type, parent_tier) '
                'VALUES (?,?,?,?,?)',
                (tier_name, doc_id,
                 attrs.get('PARTICIPANT'),
                 attrs.get('LINGUISTIC_TYPE_REF'),
                 attrs.get('PARENT_REF')),
            )
            for ann_id, (bts, ets, value, _) in aligned.items():
                s_ms = doc.timeslots.get(bts)
                e_ms = doc.timeslots.get(ets)
                con.execute(
                    'INSERT OR REPLACE INTO eaf_annotations '
                    '(id, document_id, tier_name, value, start_time, end_time, parent_id) '
                    'VALUES (?,?,?,?,?,?,?)',
                    (ann_id, doc_id, tier_name, value,
                     s_ms / 1000.0 if s_ms is not None else None,
                     e_ms / 1000.0 if e_ms is not None else None,
                     None),
                )
            for ann_id, (parent_id, value, _, _) in ref.items():
                con.execute(
                    'INSERT OR REPLACE INTO eaf_annotations '
                    '(id, document_id, tier_name, value, start_time, end_time, parent_id) '
                    'VALUES (?,?,?,?,?,?,?)',
                    (ann_id, doc_id, tier_name, value, None, None, parent_id),
                )

    con.close()
