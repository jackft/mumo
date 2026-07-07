from mumo import MumoDoc, UtteranceView, TokenView, AnnotationView, FrameView


def test_all_utterances_nonempty_and_sorted(doc):
    utts = doc.all_utterances()
    assert len(utts) > 0
    orders = [u.order for u in utts]
    assert orders == sorted(orders)


def test_utterance_has_participant_and_time(doc):
    utt = doc.all_utterances()[0]
    assert isinstance(utt.participant, str) and utt.participant
    assert utt.start_time is not None
    assert utt.end_time is not None
    assert utt.start_time <= utt.end_time


def test_utterance_text_matches_token_concatenation(doc):
    utt = doc.all_utterances()[0]
    assert utt.text == ''.join(t.text for t in utt.tokens)


def test_utterance_by_id_round_trip(doc):
    uid = doc.all_utterances()[0].id
    assert doc.utterance(uid) is not None
    assert doc.utterance(uid).id == uid


def test_utterance_unknown_id_returns_none(doc):
    assert doc.utterance('no-such-utt') is None


def test_token_by_id_round_trip(doc):
    tok = doc.all_tokens()[0]
    assert doc.token(tok.id) is not None
    assert doc.token(tok.id).id == tok.id


def test_token_unknown_id_returns_none(doc):
    assert doc.token('no-such-token') is None


def test_token_links_back_to_utterance(doc):
    tok = next(t for t in doc.all_tokens() if t.kind == 'word')
    assert tok.utterance is not None
    assert isinstance(tok.utterance, UtteranceView)


def test_token_index_among_non_ws(doc):
    utt = next(u for u in doc.all_utterances() if sum(1 for t in u.tokens if t.kind != 'ws') >= 3)
    word_toks = [t for t in utt.tokens if t.kind != 'ws']
    for i, t in enumerate(word_toks):
        assert t.index == i


def test_all_tokens_count_equals_sum_of_utterance_tokens(doc):
    total = sum(len(u.tokens) for u in doc.all_utterances())
    assert total == len(doc.all_tokens())


def test_token_bounded_time_uses_utterance_when_no_token_time(doc):
    tok = next(t for t in doc.all_tokens() if t.kind == 'word' and t.time is None)
    utt = tok.utterance
    if utt and utt.start_time is not None and utt.end_time is not None:
        bt = tok.bounded_time
        assert bt is not None
        assert bt[0] == utt.start_time
        assert bt[1] == utt.end_time


def test_eaf_annotation_unknown_returns_none(doc):
    assert doc.eaf_annotation('no-such-id') is None


def test_all_eaf_annotations_nonempty(doc):
    anns = doc.all_eaf_annotations()
    assert len(anns) > 0
    assert all(isinstance(a, AnnotationView) for a in anns)


def test_eaf_annotation_value_is_string(doc):
    ann = doc.all_eaf_annotations()[0]
    assert isinstance(ann.value, str)


def test_aligned_annotation_has_time(doc):
    ann = next((a for a in doc.all_eaf_annotations() if a.time is not None), None)
    assert ann is not None
    s, e = ann.time
    assert isinstance(s, float)
    assert s <= e


def test_ref_annotation_inherits_time(doc):
    ref_ann = next(
        (a for a in doc.all_eaf_annotations() if a.parent is not None),
        None,
    )
    if ref_ann is None:
        return  # file has no ref annotations - skip
    parent_time = ref_ann.parent.time
    child_time  = ref_ann.time
    if parent_time and child_time:
        assert child_time == parent_time


def test_frame_unknown_returns_none(doc):
    assert doc.frame('nope') is None


def test_all_frames_are_frame_views(doc):
    frames = doc.all_frames()
    assert all(isinstance(f, FrameView) for f in frames)


# -- SlotView content resolution ----------------------------------------------

def _frame_with_textlet_slots(doc):
    """Return a frame that has at least one textlet-backed slot."""
    return next(
        (f for f in doc.all_frames() if any(s._textlet() for s in f.slots)),
        None,
    )


def test_slot_utterance_resolves_via_textlet(doc):
    frame = _frame_with_textlet_slots(doc)
    if frame is None:
        return
    slot = next(s for s in frame.slots if s._textlet())
    utt = slot.utterance
    assert utt is not None
    assert isinstance(utt, UtteranceView)


def test_slot_span_returns_utt_and_char_range(doc):
    frame = _frame_with_textlet_slots(doc)
    if frame is None:
        return
    slot = next(s for s in frame.slots if s._textlet())
    utt, start, end = slot.span
    assert isinstance(utt, UtteranceView)
    assert isinstance(start, int)
    assert isinstance(end, int)
    assert start <= end


def test_slot_text_is_substring_of_utterance(doc):
    frame = _frame_with_textlet_slots(doc)
    if frame is None:
        return
    for slot in (s for s in frame.slots if s._textlet()):
        text = slot.text
        assert text is not None
        assert text in slot.utterance.text


def test_slot_time_derives_from_utterance(doc):
    frame = _frame_with_textlet_slots(doc)
    if frame is None:
        return
    for slot in (s for s in frame.slots if s._textlet()):
        t = slot.time
        if t is not None:
            s, e = t
            assert isinstance(s, float)
            assert s <= e


def test_marks_and_textlets_parsed(doc):
    assert len(doc._mumo['marks']) > 0
    assert len(doc._mumo['textlets']) > 0


def test_textlet_mark_block_id_references_known_utterance(doc):
    for tl in doc._mumo['textlets'].values():
        mark = doc._mumo['marks'].get(tl['mark_id'])
        assert mark is not None
        assert doc.utterance(mark['block_id']) is not None
