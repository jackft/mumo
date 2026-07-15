"""Parse the mm:mumo_data block from an MMEAF file."""
from __future__ import annotations
from xml.etree import ElementTree as ET

MM_NS = 'https://mumo.io/ns/mmeaf/1'
_MM   = f'{{{MM_NS}}}'


def _q(local: str) -> str:
    return f'{_MM}{local}'


def _ms_to_sec(val: str | None) -> float | None:
    if val is None:
        return None
    try:
        return int(val) / 1000.0
    except (ValueError, TypeError):
        return None


def parse_mumo_data(file_path: str) -> dict:
    """
    Parse the mm:mumo_data block from an MMEAF file.

    Returns a dict with:
      utterances      - list of {id, participant, start_ms, end_ms, order}
      tokens          - list of {id, utt_id, kind, text, start_offset, end_offset}
      token_times     - {token_id: (start_sec | None, end_sec | None)}
      utt_ann_ref     - {utt_id: annotation_id}    utterance -> annotation back-ref
      tok_ann_ref     - {token_id: annotation_id}  token -> annotation back-ref
      marks           - {mark_id: {id, block_id, start, end}}
      textlets        - {textlet_id: {id, mark_id, type, features}}
      annotations     - {ann_id: {id, type, features}}  utterance/token-anchored
      pattern_schemas - {schema_id: {id, name, description, color, hotkey, slots}}
      patterns        - {pattern_id: {id, schema_id, note, slots}}
    """
    tree = ET.parse(file_path)
    root = tree.getroot()

    mm_el = root.find(_q('mumo_data'))
    if mm_el is None:
        return {
            'utterances': [], 'tokens': [], 'token_times': {},
            'utt_ann_ref': {}, 'tok_ann_ref': {},
            'marks': {}, 'textlets': {}, 'annotations': {},
            'pattern_schemas': {}, 'patterns': {},
        }

    result: dict = {
        'utterances': [], 'tokens': [], 'token_times': {},
        'utt_ann_ref': {}, 'tok_ann_ref': {},
        'marks': {}, 'textlets': {}, 'annotations': {},
        'pattern_schemas': {}, 'patterns': {},
    }

    _parse_transcript_structure(mm_el, result)
    _parse_marks(mm_el, result)
    _parse_textlets(mm_el, result)
    _parse_annotations(mm_el, result)
    _parse_pattern_schemas(mm_el, result)
    _parse_patterns(mm_el, result)
    return result


# -- transcript_structure -----------------------------------------------------

def _parse_transcript_structure(mm_el: ET.Element, result: dict) -> None:
    ts_el = mm_el.find(_q('transcript_structure'))
    if ts_el is None:
        return
    for order, utt_el in enumerate(ts_el.findall(_q('utt'))):
        _parse_utt(utt_el, order, result)


def _parse_utt(utt_el: ET.Element, default_order: int, result: dict) -> None:
    block_id    = utt_el.get('block_id', '')
    participant = utt_el.get('participant', '')
    start_ms    = utt_el.get('start_ms')
    end_ms      = utt_el.get('end_ms')
    order       = int(utt_el.get('order', str(default_order)))
    ann_ref     = utt_el.get('annotation_ref')

    result['utterances'].append({
        'id':          block_id,
        'participant': participant,
        'start_ms':    int(start_ms) if start_ms is not None else None,
        'end_ms':      int(end_ms)   if end_ms   is not None else None,
        'order':       order,
    })
    if ann_ref:
        result['utt_ann_ref'][block_id] = ann_ref

    offset = 0
    for tok_el in utt_el.findall(_q('t')):
        kind      = tok_el.get('type', 'word')
        tok_id    = tok_el.get('id', '')
        text      = tok_el.text or ''
        t_s       = tok_el.get('start_ms')
        t_e       = tok_el.get('end_ms')
        tok_ref   = tok_el.get('annotation_ref')

        result['tokens'].append({
            'id': tok_id, 'utt_id': block_id, 'kind': kind, 'text': text,
            'start_offset': offset, 'end_offset': offset + len(text),
        })
        if t_s is not None or t_e is not None:
            result['token_times'][tok_id] = (_ms_to_sec(t_s), _ms_to_sec(t_e))
        if tok_ref:
            result['tok_ann_ref'][tok_id] = tok_ref

        offset += len(text)


# -- marks --------------------------------------------------------------------

def _parse_marks(mm_el: ET.Element, result: dict) -> None:
    marks_el = mm_el.find(_q('marks'))
    if marks_el is None:
        return
    for m_el in marks_el.findall(_q('mark')):
        mid = m_el.get('id', '')
        result['marks'][mid] = {
            'id':       mid,
            'block_id': m_el.get('block_id', ''),
            'start':    int(m_el.get('start', '0')),
            'end':      int(m_el.get('end',   '0')),
        }


# -- textlets -----------------------------------------------------------------

def _parse_textlets(mm_el: ET.Element, result: dict) -> None:
    textlets_el = mm_el.find(_q('textlets'))
    if textlets_el is None:
        return
    for t_el in textlets_el.findall(_q('textlet')):
        tid      = t_el.get('id', '')
        features = {}
        for f_el in t_el.findall(_q('feature')):
            features[f_el.get('name', '')] = f_el.text or ''
        result['textlets'][tid] = {
            'id':       tid,
            'mark_id':  t_el.get('mark_id', ''),
            'type':     t_el.get('type', ''),
            'features': features,
        }


# -- annotations (utterance/token-anchored) -----------------------------------

def _parse_annotations(mm_el: ET.Element, result: dict) -> None:
    anns_el = mm_el.find(_q('annotations'))
    if anns_el is None:
        return
    for a_el in anns_el.findall(_q('annotation')):
        aid      = a_el.get('id', '')
        features = {}
        for f_el in a_el.findall(_q('feature')):
            features[f_el.get('name', '')] = f_el.text or ''
        result['annotations'][aid] = {
            'id':       aid,
            'type':     a_el.get('type', ''),
            'features': features,
        }


# -- pattern_schemas ----------------------------------------------------------

def _parse_pattern_schemas(mm_el: ET.Element, result: dict) -> None:
    schemas_el = mm_el.find(_q('pattern_schemas'))
    if schemas_el is None:
        return
    for s_el in schemas_el.findall(_q('pattern_schema')):
        sid   = s_el.get('id', '')
        slots = []
        for slot_el in s_el.findall(_q('slot')):
            metrics = []
            for m_el in slot_el.findall(_q('metric')):
                metrics.append({
                    'id':            m_el.get('id', ''),
                    'name':          m_el.get('name', ''),
                    'type':          m_el.get('type', 'text'),
                    'vocabulary_id': m_el.get('vocabulary_id'),
                })
            slots.append({
                'id':          slot_el.get('id', ''),
                'name':        slot_el.get('name', ''),
                'label':       slot_el.get('label'),
                'anchor_kind': slot_el.get('anchor_kind', 'textlet'),
                'required':    slot_el.get('required') == 'true',
                'variadic':    slot_el.get('variadic') == 'true',
                'metrics':     metrics,
            })
        color_str = s_el.get('color')
        result['pattern_schemas'][sid] = {
            'id':          sid,
            'name':        s_el.get('name', ''),
            'description': s_el.get('description'),
            'color':       int(color_str) if color_str else None,
            'hotkey':      s_el.get('hotkey'),
            'slots':       slots,
        }


# -- patterns -----------------------------------------------------------------

def _parse_patterns(mm_el: ET.Element, result: dict) -> None:
    patterns_el = mm_el.find(_q('patterns'))
    if patterns_el is None:
        return
    for p_el in patterns_el.findall(_q('pattern')):
        pid   = p_el.get('id', '')
        slots = []
        for si_el in p_el.findall(_q('slot_instance')):
            metrics = []
            for mv_el in si_el.findall(_q('metric_value')):
                metrics.append({
                    'schema_id': mv_el.get('schema_id', ''),
                    'value':     mv_el.get('value'),
                })
            slots.append({
                'id':             si_el.get('id', ''),
                'schema_slot_id': si_el.get('schema_slot_id', ''),
                'annotation_id':  si_el.get('annotation_id', ''),
                'metrics':        metrics,
            })
        result['patterns'][pid] = {
            'id':        pid,
            'schema_id': p_el.get('schema_id', ''),
            'note':      p_el.get('note'),
            'slots':     slots,
        }
