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


# -- frames -------------------------------------------------------------------

def frames_df(doc: MumoDoc, schema: str | None = None) -> dict[str, pd.DataFrame] | pd.DataFrame:
    """
    Build a wide-format DataFrame from frame instances, one row per frame.

    Each slot in the schema becomes a group of columns:
      {slot}              - text content (span text, or full utterance text)
      {slot}_participant  - speaker of the anchored utterance
      {slot}_start        - start time in seconds
      {slot}_end          - end time in seconds
      {slot}_{metric}     - each metric value

    If *schema* is given, returns a single DataFrame for that schema.
    Otherwise returns a dict {schema_name: DataFrame} for every schema
    that has at least one frame instance.
    """
    pd = _require_pandas()

    schemas = doc._mumo['frame_schemas']

    if schema is not None:
        target = next((s for s in schemas.values() if s['name'] == schema), None)
        if target is None:
            raise KeyError(f'No frame schema named {schema!r}')
        return _schema_df(doc, target, pd)

    # all schemas that have instances
    result = {}
    schema_ids_with_frames = {f['schema_id'] for f in doc._mumo['frames'].values()}
    for s in schemas.values():
        if s['id'] in schema_ids_with_frames:
            result[s['name']] = _schema_df(doc, s, pd)

    if len(result) == 1:
        return next(iter(result.values()))
    return result


def _schema_df(doc: MumoDoc, schema: dict, pd) -> pd.DataFrame:
    from .views import FrameView

    rows = []
    for frame in doc._mumo['frames'].values():
        if frame['schema_id'] != schema['id']:
            continue
        fv   = FrameView(frame, doc)
        row: dict = {'frame_id': frame['id'], 'schema': schema['name'], 'note': frame.get('note')}

        for slot_def in schema['slots']:
            sv   = fv.slot(slot_def['name'])
            name = slot_def['name']

            if sv is None:
                row[name]                = None
                row[f'{name}_participant'] = None
                row[f'{name}_start']     = None
                row[f'{name}_end']       = None
                for m in slot_def.get('metrics', []):
                    row[f"{name}_{m['name']}"] = None
                continue

            anchor = sv.anchor
            if anchor is not None:
                from .views import SpanAnchor, UtteranceAnchor, TimeAnchor
                if isinstance(anchor, (SpanAnchor, UtteranceAnchor)):
                    utt = anchor.utterance
                    row[name]                  = anchor.text if isinstance(anchor, SpanAnchor) else utt.text
                    row[f'{name}_participant'] = utt.participant
                    row[f'{name}_start']       = utt.start_time
                    row[f'{name}_end']         = utt.end_time
                elif isinstance(anchor, TimeAnchor):
                    row[name]                  = None
                    row[f'{name}_participant'] = None
                    row[f'{name}_start']       = anchor.start
                    row[f'{name}_end']         = anchor.end
            else:
                row[name]                = None
                row[f'{name}_participant'] = None
                row[f'{name}_start']     = None
                row[f'{name}_end']       = None

            for mv in sv.metrics:
                schema_slot = sv.schema or {}
                metric_def  = next((m for m in schema_slot.get('metrics', [])
                                    if m['id'] == mv.schema_id), None)
                col = f"{name}_{metric_def['name']}" if metric_def else f'{name}_metric_{mv.schema_id[:8]}'
                row[col] = mv.value

            # fill any metric columns that weren't covered
            for m in slot_def.get('metrics', []):
                col = f"{name}_{m['name']}"
                if col not in row:
                    row[col] = None

        rows.append(row)

    return pd.DataFrame(rows)


# -- annotations --------------------------------------------------------------

def annotations_df(doc: MumoDoc, tier: str | None = None) -> pd.DataFrame:
    """
    Build a DataFrame with one row per EAF annotation.

    Columns: id, tier, participant, constraint, value,
             start_time, end_time, parent_id.

    If *tier* is given, only that tier's annotations are included.
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
