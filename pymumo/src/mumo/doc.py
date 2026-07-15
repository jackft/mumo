"""MumoDoc: the main entry point for reading an MMEAF file."""
from __future__ import annotations
import pympi
from ._parse import parse_mumo_data
from .views import (
    Utterance, Token, Textlet, EafAnnotation,
    Pattern, PatternSchema, Slot,
    OverlapMark, OverlapGroup,
)


class MumoDoc(pympi.Elan.Eaf):
    """
    An MMEAF file loaded as a pympi.Elan.Eaf with the mm:mumo_data block
    parsed on top.

    EAF tiers/annotations are accessible via the standard pympi API.
    Mumo-specific data is accessible via the rich query properties below.
    """

    def __init__(self, file_path: str) -> None:
        super().__init__(file_path)
        self._mmeaf_path = file_path
        self._elan       = self           # alias so views can reach pympi internals
        self._raw        = parse_mumo_data(file_path)

        # indexes
        self._utt_by_id:      dict[str, dict] = {u['id']: u for u in self._raw['utterances']}
        self._tokens_by_utt:  dict[str, list[dict]] = {}
        self._continuations:  dict[str, list[str]] = {}  # head_id → [continuation_ids]

        for tok in self._raw['tokens']:
            self._tokens_by_utt.setdefault(tok['utt_id'], []).append(tok)

        for utt in self._raw['utterances']:
            head = utt.get('continuation_of')
            if head:
                self._continuations.setdefault(head, []).append(utt['id'])

        # EAF time index
        self._aligned_time_entries: list[tuple[int, int, str]] = []
        for tier_name, (aligned, _ref, _attrs, _ord) in self.tiers.items():
            for ann_id, (bts, ets, _val, _) in aligned.items():
                s = self.timeslots.get(bts)
                e = self.timeslots.get(ets)
                if s is not None and e is not None:
                    self._aligned_time_entries.append((s, e, ann_id))

    # -----------------------------------------------------------------------
    # Primary collections
    # -----------------------------------------------------------------------

    @property
    def utterances(self) -> list[Utterance]:
        """All utterance blocks, sorted by order."""
        return [Utterance(u, self)
                for u in sorted(self._raw['utterances'], key=lambda u: u['order'])]

    @property
    def textlets(self) -> list[Textlet]:
        return [Textlet(tl, self) for tl in self._raw['textlets'].values()]

    @property
    def eaf_annotations(self) -> list[EafAnnotation]:
        """All EAF-tier annotations."""
        return [EafAnnotation(aid, self) for aid in self._elan.annotations]

    @property
    def patterns(self) -> list[Pattern]:
        return [Pattern(p, self) for p in self._raw['patterns'].values()]

    @property
    def pattern_schemas(self) -> list[PatternSchema]:
        return [PatternSchema(s) for s in self._raw['pattern_schemas'].values()]

    @property
    def overlap_groups(self) -> list[OverlapGroup]:
        groups: dict[str, list] = {}
        for utt in self.utterances:
            for mark in utt.overlap_marks:
                groups.setdefault(mark.group_id, []).append((utt, mark))
        return [OverlapGroup(gid, entries) for gid, entries in groups.items()]

    def overlap_group(self, group_id: str) -> OverlapGroup | None:
        entries = []
        for utt in self.utterances:
            for mark in utt.overlap_marks:
                if mark.group_id == group_id:
                    entries.append((utt, mark))
        return OverlapGroup(group_id, entries) if entries else None

    # -----------------------------------------------------------------------
    # Lookup by ID
    # -----------------------------------------------------------------------

    def __getitem__(self, obj_id: str) -> 'Utterance | Textlet | Pattern | EafAnnotation':
        if obj_id in self._utt_by_id:
            return Utterance(self._utt_by_id[obj_id], self)
        if obj_id in self._raw['textlets']:
            return Textlet(self._raw['textlets'][obj_id], self)
        if obj_id in self._raw['patterns']:
            return Pattern(self._raw['patterns'][obj_id], self)
        if obj_id in self._elan.annotations:
            return EafAnnotation(obj_id, self)
        raise KeyError(obj_id)

    def utterance(self, uid: str) -> Utterance | None:
        rec = self._utt_by_id.get(uid)
        return Utterance(rec, self) if rec else None

    def textlet(self, tid: str) -> Textlet | None:
        rec = self._raw['textlets'].get(tid)
        return Textlet(rec, self) if rec else None

    def pattern(self, pid: str) -> Pattern | None:
        rec = self._raw['patterns'].get(pid)
        return Pattern(rec, self) if rec else None

    def pattern_schema(self, name_or_id: str) -> PatternSchema | None:
        for rec in self._raw['pattern_schemas'].values():
            if rec['id'] == name_or_id or rec['name'] == name_or_id:
                return PatternSchema(rec)
        return None

    # -----------------------------------------------------------------------
    # EAF queries
    # -----------------------------------------------------------------------

    def eaf_tier(self, tier_name: str) -> list[EafAnnotation]:
        if tier_name not in self.tiers:
            return []
        aligned, ref, _, _ = self.tiers[tier_name]
        return [EafAnnotation(aid, self) for aid in (*aligned, *ref)]

    def annotations_overlapping(self, start_s: float, end_s: float,
                                 tier: str | None = None) -> list[EafAnnotation]:
        start_ms = start_s * 1000
        end_ms   = end_s   * 1000
        result = []
        for s, e, ann_id in self._aligned_time_entries:
            if s >= end_ms or e <= start_ms:
                continue
            if tier is None or self._elan.annotations.get(ann_id) == tier:
                result.append(EafAnnotation(ann_id, self))
        return result

    def patterns_overlapping(self, start_s: float, end_s: float,
                              schema: str | None = None) -> list[Pattern]:
        result = []
        for rec in self._raw['patterns'].values():
            if schema is not None:
                ps = self._raw['pattern_schemas'].get(rec['schema_id'])
                if ps is None or ps['name'] != schema:
                    continue
            pv = Pattern(rec, self)
            for sv in pv.slots:
                t = sv.time
                if t and t[0] < end_s and t[1] > start_s:
                    result.append(pv)
                    break
        return result

    # -----------------------------------------------------------------------
    # Internal helpers (used by view objects)
    # -----------------------------------------------------------------------

    def _utt_obj(self, uid: str) -> Utterance | None:
        rec = self._utt_by_id.get(uid)
        return Utterance(rec, self) if rec else None

    def _tokens_for(self, uid: str) -> list[dict]:
        return self._tokens_by_utt.get(uid, [])

    def _continuations_of(self, head_id: str) -> list[Utterance]:
        return [Utterance(self._utt_by_id[cid], self)
                for cid in self._continuations.get(head_id, [])
                if cid in self._utt_by_id]

    def _patterns_for_utt(self, utt_id: str) -> list[Pattern]:
        result = []
        for rec in self._raw['patterns'].values():
            for slot in rec['slots']:
                ann = self._raw['annotations'].get(slot.get('annotation_id', ''))
                if ann and ann['features'].get('utteranceId') == utt_id:
                    result.append(Pattern(rec, self))
                    break
        return result

    def _patterns_for_textlet(self, textlet_id: str) -> list[Pattern]:
        result = []
        for rec in self._raw['patterns'].values():
            for slot in rec['slots']:
                if slot.get('annotation_id') == textlet_id:
                    result.append(Pattern(rec, self))
                    break
        return result

    def _resolve_eaf_time(self, ann_id: str, visited: set) -> tuple[float, float] | None:
        if ann_id in visited:
            return None
        visited.add(ann_id)
        tier_name = self._elan.annotations.get(ann_id)
        if not tier_name:
            return None
        aligned, ref, _, _ = self.tiers[tier_name]
        if ann_id in aligned:
            bts, ets, _, _ = aligned[ann_id]
            s_ms = self.timeslots.get(bts)
            e_ms = self.timeslots.get(ets)
            if s_ms is not None and e_ms is not None:
                return (s_ms / 1000.0, e_ms / 1000.0)
        if ann_id in ref:
            parent_id = ref[ann_id][0]
            if parent_id:
                return self._resolve_eaf_time(parent_id, visited)
        return None
