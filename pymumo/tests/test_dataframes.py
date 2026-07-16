pytest_plugins = []

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

import pytest
from mumo import patterns_df, frames_df, annotations_df

pytestmark = pytest.mark.skipif(not HAS_PANDAS, reason='pandas not installed')


def test_annotations_df_has_expected_columns(doc):
    df = annotations_df(doc)
    for col in ('id', 'tier', 'participant', 'value', 'start_time', 'end_time', 'parent_id'):
        assert col in df.columns


def test_annotations_df_row_count_matches(doc):
    df = annotations_df(doc)
    assert len(df) == len(doc.eaf_annotations)


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


def test_patterns_df_returns_dataframe(doc):
    if not doc.patterns:
        return
    import pandas as pd
    result = patterns_df(doc)
    if isinstance(result, dict):
        for df in result.values():
            assert isinstance(df, pd.DataFrame)
    else:
        assert isinstance(result, pd.DataFrame)


def test_patterns_df_has_pattern_id_and_schema_columns(doc):
    if not doc.patterns:
        return
    import pandas as pd
    result = patterns_df(doc)
    df = result if isinstance(result, pd.DataFrame) else next(iter(result.values()))
    assert 'pattern_id' in df.columns
    assert 'schema'     in df.columns


def test_patterns_df_named_schema(doc):
    import pandas as pd
    schemas = doc.pattern_schemas
    if not schemas:
        return
    schema_name = schemas[0].name
    df = patterns_df(doc, schema=schema_name)
    assert isinstance(df, pd.DataFrame)
    assert (df['schema'] == schema_name).all()


def test_patterns_df_slot_column_present(doc):
    import pandas as pd
    schemas = doc.pattern_schemas
    if not schemas:
        return
    schema = schemas[0]
    if not schema.slots:
        return
    df = patterns_df(doc, schema=schema.name)
    assert schema.slots[0].name in df.columns


def test_patterns_df_unknown_schema_raises(doc):
    with pytest.raises(KeyError):
        patterns_df(doc, schema='__no_such_schema__')


def test_frames_df_is_alias_for_patterns_df(doc):
    assert frames_df is patterns_df
