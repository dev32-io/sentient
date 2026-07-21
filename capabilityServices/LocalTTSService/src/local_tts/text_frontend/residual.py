"""Backstop sweep for markdown-ish punctuation the AST never typed.

L1 routes what mistune gives it a NODE for. Anything else survives as
literal text and reaches the normalizer, whose contract is to give every
symbol a spoken form -- so a stray marker becomes "asterisk", and a
single line of "a | b | c" (a visual separator, NOT a table: mistune
needs a delimiter row to emit a table node) becomes "vertical bar".

This stage runs on prose only, after the markdown strip and before
normalization, and makes that layer fail SAFE. Sentinels are letters-only
so nothing here can disturb a masked span -- which is also why a
backticked `snake_case` keeps its underscores while a prose one does not.
"""

from __future__ import annotations

import logging
import re

log = logging.getLogger("local_tts.text_frontend.residual")

# Terminal punctuation that already supplies the break a pipe would add.
_TERMINAL = ".!?。！？"

# One or more pipe-groups, with the whitespace around and between them --
# "a | | b" must collapse to a SINGLE break, not one per pipe-group.
_PIPE_RUN_RE = re.compile(r"[ \t]*(?:\|+[ \t]*)+")
# Orphaned emphasis / strikethrough markers left by unbalanced markup.
_STRAY_MARKERS_RE = re.compile(r"[*~]+")
# A hash NOT preceded by a letter and NOT followed by a digit -- "#tag"
# goes, while "C#"/"F#" and "issue #42" both survive. The normalizer
# speaks a surviving "#" as "number", which is what a numbered reference
# ("issue number forty two") should sound like.
_STRAY_HASH_RE = re.compile(r"(?<![A-Za-z])#+(?!\d)")
# Underscores joining word characters ("snake_case") -> a word boundary.
_INNER_UNDERSCORE_RE = re.compile(r"(?<=\w)_+(?=\w)")
# Underscores hanging off either end of a word.
_EDGE_UNDERSCORE_RE = re.compile(r"(?<!\w)_+|_+(?!\w)")


def _pipe_to_break(match: re.Match) -> str:
    """A pipe becomes a sentence break -- unless the text already ended in one."""
    text = match.string
    before = text[: match.start()].rstrip()
    if not before:
        return ""
    if before[-1] in _TERMINAL:
        return " "
    return ". "


def sweep_residual_symbols(text: str) -> str:
    out = _PIPE_RUN_RE.sub(_pipe_to_break, text)
    out = _STRAY_MARKERS_RE.sub("", out)
    out = _STRAY_HASH_RE.sub("", out)
    out = _INNER_UNDERSCORE_RE.sub(" ", out)
    out = _EDGE_UNDERSCORE_RE.sub("", out)
    log.debug("residual_swept in_len=%d out_len=%d changed=%s", len(text), len(out), out != text)
    return out
