pytest_plugins = []

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

import pytest
from mumo import frames_df, annotations_df

pytestmark = pytest.mark.skipif(not HAS_PANDAS, reason='pandas not installed')


def test_annotations_df_has_expected_columns(doc):
    df = annotations_df(doc)
    for col in ('id', 'tier', 'participant', 'value', 'start_time', 'end_time', 'parent_id'):
        assert col in df.columns


def test_annotations_df_row_count_matches(doc):
    df = annotations_df(doc)
    assert len(df) == len(doc.all_eaf_annotations())


def test_annotations_df_tier_filter(doc):
    all_df  = annotations_df(doc)
    tiers   = all_df['tier'].unique()
    if len(tiers) == 0:
        return
    one_tier = tiers[0]
    filtered = annotations_df(doc, tier=one_tier)
    assert (filtered['tier'] == one_tier).all()
    assert len(filtered) < len(all_df) or len(tiers) == 1


def test_annotations_df_aligned_have_times(doc):
    df = annotations_df(doc)
    aligned = df[df['parent_id'].isna() & df['start_time'].notna()]
    assert len(aligned) > 0
    assert (aligned['start_time'] <= aligned['end_time']).all()


def test_frames_df_single_schema_returns_dataframe(doc):
    if not doc._mumo['frames']:
        return
    result = frames_df(doc)
    import pandas as pd
    if isinstance(result, dict):
        for df in result.values():
            assert isinstance(df, pd.DataFrame)
    else:
        assert isinstance(result, pd.DataFrame)


def test_frames_df_has_frame_id_and_schema_columns(doc):
    if not doc._mumo['frames']:
        return
    result = frames_df(doc)
    import pandas as pd
    df = result if isinstance(result, pd.DataFrame) else next(iter(result.values()))
    assert 'frame_id' in df.columns
    assert 'schema'   in df.columns


def test_frames_df_named_schema(doc):
    import pandas as pd
    schemas = doc._mumo['frame_schemas']
    if not schemas:
        return
    schema_name = next(iter(schemas.values()))['name']
    df = frames_df(doc, schema=schema_name)
    assert isinstance(df, pd.DataFrame)
    assert (df['schema'] == schema_name).all()


def test_frames_df_slot_text_column_present(doc):
    import pandas as pd
    schemas = doc._mumo['frame_schemas']
    if not schemas:
        return
    schema = next(iter(schemas.values()))
    if not schema['slots']:
        return
    df = frames_df(doc, schema=schema['name'])
    slot_name = schema['slots'][0]['name']
    assert slot_name in df.columns


def test_frames_df_unknown_schema_raises(doc):
    with pytest.raises(KeyError):
        frames_df(doc, schema='__no_such_schema__')
