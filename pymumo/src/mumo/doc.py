"""MumoDoc: pympi.Elan.Eaf subclass with mumo-specific query API."""
from __future__ import annotations
import pympi
from ._parse import parse_mumo_data
from .views import UtteranceView, TokenView, AnnotationView, FrameView, TextletView


class MumoDoc(pympi.Elan.Eaf):
    """
    An MMEAF file loaded as a pympi.Elan.Eaf with the mm:mumo_data block
    parsed on top.

    EAF tiers/annotations are accessible via the standard pympi API
    (self.tiers, self.annotations, self.timeslots, ...).  Mumo utterances,
    tokens, and frames are accessible via the query methods below.
    """

    def __init__(self, file_path: str) -> None:
        super().__init__(file_path)
        self._mmeaf_path = file_path
        self._mumo = parse_mumo_data(file_path)
        self._utt_by_id: dict = {u['id']: u for u in self._mumo['utterances']}
        self._token_by_id: dict = {t['id']: t for t in self._mumo['tokens']}
        self._tokens_by_utt: dict[str, list[dict]] = {}
        for tok in self._mumo['tokens']:
            self._tokens_by_utt.setdefault(tok['utt_id'], []).append(tok)
        # Build time index for aligned EAF annotations: list of (start_ms, end_ms, ann_id)
        self._aligned_time_entries: list[tuple[int, int, str]] = []
        for tier_name, (aligned, _ref, _attrs, _ord) in self.tiers.items():
            for ann_id, (bts, ets, _val, _) in aligned.items():
                s = self.timeslots.get(bts)
                e = self.timeslots.get(ets)
                if s is not None and e is not None:
                    self._aligned_time_entries.append((s, e, ann_id))

    # -- Utterance queries -------------------------------------------------

    def utterance(self, uid: str) -> UtteranceView | None:
        u = self._utt_by_id.get(uid)
        return UtteranceView(u, self) if u else None

    def all_utterances(self) -> list[UtteranceView]:
        utts = sorted(self._mumo['utterances'], key=lambda u: u['order'])
        return [UtteranceView(u, self) for u in utts]

    # -- Token queries -----------------------------------------------------

    def token(self, tid: str) -> TokenView | None:
        t = self._token_by_id.get(tid)
        return TokenView(t, self) if t else None

    def all_tokens(self) -> list[TokenView]:
        return [TokenView(t, self) for t in self._mumo['tokens']]

    # -- ELAN annotation queries -------------------------------------------
    # Named eaf_* to avoid shadowing pympi's self.annotations dict attribute.

    def eaf_annotation(self, ann_id: str) -> AnnotationView | None:
        if ann_id in self.annotations:
            return AnnotationView(ann_id, self)
        return None

    def all_eaf_annotations(self) -> list[AnnotationView]:
        return [AnnotationView(aid, self) for aid in self.annotations]

    def eaf_tier(self, tier_name: str) -> list[AnnotationView]:
        """All annotations in a named EAF tier."""
        if tier_name not in self.tiers:
            return []
        aligned, ref, _, _ = self.tiers[tier_name]
        return [AnnotationView(aid, self) for aid in (*aligned, *ref)]

    # -- Frame / Pattern queries -------------------------------------------

    def frame(self, fid: str) -> FrameView | None:
        f = self._mumo['patterns'].get(fid)
        return FrameView(f, self) if f else None

    def all_frames(self) -> list[FrameView]:
        return [FrameView(f, self) for f in self._mumo['patterns'].values()]

    # -- Textlet queries ---------------------------------------------------

    def textlet(self, tid: str) -> TextletView | None:
        tl = self._mumo['textlets'].get(tid)
        return TextletView(tl, self) if tl else None

    def all_textlets(self) -> list[TextletView]:
        return [TextletView(tl, self) for tl in self._mumo['textlets'].values()]

    def frames_for_textlet(self, textlet_id: str) -> list[FrameView]:
        """All frames that have a slot referencing this textlet."""
        result = []
        for frame in self._mumo['patterns'].values():
            for slot in frame['slots']:
                if slot.get('annotation_id') == textlet_id:
                    result.append(FrameView(frame, self))
                    break
        return result

    # -- Cross-reference queries -------------------------------------------

    def annotations_overlapping(self, start_s: float, end_s: float,
                                 tier: str | None = None) -> list[AnnotationView]:
        """EAF annotations whose time span overlaps [start_s, end_s] (seconds)."""
        start_ms = start_s * 1000
        end_ms   = end_s   * 1000
        result = []
        for s, e, ann_id in self._aligned_time_entries:
            if s >= end_ms or e <= start_ms:
                continue
            if tier is None or self.annotations.get(ann_id) == tier:
                result.append(AnnotationView(ann_id, self))
        return result

    def frames_overlapping(self, start_s: float, end_s: float,
                            schema: str | None = None) -> list[FrameView]:
        """Frames that have at least one slot whose time overlaps [start_s, end_s]."""
        result = []
        for frame in self._mumo['patterns'].values():
            if schema is not None:
                fs = self._mumo['pattern_schemas'].get(frame['schema_id'])
                if fs is None or fs['name'] != schema:
                    continue
            fv = FrameView(frame, self)
            for sv in fv.slots:
                t = sv.time
                if t and t[0] < end_s and t[1] > start_s:
                    result.append(fv)
                    break
        return result

    # -- Internal helpers --------------------------------------------------

    def _utterance_view(self, uid: str) -> UtteranceView | None:
        u = self._utt_by_id.get(uid)
        return UtteranceView(u, self) if u else None

    def _tokens_for_utt(self, uid: str) -> list[dict]:
        return self._tokens_by_utt.get(uid, [])

    def _resolve_ann_time(self, ann_id: str, visited: set) -> tuple[float, float] | None:
        """Walk the parent chain to resolve a concrete time span (seconds)."""
        if ann_id in visited:
            return None
        visited.add(ann_id)

        tier_name = self.annotations.get(ann_id)
        if not tier_name:
            return None

        aligned, ref, _, _ = self.tiers[tier_name]
        if ann_id in aligned:
            begin_ts, end_ts, _, _ = aligned[ann_id]
            s_ms = self.timeslots.get(begin_ts)
            e_ms = self.timeslots.get(end_ts)
            if s_ms is not None and e_ms is not None:
                return (s_ms / 1000.0, e_ms / 1000.0)

        if ann_id in ref:
            parent_id = ref[ann_id][0]
            if parent_id:
                return self._resolve_ann_time(parent_id, visited)

        return None
