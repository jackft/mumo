from mumo import MumoDoc, Utterance, Token, Pattern, Textlet
import pytest


def test_utterances_nonempty_and_sorted(doc):
    utts = doc.utterances
    assert len(utts) > 0
    assert all(isinstance(u, Utterance) for u in utts)
    orders = [u.order for u in utts]
    assert orders == sorted(orders)


def test_utterance_has_participant_and_time(doc):
    utt = doc.utterances[0]
    assert isinstance(utt.participant, str) and utt.participant
    assert utt.start_time is None or isinstance(utt.start_time, float)


def test_utterance_text_matches_token_concatenation(doc):
    for utt in doc.utterances:
        assert utt.text == ''.join(t.text for t in utt.tokens)


def test_utterance_lookup_by_id(doc):
    utt = doc.utterances[0]
    assert doc.utterance(utt.id).id == utt.id
    assert doc[utt.id].id == utt.id


def test_utterance_unknown_id_returns_none(doc):
    assert doc.utterance('__nope__') is None


def test_utterance_words_excludes_whitespace(doc):
    for utt in doc.utterances:
        for tok in utt.words:
            assert tok.kind != 'ws'


def test_utterance_continuations(doc):
    for utt in doc.utterances:
        if utt.is_continuation:
            assert utt.head is not None
            assert isinstance(utt.head, Utterance)
            assert utt in utt.head.continuations
        else:
            assert utt.head is None


def test_utterance_chain_starts_at_head(doc):
    for utt in doc.utterances:
        chain = utt.chain
        assert len(chain) >= 1
        assert not chain[0].is_continuation


def test_token_links_back_to_utterance(doc):
    for utt in doc.utterances[:3]:
        for tok in utt.tokens:
            assert tok.utterance.id == utt.id


def test_patterns_are_pattern_objects(doc):
    assert all(isinstance(p, Pattern) for p in doc.patterns)


def test_pattern_lookup_by_id(doc):
    patterns = doc.patterns
    if not patterns:
        return
    p = patterns[0]
    assert doc.pattern(p.id).id == p.id
    assert doc[p.id].id == p.id


def test_pattern_schema_accessible(doc):
    for p in doc.patterns:
        assert p.schema is not None


def test_pattern_iteration(doc):
    for p in doc.patterns:
        for slot in p:
            assert slot.name is not None


def test_pattern_slot_by_name(doc):
    for p in doc.patterns:
        for slot in p.slots:
            if slot.name:
                found = p[slot.name]
                assert found is not None
                assert found.name == slot.name


def _pattern_with_textlet_slots(doc):
    return next(
        (p for p in doc.patterns if any(s._textlet_rec() for s in p.slots)),
        None,
    )


def test_slot_utterance_resolves(doc):
    p = _pattern_with_textlet_slots(doc)
    if p is None:
        return
    slot = next(s for s in p.slots if s._textlet_rec())
    assert isinstance(slot.utterance, Utterance)


def test_slot_text_is_substring_of_utterance(doc):
    p = _pattern_with_textlet_slots(doc)
    if p is None:
        return
    for slot in (s for s in p.slots if s._textlet_rec()):
        assert slot.text in slot.utterance.text


def test_slot_time_derives_from_utterance(doc):
    p = _pattern_with_textlet_slots(doc)
    if p is None:
        return
    for slot in (s for s in p.slots if s._textlet_rec()):
        assert slot.time is not None


def test_textlets_are_textlet_objects(doc):
    assert all(isinstance(tl, Textlet) for tl in doc.textlets)


def test_textlet_lookup(doc):
    tls = doc.textlets
    if not tls:
        return
    tl = tls[0]
    assert doc.textlet(tl.id).id == tl.id
    assert doc[tl.id].id == tl.id


def test_textlet_text_is_substring_of_utterance(doc):
    for tl in doc.textlets:
        assert tl.text in tl.utterance.text


def test_textlet_patterns_returns_patterns(doc):
    for tl in doc.textlets:
        assert all(isinstance(p, Pattern) for p in tl.patterns)


def test_getitem_unknown_raises(doc):
    with pytest.raises(KeyError):
        doc['__nope__']
