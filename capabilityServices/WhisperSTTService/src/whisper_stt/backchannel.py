"""Backchannel classifier — a swappable turn-level unit.

Drops turns that are ONLY conversational backchannel ("hmm", "嗯", "uh-huh") —
listening noise the user didn't intend as a message. It sits at the end of turn
decode (after the content gate, before emit) and, like the streaming decorator
units, has ONE responsibility, lives in ONE file, and is injected by the flow
manager (``TurnPipeline``). The turn path is synchronous, so this is the turn-
level analog of a decorator unit, not an ``AsyncGenerator``.

Contract — the ONLY thing the pipeline depends on:

    classifier.is_backchannel(text: str) -> bool

Swap this class for an acoustic classifier later (e.g. YAMNet/voc2vec on the
turn audio) without touching ``turn_finalizer`` — keep the method signature.

Why lexical + whole-turn: Whisper already decodes a hum to "Hmm"/"嗯", so a
whole-turn token check IS the classifier and needs no extra model. WHOLE-TURN
only: a real turn that merely CONTAINS a backchannel ("hmm, what's the weather?")
has non-backchannel tokens, so it is NOT dropped — nothing is burned from
Whisper's recognition. Language-neutral by construction: the token set is built
from a config list, so adding a language is editing the list, not the code.
"""

from __future__ import annotations

import re

# ``[pause.N]`` markers are pipeline artifacts, not content — strip before
# tokenizing. ``\w`` is Unicode-aware, so CJK ("嗯") counts as a word char and
# survives the separator split; punctuation / hyphens / spaces separate tokens
# ("uh-huh" -> {uh, huh}, "Mm-hmm." -> {mm, hmm}).
_PAUSE_RE = re.compile(r"\[pause\.\d+\]", re.IGNORECASE)
_SEP_RE = re.compile(r"[^\w]+", re.UNICODE)


def _tokens(text: str) -> list[str]:
    """Lowercase, drop [pause.N] markers, split on non-word runs."""
    stripped = _PAUSE_RE.sub(" ", text)
    return [t for t in _SEP_RE.split(stripped.lower()) if t]


def _build_token_set(phrases: tuple[str, ...]) -> frozenset[str]:
    """Union of normalized single tokens across every configured phrase."""
    tokens: set[str] = set()
    for phrase in phrases:
        tokens.update(_tokens(phrase))
    return frozenset(tokens)


class BackchannelClassifier:
    """Whole-turn backchannel gate. Constructed once per connection with the
    configured phrase list; the token set is precomputed at construction."""

    def __init__(self, phrases: tuple[str, ...]) -> None:
        self._token_set = _build_token_set(phrases)

    def is_backchannel(self, text: str) -> bool:
        """True iff the turn is non-empty AND every token is a backchannel.

        Empty / whitespace-only text returns False — the upstream content gate
        already rejects those, and an empty token list is not "all backchannel".
        """
        if not self._token_set:
            return False
        tokens = _tokens(text)
        if not tokens:
            return False
        return all(t in self._token_set for t in tokens)
