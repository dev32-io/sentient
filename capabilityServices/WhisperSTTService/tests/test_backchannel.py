"""Backchannel classifier contract: whole-turn-only, multilingual, safe.

Pins the drop/keep boundary the pipeline depends on (turn_finalizer Step 2.5):
a turn that is ENTIRELY backchannel drops; a real turn — even one that merely
CONTAINS a backchannel — is kept, so nothing is burned from recognition.
"""
from __future__ import annotations

from whisper_stt.backchannel import BackchannelClassifier

_PHRASES = ("hmm", "hm", "mm", "mmm", "mhm", "mm-hmm", "uh-huh", "uh", "um", "huh", "嗯", "嗯嗯", "呃")


def _clf() -> BackchannelClassifier:
    return BackchannelClassifier(_PHRASES)


def test_lone_backchannel_en_is_dropped() -> None:
    assert _clf().is_backchannel("Hmm.") is True


def test_hyphenated_backchannel_tokens_all_match() -> None:
    # "uh-huh" / "mm-hmm" split to {uh,huh} / {mm,hmm} — every token is backchannel.
    assert _clf().is_backchannel("Uh-huh.") is True
    assert _clf().is_backchannel("Mm-hmm, mm-hmm.") is True


def test_lone_backchannel_zh_is_dropped() -> None:
    assert _clf().is_backchannel("嗯") is True
    assert _clf().is_backchannel("呃。") is True


def test_real_turn_containing_backchannel_is_kept() -> None:
    # The whole-turn rule: a real request that opens with "hmm" is NOT backchannel.
    assert _clf().is_backchannel("Hmm, what's the weather?") is False


def test_real_short_answer_is_kept() -> None:
    # Affirmations / short replies are not in the set — never dropped.
    assert _clf().is_backchannel("Yes.") is False
    assert _clf().is_backchannel("好") is False


def test_empty_is_not_backchannel() -> None:
    # Upstream content gate owns empties; an empty token list is not "all backchannel".
    assert _clf().is_backchannel("") is False
    assert _clf().is_backchannel("[pause.0]") is False


def test_empty_phrase_list_disables_gate() -> None:
    assert BackchannelClassifier(()).is_backchannel("hmm") is False
