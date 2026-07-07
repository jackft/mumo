"""Cross-reference tests: frames <-> EAF tiers <-> textlets."""
import pytest
from mumo import (MumoDoc, AnnotationView, FrameView, TextletView,
                  UtteranceView)


# -- TextletView --------------------------------------------------------------

def test_all_textlets_returns_textlet_views(doc):
    textlets = doc.all_textlets()
    assert all(isinstance(t, TextletView) for t in textlets)


def test_textlet_by_id_round_trip(doc):
    textlets = doc.all_textlets()
    if not textlets:
        return
    tl = textlets[0]
    assert doc.textlet(tl.id) is not None
    assert doc.textlet(tl.id).id == tl.id


def test_textlet_unknown_returns_none(doc):
    assert doc.textlet('__no_such_textlet__') is None


def test_textlet_utterance_is_utterance_view(doc):
    textlets = [t for t in doc.all_textlets() if t.utterance is not None]
    if not textlets:
        return
    assert isinstance(textlets[0].utterance, UtteranceView)


def test_textlet_span_returns_utt_and_offsets(doc):
    textlets = [t for t in doc.all_textlets() if t.span is not None]
    if not textlets:
        return
    utt, start, end = textlets[0].span
    assert isinstance(utt, UtteranceView)
    assert isinstance(start, int) and isinstance(end, int)
    assert start <= end


def test_textlet_text_is_substring_of_utterance(doc):
    textlets = [t for t in doc.all_textlets() if t.text is not None]
    if not textlets:
        return
    tl = textlets[0]
    assert tl.text in tl.utterance.text


def test_textlet_frames_returns_frame_views(doc):
    textlets = doc.all_textlets()
    for tl in textlets:
        assert all(isinstance(f, FrameView) for f in tl.frames)


# -- frames_for_textlet -------------------------------------------------------

def test_frames_for_textlet_finds_referencing_frames(doc):
    """Every textlet that is referenced by a slot should appear in frames_for_textlet."""
    for frame in doc.all_frames():
        for sv in frame.slots:
            tl_id = sv._instance.get('annotation_id', '')
            if tl_id and tl_id in doc._mumo['textlets']:
                referencing = doc.frames_for_textlet(tl_id)
                assert any(f.id == frame.id for f in referencing)


# -- annotations_overlapping --------------------------------------------------

def test_annotations_overlapping_returns_annotation_views(doc):
    anns = doc.all_eaf_annotations()
    timed = [a for a in anns if a.time is not None]
    if not timed:
        return
    t = timed[0].time
    result = doc.annotations_overlapping(t[0], t[1])
    assert len(result) > 0
    assert all(isinstance(a, AnnotationView) for a in result)


def test_annotations_overlapping_includes_self(doc):
    timed = [a for a in doc.all_eaf_annotations() if a.time is not None]
    if not timed:
        return
    ann = timed[0]
    s, e = ann.time
    result = doc.annotations_overlapping(s, e)
    ids = {a.id for a in result}
    assert ann.id in ids


def test_annotations_overlapping_tier_filter(doc):
    timed = [a for a in doc.all_eaf_annotations() if a.time is not None]
    if not timed:
        return
    ann = timed[0]
    s, e = ann.time
    tier = ann.tier_name
    filtered = doc.annotations_overlapping(s, e, tier=tier)
    assert all(a.tier_name == tier for a in filtered)


def test_annotations_overlapping_empty_range_returns_empty(doc):
    result = doc.annotations_overlapping(1e9, 1e9 + 0.001)
    assert result == []


# -- frames_overlapping -------------------------------------------------------

def test_frames_overlapping_returns_frame_views(doc):
    if not doc._mumo['frames']:
        return
    # Use the time of the first frame that has a time
    for fv in doc.all_frames():
        t = fv.time
        if t:
            result = doc.frames_overlapping(t[0], t[1])
            assert len(result) > 0
            assert all(isinstance(f, FrameView) for f in result)
            return


def test_frames_overlapping_includes_self(doc):
    if not doc._mumo['frames']:
        return
    for fv in doc.all_frames():
        t = fv.time
        if t:
            result = doc.frames_overlapping(t[0], t[1])
            assert any(f.id == fv.id for f in result)
            return


# -- AnnotationView cross-refs ------------------------------------------------

def test_annotation_utterance_is_utterance_view_or_none(doc):
    timed = [a for a in doc.all_eaf_annotations() if a.time is not None]
    if not timed:
        return
    utt = timed[0].utterance
    assert utt is None or isinstance(utt, UtteranceView)


def test_annotation_frames_returns_frame_views(doc):
    for ann in doc.all_eaf_annotations():
        assert all(isinstance(f, FrameView) for f in ann.frames)


# -- SlotView.tier_annotations ------------------------------------------------

def test_slot_tier_annotations_returns_annotation_views(doc):
    if not doc._mumo['frames']:
        return
    for fv in doc.all_frames():
        for sv in fv.slots:
            anns = sv.tier_annotations()
            assert all(isinstance(a, AnnotationView) for a in anns)
            return  # one slot is enough


# -- FrameView cross-refs -----------------------------------------------------

def test_frame_time_is_none_or_valid_range(doc):
    for fv in doc.all_frames():
        t = fv.time
        if t is not None:
            assert t[0] <= t[1]


def test_frame_tier_annotations_returns_annotation_views(doc):
    if not doc._mumo['frames']:
        return
    for fv in doc.all_frames():
        anns = fv.tier_annotations()
        assert all(isinstance(a, AnnotationView) for a in anns)
