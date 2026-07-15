"""Rich view objects wrapping parsed mumo data."""
from __future__ import annotations
from typing import Iterator, NamedTuple, TYPE_CHECKING

if TYPE_CHECKING:
    from .doc import MumoDoc


# ---------------------------------------------------------------------------
# Anchor types
# ---------------------------------------------------------------------------

class UtteranceAnchor(NamedTuple):
    kind: str        # 'utterance'
    utterance: object

class TextletAnchor(NamedTuple):
    kind: str        # 'textlet'
    utterance: object
    start: int
    end: int
    text: str

class TimeAnchor(NamedTuple):
    kind: str        # 'time'
    start: float
    end: float

SpanAnchor = TextletAnchor  # backward-compat


class OverlapMark(NamedTuple):
    group_id: str
    kind: str       # 'start' | 'end'
    char_offset: int


class OverlapGroup:
    """All overlap bracket marks sharing a group_id, across all utterances."""
    __slots__ = ('_id', '_entries')

    def __init__(self, group_id: str, entries: list) -> None:
        self._id      = group_id
        self._entries = entries  # list of (Utterance, OverlapMark)

    @property
    def id(self) -> str:
        return self._id

    @property
    def utterances(self) -> list:
        seen: set[str] = set()
        result = []
        for utt, _ in self._entries:
            if utt.id not in seen:
                seen.add(utt.id)
                result.append(utt)
        return result

    @property
    def start_time(self) -> float | None:
        """Latest start time among involved utterances (when overlap begins)."""
        times = [u.start_time for u in self.utterances if u.start_time is not None]
        return max(times) if times else None

    @property
    def end_time(self) -> float | None:
        """Earliest end time among involved utterances (when overlap ends)."""
        times = [u.end_time for u in self.utterances if u.end_time is not None]
        return min(times) if times else None

    def __repr__(self) -> str:
        participants = ', '.join(u.participant for u in self.utterances)
        return f'OverlapGroup({self._id!r}, [{participants}])'


# ---------------------------------------------------------------------------
# Token
# ---------------------------------------------------------------------------

class Token:
    __slots__ = ('_rec', '_doc')

    def __init__(self, rec: dict, doc: MumoDoc) -> None:
        self._rec = rec
        self._doc = doc

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def text(self) -> str:
        return self._rec['text']

    @property
    def kind(self) -> str:
        return self._rec['kind']

    @property
    def utterance(self) -> Utterance:
        return self._doc._utt_obj(self._rec['utt_id'])

    @property
    def time(self) -> tuple[float | None, float | None] | None:
        return self._doc._raw['token_times'].get(self._rec['id'])

    @property
    def bounded_time(self) -> tuple[float, float] | None:
        utt   = self.utterance
        utt_s = utt.start_time
        utt_e = utt.end_time
        stored = self.time
        start = stored[0] if stored and stored[0] is not None else utt_s
        end   = stored[1] if stored and stored[1] is not None else utt_e
        if start is None or end is None:
            return None
        if utt_s is not None:
            start = max(start, utt_s)
        if utt_e is not None:
            end = min(end, utt_e)
        return (start, end)

    def __repr__(self) -> str:
        return f'Token({self.kind}, {self.text!r})'


# ---------------------------------------------------------------------------
# Utterance
# ---------------------------------------------------------------------------

class Utterance:
    __slots__ = ('_rec', '_doc')

    def __init__(self, rec: dict, doc: MumoDoc) -> None:
        self._rec = rec
        self._doc = doc

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def participant(self) -> str:
        return self._rec['participant']

    @property
    def order(self) -> int:
        return self._rec['order']

    @property
    def start_time(self) -> float | None:
        ms = self._rec['start_ms']
        return ms / 1000.0 if ms is not None else None

    @property
    def end_time(self) -> float | None:
        ms = self._rec['end_ms']
        return ms / 1000.0 if ms is not None else None

    @property
    def overlap_marks(self) -> list[OverlapMark]:
        return [OverlapMark(**m)
                for m in self._doc._raw['overlap_marks'].get(self.id, [])]

    @property
    def tokens(self) -> list[Token]:
        return [Token(t, self._doc) for t in self._doc._tokens_for(self.id)]

    @property
    def words(self) -> list[Token]:
        return [Token(t, self._doc) for t in self._doc._tokens_for(self.id)
                if t['kind'] not in ('ws',)]

    @property
    def text(self) -> str:
        return ''.join(t['text'] for t in self._doc._tokens_for(self.id))

    # -- continuations -------------------------------------------------------

    @property
    def is_continuation(self) -> bool:
        return self._rec.get('continuation_of') is not None

    @property
    def head(self) -> Utterance | None:
        """The utterance this continues, or None if this is already the head."""
        cid = self._rec.get('continuation_of')
        return self._doc._utt_obj(cid) if cid else None

    @property
    def continuations(self) -> list[Utterance]:
        """Direct continuations of this utterance (not recursive)."""
        return self._doc._continuations_of(self.id)

    @property
    def chain(self) -> list[Utterance]:
        """The full continuation chain: head + all continuations, in order."""
        head = self.head or self
        return [head] + self._doc._continuations_of(head.id)

    # -- cross-refs ----------------------------------------------------------

    @property
    def textlets(self) -> list[Textlet]:
        return [tl for tl in self._doc.textlets if tl.utterance.id == self.id]

    @property
    def patterns(self) -> list[Pattern]:
        return self._doc._patterns_for_utt(self.id)

    @property
    def eaf_annotation(self) -> EafAnnotation | None:
        ann_id = self._doc._raw['utt_ann_ref'].get(self.id)
        if ann_id and ann_id in self._doc._elan.annotations:
            return EafAnnotation(ann_id, self._doc)
        return None

    def __repr__(self) -> str:
        cont = ' (continuation)' if self.is_continuation else ''
        return f'Utterance({self.participant!r}, {self.text[:40]!r}{cont})'


# ---------------------------------------------------------------------------
# Textlet
# ---------------------------------------------------------------------------

class Textlet:
    __slots__ = ('_rec', '_doc')

    def __init__(self, rec: dict, doc: MumoDoc) -> None:
        self._rec = rec
        self._doc = doc

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def type(self) -> str:
        return self._rec.get('type', '')

    @property
    def _mark(self) -> dict | None:
        return self._doc._raw['marks'].get(self._rec['mark_id'])

    @property
    def utterance(self) -> Utterance:
        mark = self._mark
        if mark:
            return self._doc._utt_obj(mark['block_id'])
        raise ValueError(f'Textlet {self.id} has no mark')

    @property
    def start(self) -> int:
        mark = self._mark
        return mark['start'] if mark else 0

    @property
    def end(self) -> int:
        mark = self._mark
        return mark['end'] if mark else 0

    @property
    def text(self) -> str:
        mark = self._mark
        if not mark:
            return ''
        utt = self._doc._utt_obj(mark['block_id'])
        return utt.text[mark['start']:mark['end']]

    @property
    def patterns(self) -> list[Pattern]:
        return self._doc._patterns_for_textlet(self.id)

    def __repr__(self) -> str:
        return f'Textlet({self.text!r})'


# ---------------------------------------------------------------------------
# EafAnnotation
# ---------------------------------------------------------------------------

class EafAnnotation:
    __slots__ = ('_id', '_doc')

    def __init__(self, ann_id: str, doc: MumoDoc) -> None:
        self._id  = ann_id
        self._doc = doc

    @property
    def id(self) -> str:
        return self._id

    @property
    def tier_name(self) -> str:
        return self._doc._elan.annotations[self._id]

    @property
    def value(self) -> str:
        aligned, ref, _, _ = self._doc._elan.tiers[self.tier_name]
        if self._id in aligned:
            return aligned[self._id][2] or ''
        if self._id in ref:
            return ref[self._id][1] or ''
        return ''

    @property
    def time(self) -> tuple[float, float] | None:
        return self._doc._resolve_eaf_time(self._id, set())

    @property
    def parent(self) -> EafAnnotation | None:
        _, ref, _, _ = self._doc._elan.tiers[self.tier_name]
        if self._id in ref:
            pid = ref[self._id][0]
            if pid and pid in self._doc._elan.annotations:
                return EafAnnotation(pid, self._doc)
        return None

    @property
    def children(self) -> list[EafAnnotation]:
        result = []
        for (_, ref, _, _) in self._doc._elan.tiers.values():
            for aid, (parent_id, *_) in ref.items():
                if parent_id == self._id:
                    result.append(EafAnnotation(aid, self._doc))
        return result

    def __repr__(self) -> str:
        return f'EafAnnotation({self.tier_name!r}, {self.value!r})'


# ---------------------------------------------------------------------------
# PatternSchema / SlotSchema / MetricSchema
# ---------------------------------------------------------------------------

class MetricSchema:
    __slots__ = ('_rec',)

    def __init__(self, rec: dict) -> None:
        self._rec = rec

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def name(self) -> str:
        return self._rec['name']

    @property
    def type(self) -> str:
        return self._rec.get('type', 'text')

    def __repr__(self) -> str:
        return f'MetricSchema({self.name!r})'


class SlotSchema:
    __slots__ = ('_rec',)

    def __init__(self, rec: dict) -> None:
        self._rec = rec

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def name(self) -> str:
        return self._rec['name']

    @property
    def label(self) -> str | None:
        return self._rec.get('label')

    @property
    def anchor_kind(self) -> str:
        return self._rec.get('anchor_kind', 'textlet')

    @property
    def required(self) -> bool:
        return self._rec.get('required', False)

    @property
    def variadic(self) -> bool:
        return self._rec.get('variadic', False)

    @property
    def metrics(self) -> list[MetricSchema]:
        return [MetricSchema(m) for m in self._rec.get('metrics', [])]

    def __repr__(self) -> str:
        return f'SlotSchema({self.name!r}, anchor_kind={self.anchor_kind!r})'


class PatternSchema:
    __slots__ = ('_rec',)

    def __init__(self, rec: dict) -> None:
        self._rec = rec

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def name(self) -> str:
        return self._rec['name']

    @property
    def description(self) -> str | None:
        return self._rec.get('description')

    @property
    def color(self) -> int | None:
        return self._rec.get('color')

    @property
    def hotkey(self) -> str | None:
        return self._rec.get('hotkey')

    @property
    def slots(self) -> list[SlotSchema]:
        return [SlotSchema(s) for s in self._rec.get('slots', [])]

    def slot(self, name: str) -> SlotSchema | None:
        return next((s for s in self.slots if s.name == name or s.label == name), None)

    def __repr__(self) -> str:
        return f'PatternSchema({self.name!r})'


# ---------------------------------------------------------------------------
# MetricValue
# ---------------------------------------------------------------------------

class MetricValue:
    __slots__ = ('_rec', '_slot_schema')

    def __init__(self, rec: dict, slot_schema: SlotSchema | None) -> None:
        self._rec         = rec
        self._slot_schema = slot_schema

    @property
    def schema_id(self) -> str:
        return self._rec['schema_id']

    @property
    def name(self) -> str | None:
        if self._slot_schema is None:
            return None
        m = next((m for m in self._slot_schema.metrics if m.id == self.schema_id), None)
        return m.name if m else None

    @property
    def value(self) -> str | None:
        return self._rec.get('value')

    def __repr__(self) -> str:
        label = self.name or self.schema_id[:8]
        return f'MetricValue({label!r}={self.value!r})'


# ---------------------------------------------------------------------------
# Slot (instance)
# ---------------------------------------------------------------------------

class Slot:
    __slots__ = ('_rec', '_schema', '_doc')

    def __init__(self, rec: dict, schema: SlotSchema | None, doc: MumoDoc) -> None:
        self._rec    = rec
        self._schema = schema
        self._doc    = doc

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def name(self) -> str | None:
        return self._schema.name if self._schema else None

    @property
    def label(self) -> str | None:
        return self._schema.label if self._schema else None

    @property
    def anchor_kind(self) -> str | None:
        return self._schema.anchor_kind if self._schema else None

    @property
    def metrics(self) -> list[MetricValue]:
        return [MetricValue(m, self._schema) for m in self._rec.get('metrics', [])]

    def __getitem__(self, metric_name: str) -> str | None:
        """slot['metric_name'] → metric value."""
        if self._schema:
            for ms in self._schema.metrics:
                if ms.name == metric_name:
                    mv = next((m for m in self._rec.get('metrics', [])
                               if m['schema_id'] == ms.id), None)
                    return mv['value'] if mv else None
        return None

    # -- anchor resolution ---------------------------------------------------

    def _textlet_rec(self) -> dict | None:
        aid = self._rec.get('annotation_id', '')
        return self._doc._raw['textlets'].get(aid)

    def _mark_rec(self) -> dict | None:
        tl = self._textlet_rec()
        return self._doc._raw['marks'].get(tl['mark_id']) if tl else None

    @property
    def utterance(self) -> Utterance | None:
        mark = self._mark_rec()
        if mark:
            return self._doc._utt_obj(mark['block_id'])
        ann_rec = self._doc._raw['annotations'].get(self._rec.get('annotation_id', ''))
        if ann_rec:
            uid = ann_rec['features'].get('utteranceId') or ann_rec['features'].get('blockNodeId')
            if uid:
                utt = self._doc._utt_obj(uid)
                return utt
        return None

    @property
    def textlet(self) -> Textlet | None:
        tl = self._textlet_rec()
        return Textlet(tl, self._doc) if tl else None

    @property
    def text(self) -> str | None:
        tl = self.textlet
        if tl:
            return tl.text
        utt = self.utterance
        return utt.text if utt else None

    @property
    def anchor(self) -> UtteranceAnchor | TextletAnchor | TimeAnchor | None:
        kind = self.anchor_kind
        if kind == 'utterance':
            utt = self.utterance
            return UtteranceAnchor(kind='utterance', utterance=utt) if utt else None
        if kind == 'textlet':
            tl = self.textlet
            if tl is None:
                return None
            mark = self._mark_rec()
            utt  = self.utterance
            if mark and utt:
                return TextletAnchor(kind='textlet', utterance=utt,
                                     start=mark['start'], end=mark['end'],
                                     text=tl.text)
            return None
        if kind == 'time':
            t = self.time
            return TimeAnchor(kind='time', start=t[0], end=t[1]) if t else None
        return None

    @property
    def time(self) -> tuple[float, float] | None:
        aid = self._rec.get('annotation_id', '')
        if aid and aid in self._doc._elan.annotations:
            t = self._doc._resolve_eaf_time(aid, set())
            if t:
                return t
        utt = self.utterance
        if utt and utt.start_time is not None and utt.end_time is not None:
            return (utt.start_time, utt.end_time)
        return None

    def __repr__(self) -> str:
        name = self.name or '?'
        text = self.text
        preview = repr(text[:30]) if text else repr(self.anchor_kind)
        return f'Slot({name!r}, {preview})'


# ---------------------------------------------------------------------------
# Pattern
# ---------------------------------------------------------------------------

class Pattern:
    __slots__ = ('_rec', '_doc')

    def __init__(self, rec: dict, doc: MumoDoc) -> None:
        self._rec = rec
        self._doc = doc

    @property
    def id(self) -> str:
        return self._rec['id']

    @property
    def schema(self) -> PatternSchema | None:
        s = self._doc._raw['pattern_schemas'].get(self._rec['schema_id'])
        return PatternSchema(s) if s else None

    @property
    def note(self) -> str | None:
        return self._rec.get('note')

    def _slot_schema(self, schema_slot_id: str) -> SlotSchema | None:
        s = self.schema
        if s is None:
            return None
        return next((ss for ss in s.slots if ss.id == schema_slot_id), None)

    @property
    def slots(self) -> list[Slot]:
        return [Slot(s, self._slot_schema(s['schema_slot_id']), self._doc)
                for s in self._rec['slots']]

    def slot(self, name: str) -> Slot | None:
        """Get a slot by its schema slot name or label."""
        schema = self.schema
        if schema is None:
            return None
        ss = schema.slot(name)
        if ss is None:
            return None
        rec = next((s for s in self._rec['slots'] if s['schema_slot_id'] == ss.id), None)
        return Slot(rec, ss, self._doc) if rec else None

    def __getitem__(self, name: str) -> Slot | None:
        return self.slot(name)

    def __iter__(self) -> Iterator[Slot]:
        return iter(self.slots)

    def __repr__(self) -> str:
        schema_name = self.schema.name if self.schema else '?'
        return f'Pattern({schema_name!r}, {len(self._rec["slots"])} slot(s))'


# ---------------------------------------------------------------------------
# Backward-compat aliases
# ---------------------------------------------------------------------------

PatternView  = Pattern
FrameView    = Pattern
UtteranceView = Utterance
TokenView    = Token
TextletView  = Textlet
SlotView     = Slot
