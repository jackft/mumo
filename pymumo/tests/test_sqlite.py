import sqlite3
from mumo import export_to_sqlite


def test_export_creates_all_tables(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='test')
    con = sqlite3.connect(db)
    tables = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    con.close()
    for expected in ('documents', 'utterances', 'tokens', 'frame_schemas',
                     'frames', 'slot_instances', 'eaf_tiers', 'eaf_annotations'):
        assert expected in tables, f'missing table: {expected}'


def test_export_document_row(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='myfile', title='My File')
    con = sqlite3.connect(db)
    row = con.execute("SELECT id, title FROM documents WHERE id='myfile'").fetchone()
    con.close()
    assert row == ('myfile', 'My File')


def test_export_utterance_count(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='test')
    con = sqlite3.connect(db)
    count = con.execute("SELECT COUNT(*) FROM utterances WHERE document_id='test'").fetchone()[0]
    con.close()
    assert count == len(doc.all_utterances())


def test_export_token_count(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='test')
    con = sqlite3.connect(db)
    count = con.execute("SELECT COUNT(*) FROM tokens WHERE document_id='test'").fetchone()[0]
    con.close()
    assert count == len(doc.all_tokens())


def test_export_eaf_annotation_count(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='test')
    con = sqlite3.connect(db)
    count = con.execute(
        "SELECT COUNT(*) FROM eaf_annotations WHERE document_id='test'"
    ).fetchone()[0]
    con.close()
    assert count == len(doc.all_eaf_annotations())


def test_export_idempotent(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='test')
    export_to_sqlite(doc, db, doc_id='test')  # second export - no duplicate rows
    con = sqlite3.connect(db)
    count = con.execute("SELECT COUNT(*) FROM utterances WHERE document_id='test'").fetchone()[0]
    con.close()
    assert count == len(doc.all_utterances())


def test_token_positions_are_sequential_per_utterance(doc, tmp_path):
    db = str(tmp_path / 'test.db')
    export_to_sqlite(doc, db, doc_id='test')
    con = sqlite3.connect(db)
    utt_id = con.execute(
        "SELECT utterance_id FROM tokens WHERE document_id='test' LIMIT 1"
    ).fetchone()[0]
    positions = [r[0] for r in con.execute(
        "SELECT position FROM tokens WHERE utterance_id=? ORDER BY position", (utt_id,)
    ).fetchall()]
    con.close()
    assert positions == list(range(len(positions)))
