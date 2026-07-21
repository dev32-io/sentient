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
so the index is encoded in letters only, never digits -- see `_encode` for
the prefix-free base-25 scheme.
"""

from __future__ import annotations

import logging

log = logging.getLogger("local_tts.text_frontend.mask")

# Deliberately unlikely to occur in prose, and letters-only (see docstring).
_PREFIX = "zqxmask"

# 'z' is reserved as the terminator and excluded from the digit alphabet.
_ALPHABET = "abcdefghijklmnopqrstuvwxy"
_TERMINATOR = "z"


def _encode(index: int) -> str:
    """Prefix-free base-25 letter code, terminated by 'z'.

    Because 'z' never appears among the digits, no code can be a prefix of
    another: a shorter code's terminating 'z' would have to align with a
    digit of the longer one, which is impossible. That makes restore()
    order-independent. The previous forced-two-digits-then-grow scheme was
    NOT prefix-free -- index 26 ("ba") is a prefix of index 676 ("baa"),
    and replacing the shorter one first corrupted the longer one's text.
    """
    digits = ""
    n = index
    while True:
        digits = _ALPHABET[n % 25] + digits
        n //= 25
        if n == 0:
            break
    return digits + _TERMINATOR


class MaskTable:
    """Per-document allocator for TN-proof sentinels."""

    def __init__(self) -> None:
        self._spans: dict[str, str] = {}

    def add(self, text: str) -> str:
        sentinel = f"{_PREFIX}{_encode(len(self._spans))}"
        self._spans[sentinel] = text
        log.debug("add sentinel=%s masked_len=%d spans=%d", sentinel, len(text), len(self._spans))
        return sentinel

    def restore(self, text: str) -> str:
        if not self._spans:
            return text
        out = text
        for sentinel, original in self._spans.items():
            out = out.replace(sentinel, original)
        log.debug("restore spans=%d in_len=%d out_len=%d", len(self._spans), len(text), len(out))
        return out
