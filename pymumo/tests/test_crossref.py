"""Cross-reference tests: patterns <-> EAF tiers <-> textlets."""
from mumo import MumoDoc, EafAnnotation, Pattern, Textlet, Utterance


def test_all_textlets_are_textlets(doc):
    assert all(isinstance(t, Textlet) for t in doc.textlets)


def test_textlet_utterance_is_utterance(doc):
    tls = [t for t in doc.textlets if t._mark is not None]
    if not tls:
        return
    assert isinstance(tls[0].utterance, Utterance)


def test_textlet_span_offsets(doc):
    tls = [t for t in doc.textlets if t._mark is not None]
    if not tls:
        return
    tl = tls[0]
    assert isinstance(tl.start, int) and isinstance(tl.end, int)
    assert tl.start <= tl.end


def test_textlet_text_is_substring(doc):
    for tl in doc.textlets:
        assert tl.text in tl.utterance.text


def test_textlet_patterns(doc):
    for tl in doc.textlets:
        assert all(isinstance(p, Pattern) for p in tl.patterns)


def test_patterns_for_textlet(doc):
    for pattern in doc.patterns:
        for sv in pattern.slots:
            tl = sv.textlet
            if tl is not None:
                referencing = tl.patterns
                assert any(p.id == pattern.id for p in referencing)


def test_annotations_overlapping_returns_eaf_annotations(doc):
    anns = doc.eaf_annotations
    timed = [a for a in anns if a.time is not None]
    if not timed:
        return
    t = timed[0].time
    result = doc.annotations_overlapping(t[0], t[1])
    assert len(result) > 0
    assert all(isinstance(a, EafAnnotation) for a in result)


def test_annotations_overlapping_includes_self(doc):
    timed = [a for a in doc.eaf_annotations if a.time is not None]
    if not timed:
        return
    ann = timed[0]
    s, e = ann.time
    ids = {a.id for a in doc.annotations_overlapping(s, e)}
    assert ann.id in ids


def test_annotations_overlapping_tier_filter(doc):
    timed = [a for a in doc.eaf_annotations if a.time is not None]
    if not timed:
        return
    ann = timed[0]
    s, e = ann.time
    filtered = doc.annotations_overlapping(s, e, tier=ann.tier_name)
    assert all(a.tier_name == ann.tier_name for a in filtered)


def test_annotations_overlapping_empty_range(doc):
    assert doc.annotations_overlapping(1e9, 1e9 + 0.001) == []


def test_patterns_overlapping(doc):
    if not doc.patterns:
        return
    for pv in doc.patterns:
        t = pv.slots[0].time if pv.slots else None
        if t:
            result = doc.patterns_overlapping(t[0], t[1])
            assert len(result) > 0
            assert all(isinstance(p, Pattern) for p in result)
            return


def test_pattern_time_is_valid_range(doc):
    for pv in doc.patterns:
        for slot in pv.slots:
            t = slot.time
            if t is not None:
                assert t[0] <= t[1]


def test_utterance_patterns(doc):
    for utt in doc.utterances:
        assert all(isinstance(p, Pattern) for p in utt.patterns)
