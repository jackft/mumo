"""Pandas DataFrame builders for MumoDoc data."""
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd
    from .doc import MumoDoc


def _require_pandas():
    try:
        import pandas as pd
        return pd
    except ImportError:
        raise ImportError('pandas is required: pip install pandas')


def patterns_df(doc: MumoDoc, schema: str | None = None) -> 'dict[str, pd.DataFrame] | pd.DataFrame':
    """
    Build a wide-format DataFrame from pattern instances, one row per pattern.

    Each slot becomes a group of columns:
      {slot}              - text of the anchor
      {slot}_participant  - speaker of the anchored utterance
      {slot}_start        - start time in seconds
      {slot}_end          - end time in seconds
      {slot}_{metric}     - each metric value

    If *schema* is given, returns a single DataFrame for that schema.
    Otherwise returns a dict {schema_name: DataFrame} for every schema
    that has at least one pattern instance.
    """
    pd = _require_pandas()

    if schema is not None:
        ps = doc.pattern_schema(schema)
        if ps is None:
            raise KeyError(f'No pattern schema named {schema!r}')
        return _schema_df(doc, ps, pd)

    schema_ids_with_patterns = {p._rec['schema_id'] for p in doc.patterns}
    result = {}
    for ps in doc.pattern_schemas:
        if ps.id in schema_ids_with_patterns:
            result[ps.name] = _schema_df(doc, ps, pd)

    if len(result) == 1:
        return next(iter(result.values()))
    return result


frames_df = patterns_df  # backward-compat alias


def _schema_df(doc: MumoDoc, schema, pd) -> 'pd.DataFrame':
    from .views import TextletAnchor, UtteranceAnchor, TimeAnchor

    rows = []
    for pattern in doc.patterns:
        if pattern._rec['schema_id'] != schema.id:
            continue
        row: dict = {'pattern_id': pattern.id, 'schema': schema.name, 'note': pattern.note}

        for slot_def in schema.slots:
            sv   = pattern.slot(slot_def.name)
            name = slot_def.name

            if sv is None:
                row[name]                  = None
                row[f'{name}_participant'] = None
                row[f'{name}_start']       = None
                row[f'{name}_end']         = None
                for m in slot_def.metrics:
                    row[f'{name}_{m.name}'] = None
                continue

            anchor = sv.anchor
            if isinstance(anchor, (TextletAnchor, UtteranceAnchor)):
                utt = anchor.utterance
                row[name]                  = anchor.text if isinstance(anchor, TextletAnchor) else utt.text
                row[f'{name}_participant'] = utt.participant
                row[f'{name}_start']       = utt.start_time
                row[f'{name}_end']         = utt.end_time
            elif isinstance(anchor, TimeAnchor):
                row[name]                  = None
                row[f'{name}_participant'] = None
                row[f'{name}_start']       = anchor.start
                row[f'{name}_end']         = anchor.end
            else:
                row[name]                  = None
                row[f'{name}_participant'] = None
                row[f'{name}_start']       = None
                row[f'{name}_end']         = None

            for mv in sv.metrics:
                col = f'{name}_{mv.name}' if mv.name else f'{name}_metric_{mv.schema_id[:8]}'
                row[col] = mv.value

            for m in slot_def.metrics:
                col = f'{name}_{m.name}'
                if col not in row:
                    row[col] = None

        rows.append(row)

    if not rows:
        base_cols = ['pattern_id', 'schema', 'note']
        slot_cols: list[str] = []
        for slot_def in schema.slots:
            slot_cols += [slot_def.name, f'{slot_def.name}_participant',
                          f'{slot_def.name}_start', f'{slot_def.name}_end']
            for m in slot_def.metrics:
                slot_cols.append(f'{slot_def.name}_{m.name}')
        return pd.DataFrame(columns=base_cols + slot_cols)

    return pd.DataFrame(rows)


def annotations_df(doc: MumoDoc, tier: str | None = None) -> 'pd.DataFrame':
    """
    Build a DataFrame with one row per EAF annotation.

    Columns: id, tier, participant, constraint, value,
             start_time, end_time, parent_id.
    """
    pd = _require_pandas()

    rows = []
    for tier_name, (aligned, ref, attrs, _) in doc.tiers.items():
        if tier is not None and tier_name != tier:
            continue

        participant = attrs.get('PARTICIPANT')
        lt_id       = attrs.get('LINGUISTIC_TYPE_REF')
        constraint  = None
        if lt_id and lt_id in doc.linguistic_types:
            constraint = doc.linguistic_types[lt_id].get('CONSTRAINTS')

        for ann_id, (bts, ets, value, _) in aligned.items():
            s_ms = doc.timeslots.get(bts)
            e_ms = doc.timeslots.get(ets)
            rows.append({
                'id':          ann_id,
                'tier':        tier_name,
                'participant': participant,
                'constraint':  constraint,
                'value':       value,
                'start_time':  s_ms / 1000.0 if s_ms is not None else None,
                'end_time':    e_ms / 1000.0 if e_ms is not None else None,
                'parent_id':   None,
            })

        for ann_id, (parent_id, value, _, _) in ref.items():
            rows.append({
                'id':          ann_id,
                'tier':        tier_name,
                'participant': participant,
                'constraint':  constraint,
                'value':       value,
                'start_time':  None,
                'end_time':    None,
                'parent_id':   parent_id or None,
            })

    return pd.DataFrame(rows, columns=[
        'id', 'tier', 'participant', 'constraint',
        'value', 'start_time', 'end_time', 'parent_id',
    ])
