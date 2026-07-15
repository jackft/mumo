"""View classes wrapping parsed mumo data and pympi ELAN tier data."""
from __future__ import annotations
from typing import NamedTuple, TYPE_CHECKING

if TYPE_CHECKING:
    from .doc import MumoDoc


class UtteranceAnchor(NamedTuple):
    kind: str             # always 'utterance'
    utterance: object     # UtteranceView


class TextletAnchor(NamedTuple):
    kind: str             # always 'textlet'
    utterance: object     # UtteranceView
    start: int            # char offset (inclusive)
    end: int              # char offset (exclusive)
    text: str


SpanAnchor = TextletAnchor  # backward-compat alias


class TimeAnchor(NamedTuple):
    kind: str             # always 'time'
    start: float          # seconds
    end: float            # seconds


class UtteranceView:
    def __init__(self, record: dict, doc: MumoDoc) -> None:
        self._record = record
        self._doc = doc

    @property
    def id(self) -> str:
        return self._record['id']

    @property
    def participant(self) -> str:
        return self._record['participant']

    @property
    def order(self) -> int:
        return self._record['order']

    @property
    def start_ms(self) -> int | None:
        return self._record['start_ms']

    @property
    def end_ms(self) -> int | None:
        return self._record['end_ms']

    @property
    def start_time(self) -> float | None:
        ms = self._record['start_ms']
        return ms / 1000.0 if ms is not None else None

    @property
    def end_time(self) -> float | None:
        ms = self._record['end_ms']
        return ms / 1000.0 if ms is not None else None

    @property
    def tokens(self) -> list[TokenView]:
        return [TokenView(t, self._doc) for t in self._doc._tokens_for_utt(self._record['id'])]

    @property
    def text(self) -> str:
        return ''.join(t['text'] for t in self._doc._tokens_for_utt(self._record['id']))

    @property
    def eaf_annotation(self) -> object | None:
        """The EAF annotation directly referencing this utterance (via annotation_ref)."""
        ann_id = self._doc._mumo['utt_ann_ref'].get(self._record['id'])
        if ann_id and ann_id in self._doc.annotations:
            return AnnotationView(ann_id, self._doc)
        return None

    def eaf_annotations(self, tier: str | None = None) -> list:
        """
        Aligned EAF annotations overlapping this utterance's time span, plus
        their ref/symbolic children (POS, gloss, etc.).

        This is the structural path: frame -> slot -> utterance -> annotations.
        """
        s, e = self.start_time, self.end_time
        if s is None or e is None:
            return []
        aligned = self._doc.annotations_overlapping(s, e, tier=tier)
        seen = {a.id for a in aligned}
        result = list(aligned)
        for a in aligned:
            for child in a.children:
                if child.id not in seen:
                    seen.add(child.id)
                    result.append(child)
        return result


class TokenView:
    def __init__(self, record: dict, doc: MumoDoc) -> None:
        self._record = record
        self._doc = doc

    @property
    def id(self) -> str:
        return self._record['id']

    @property
    def text(self) -> str:
        return self._record['text']

    @property
    def kind(self) -> str:
        return self._record['kind']

    @property
    def utterance(self) -> UtteranceView | None:
        return self._doc._utterance_view(self._record['utt_id'])

    @property
    def index(self) -> int:
        """0-based index among non-ws tokens in the utterance."""
        word_toks = [t for t in self._doc._tokens_for_utt(self._record['utt_id'])
                     if t['kind'] != 'ws']
        return next((i for i, t in enumerate(word_toks) if t['id'] == self._record['id']), -1)

    @property
    def eaf_annotation(self) -> object | None:
        """The EAF annotation directly referencing this token (via annotation_ref)."""
        ann_id = self._doc._mumo['tok_ann_ref'].get(self._record['id'])
        if ann_id and ann_id in self._doc.annotations:
            return AnnotationView(ann_id, self._doc)
        return None

    @property
    def tier_annotations(self) -> list:
        """This token's direct EAF annotation and its symbolic children (POS, gloss, etc.)."""
        ann = self.eaf_annotation
        if ann is None:
            return []
        return [ann, *ann.children]

    @property
    def time(self) -> tuple[float | None, float | None] | None:
        """Stored token time as (start_sec, end_sec); either side may be None."""
        return self._doc._mumo['token_times'].get(self._record['id'])

    @property
    def bounded_time(self) -> tuple[float, float] | None:
        """Token time clamped to utterance bounds; open boundaries filled from utterance edges."""
        utt   = self.utterance
        utt_s = utt.start_time if utt else None
        utt_e = utt.end_time   if utt else None
        stored = self.time

        start = stored[0] if stored is not None and stored[0] is not None else utt_s
        end   = stored[1] if stored is not None and stored[1] is not None else utt_e

        if start is None or end is None:
            return None
        if utt_s is not None:
            start = max(start, utt_s)
        if utt_e is not None:
            end = min(end, utt_e)
        return (start, end)


class AnnotationView:
    """Wraps a single ELAN annotation from pympi's tier store."""

    def __init__(self, ann_id: str, doc: MumoDoc) -> None:
        self._id = ann_id
        self._doc = doc

    @property
    def id(self) -> str:
        return self._id

    @property
    def tier_name(self) -> str:
        return self._doc.annotations[self._id]

    @property
    def value(self) -> str:
        aligned, ref, _, _ = self._doc.tiers[self.tier_name]
        if self._id in aligned:
            return aligned[self._id][2] or ''
        if self._id in ref:
            return ref[self._id][1] or ''
        return ''

    @property
    def time(self) -> tuple[float, float] | None:
        return self._doc._resolve_ann_time(self._id, set())

    @property
    def parent(self) -> AnnotationView | None:
        _, ref, _, _ = self._doc.tiers[self.tier_name]
        if self._id in ref:
            parent_id = ref[self._id][0]
            if parent_id and parent_id in self._doc.annotations:
                return AnnotationView(parent_id, self._doc)
        return None

    @property
    def children(self) -> list[AnnotationView]:
        result = []
        for (_, ref, _, _) in self._doc.tiers.values():
            for aid, (parent_id, *_) in ref.items():
                if parent_id == self._id:
                    result.append(AnnotationView(aid, self._doc))
        return result

    @property
    def constraint(self) -> str | None:
        _, _, attrs, _ = self._doc.tiers[self.tier_name]
        lt_id = attrs.get('LINGUISTIC_TYPE_REF')
        if lt_id and lt_id in self._doc.linguistic_types:
            return self._doc.linguistic_types[lt_id].get('CONSTRAINTS')
        return None

    @property
    def utterance(self) -> object | None:
        """The mumo utterance whose time span contains this annotation."""
        t = self.time
        if t is None:
            return None
        s, e = t
        for utt in self._doc.all_utterances():
            us, ue = utt.start_time, utt.end_time
            if us is not None and ue is not None and us <= e and ue >= s:
                return utt
        return None

    @property
    def frames(self) -> list:
        """Frames that have a slot overlapping this annotation's time span."""
        t = self.time
        if t is None:
            return []
        return self._doc.frames_overlapping(t[0], t[1])


class MetricValue:
    def __init__(self, record: dict) -> None:
        self._record = record

    @property
    def schema_id(self) -> str:
        return self._record['schema_id']

    @property
    def value(self) -> str | None:
        return self._record.get('value')


class SlotView:
    def __init__(self, instance: dict, frame_schema: dict | None, doc: MumoDoc) -> None:
        self._instance = instance
        self._frame_schema = frame_schema
        self._doc = doc

    @property
    def id(self) -> str:
        return self._instance['id']

    @property
    def schema_slot_id(self) -> str:
        return self._instance['schema_slot_id']

    @property
    def metrics(self) -> list[MetricValue]:
        return [MetricValue(m) for m in self._instance.get('metrics', [])]

    @property
    def schema(self) -> dict | None:
        if self._frame_schema is None:
            return None
        return next(
            (s for s in self._frame_schema['slots'] if s['id'] == self._instance['schema_slot_id']),
            None,
        )

    @property
    def anchor_kind(self) -> str | None:
        """'utterance', 'textlet', 'time', or 'frame' - the discriminant for .anchor."""
        s = self.schema
        return s['anchor_kind'] if s else None

    @property
    def anchor(self) -> UtteranceAnchor | TextletAnchor | TimeAnchor | None:
        """
        The resolved content of this slot as a typed value.

          UtteranceAnchor  .utterance
          TextletAnchor    .utterance  .start  .end  .text
          TimeAnchor       .start  .end
        """
        kind = self.anchor_kind
        if kind == 'utterance':
            utt = self.utterance
            if utt is None:
                return None
            return UtteranceAnchor(kind='utterance', utterance=utt)
        if kind == 'textlet':
            sp = self.span
            if sp is None:
                return None
            utt, start, end = sp
            return TextletAnchor(kind='textlet', utterance=utt, start=start, end=end,
                                 text=utt.text[start:end])
        if kind == 'time':
            t = self.time
            if t is None:
                return None
            return TimeAnchor(kind='time', start=t[0], end=t[1])
        return None

    # -- Typed content accessors --------------------------------------------------

    def _textlet(self) -> dict | None:
        aid = self._instance.get('annotation_id', '')
        return self._doc._mumo['textlets'].get(aid)

    def _mark(self) -> dict | None:
        tl = self._textlet()
        if tl is None:
            return None
        return self._doc._mumo['marks'].get(tl['mark_id'])

    @property
    def utterance(self) -> UtteranceView | None:
        """The utterance this slot is anchored to (via textlet mark block_id)."""
        mark = self._mark()
        if mark:
            return self._doc._utterance_view(mark['block_id'])
        # fall back to utterance/token-anchored annotation
        aid = self._instance.get('annotation_id', '')
        ann = self._doc._mumo['annotations'].get(aid)
        if ann:
            utt_id = ann['features'].get('blockNodeId') or ann['features'].get('utteranceId')
            if utt_id:
                return self._doc._utterance_view(utt_id)
        return None

    @property
    def span(self) -> tuple[UtteranceView, int, int] | None:
        """
        (utterance, start_char, end_char) for textlet-anchored slots.
        Character offsets are into the utterance's plain text (token concatenation).
        Returns None if the slot has no textlet mark.
        """
        mark = self._mark()
        if mark is None:
            return None
        utt = self._doc._utterance_view(mark['block_id'])
        if utt is None:
            return None
        return (utt, mark['start'], mark['end'])

    @property
    def text(self) -> str | None:
        """
        Plain text of the slot's span, reconstructed from tokens.
        Returns None if the slot has no textlet mark.
        """
        sp = self.span
        if sp is None:
            return None
        utt, start, end = sp
        full = utt.text
        return full[start:end]

    @property
    def time(self) -> tuple[float, float] | None:
        """
        Resolved time span in seconds.
        Tries: EAF annotation -> utterance time.
        """
        aid = self._instance.get('annotation_id', '')
        # EAF tier annotation
        if aid and aid in self._doc.annotations:
            t = self._doc._resolve_ann_time(aid, set())
            if t:
                return t
        # derive from the utterance anchor
        utt = self.utterance
        if utt and utt.start_time is not None and utt.end_time is not None:
            return (utt.start_time, utt.end_time)
        return None

    @property
    def annotation(self) -> AnnotationView | None:
        """The EAF tier annotation this slot points to, if any."""
        aid = self._instance.get('annotation_id', '')
        if aid and aid in self._doc.annotations:
            return AnnotationView(aid, self._doc)
        return None

    def tier_annotations(self, tier: str | None = None) -> list[AnnotationView]:
        """
        EAF annotations for this slot via its utterance (structural path):
        utterance -> aligned annotations -> their ref/symbolic children.
        Falls back to time-overlap if the slot has no utterance anchor.
        """
        utt = self.utterance
        if utt is not None:
            return utt.eaf_annotations(tier=tier)
        t = self.time
        if t is None:
            return []
        return self._doc.annotations_overlapping(t[0], t[1], tier=tier)


class FrameView:
    def __init__(self, record: dict, doc: MumoDoc) -> None:
        self._record = record
        self._doc = doc

    @property
    def id(self) -> str:
        return self._record['id']

    @property
    def note(self) -> str | None:
        return self._record.get('note')

    @property
    def schema(self) -> dict | None:
        return self._doc._mumo['pattern_schemas'].get(self._record['schema_id'])

    @property
    def slots(self) -> list[SlotView]:
        schema = self.schema
        return [SlotView(s, schema, self._doc) for s in self._record['slots']]

    def slot(self, name_or_index: str | int) -> SlotView | None:
        schema = self.schema
        if schema is None:
            return None
        if isinstance(name_or_index, int):
            slot_defs = schema['slots']
            if name_or_index >= len(slot_defs):
                return None
            slot_def = slot_defs[name_or_index]
        else:
            slot_def = next(
                (s for s in schema['slots']
                 if s['name'] == name_or_index or s.get('label') == name_or_index),
                None,
            )
        if slot_def is None:
            return None
        instance = next(
            (s for s in self._record['slots'] if s['schema_slot_id'] == slot_def['id']),
            None,
        )
        if instance is None:
            return None
        return SlotView(instance, schema, self._doc)

    @property
    def time(self) -> tuple[float, float] | None:
        """Bounding time box spanning all slot times in this frame."""
        start = end = None
        for sv in self.slots:
            t = sv.time
            if t is None:
                continue
            if start is None or t[0] < start:
                start = t[0]
            if end is None or t[1] > end:
                end = t[1]
        if start is None or end is None:
            return None
        return (start, end)

    def tier_annotations(self, tier: str | None = None) -> list[AnnotationView]:
        """EAF annotations overlapping any slot in this frame, deduplicated."""
        seen: set = set()
        result = []
        for sv in self.slots:
            for av in sv.tier_annotations(tier=tier):
                if av.id not in seen:
                    seen.add(av.id)
                    result.append(av)
        return result


class TextletView:
    """Wraps a mm:textlet - a reified, named text selection."""

    def __init__(self, record: dict, doc: MumoDoc) -> None:
        self._record = record
        self._doc = doc

    @property
    def id(self) -> str:
        return self._record['id']

    @property
    def mark(self) -> dict | None:
        return self._doc._mumo['marks'].get(self._record['mark_id'])

    @property
    def utterance(self) -> UtteranceView | None:
        """The utterance this textlet is anchored to."""
        mark = self.mark
        if mark:
            return self._doc._utterance_view(mark['block_id'])
        return None

    @property
    def span(self) -> tuple[UtteranceView, int, int] | None:
        """(utterance, start_char, end_char) from the textlet's mark."""
        mark = self.mark
        if mark is None:
            return None
        utt = self._doc._utterance_view(mark['block_id'])
        if utt is None:
            return None
        return (utt, mark['start'], mark['end'])

    @property
    def text(self) -> str | None:
        """The plain text this textlet covers."""
        sp = self.span
        if sp is None:
            return None
        utt, start, end = sp
        return utt.text[start:end]

    @property
    def frames(self) -> list[FrameView]:
        """All frames that have a slot referencing this textlet."""
        return self._doc.frames_for_textlet(self._record['id'])

    def tier_annotations(self, tier: str | None = None) -> list[AnnotationView]:
        """EAF annotations that overlap the utterance time of this textlet."""
        utt = self.utterance
        if utt is None:
            return []
        s, e = utt.start_time, utt.end_time
        if s is None or e is None:
            return []
        return self._doc.annotations_overlapping(s, e, tier=tier)
