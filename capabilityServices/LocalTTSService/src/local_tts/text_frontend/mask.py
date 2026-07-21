"""Protect spans from text normalization behind inert sentinel tokens.

wetext's job is to give EVERY token a spoken form, so a span we decided
to keep verbatim (a short identifier, a version, a port number) gets
rewritten if TN can see it. We swap those spans for a sentinel before
TN and swap them back after.

Sentinel shape is load-bearing: it must be pure ASCII letters. Verified
against the installed wetext —
    "__TTS0__"   -> "underscore underscore TTS zero underscore ..."
    "\\ue000..."  -> spaces injected, inner digit normalized
    "TTSTOKZERO" -> unchanged
so the index is encoded in base-26 letters, never digits.
"""

from __future__ import annotations

import logging

log = logging.getLogger("local_tts.text_frontend.mask")

# Deliberately unlikely to occur in prose, and letters-only (see docstring).
_PREFIX = "zqxmask"
_ALPHABET = "abcdefghijklmnopqrstuvwxyz"


def _encode(index: int) -> str:
    """Base-26 letter encoding, fixed two digits minimum ('aa', 'ab', ...)."""
    out = ""
    n = index
    for _ in range(2):
        out = _ALPHABET[n % 26] + out
        n //= 26
    while n:
        out = _ALPHABET[n % 26] + out
        n //= 26
    return out


class MaskTable:
    """Per-document allocator for TN-proof sentinels."""

    def __init__(self) -> None:
        self._spans: dict[str, str] = {}

    def add(self, text: str) -> str:
        sentinel = f"{_PREFIX}{_encode(len(self._spans))}"
        self._spans[sentinel] = text
        return sentinel

    def restore(self, text: str) -> str:
        if not self._spans:
            return text
        out = text
        for sentinel, original in self._spans.items():
            out = out.replace(sentinel, original)
        log.debug("restore spans=%d in_len=%d out_len=%d", len(self._spans), len(text), len(out))
        return out
