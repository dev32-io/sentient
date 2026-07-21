"""Composes the text-frontend stages into one process() call.

Stage order is load-bearing:
  strip markdown (spans masked) -> emoji/pause strip -> normalize
  -> UNMASK -> punctuation cleanup -> whitespace collapse
Unmasking before TN would defeat the mask; cleaning punctuation before
unmasking would operate on sentinels instead of the real text.
"""

from __future__ import annotations

import logging
import re

from .emoji_clean import strip_emoji, strip_pause_tags
from .markdown import strip_markdown
from .normalize import Normalizer
from .policy import SpeechPolicy

log = logging.getLogger("local_tts.text_frontend.frontend")

# Collapse whitespace artifacts left by stripping WITHOUT destroying the
# \n\n paragraph gaps that give the synth its prosodic breaks.
_SPACES_AROUND_NL = re.compile(r"[ \t]*\n[ \t]*")
_MULTI_NL = re.compile(r"\n{3,}")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")

# Artifacts of dropping a span mid-sentence: a floating separator, an
# emptied bracket pair, a comma butted against a full stop.
_EMPTY_BRACKETS = re.compile(r"\(\s*\)|\[\s*\]|\{\s*\}")
# Trailing space before punctuation is an artifact of a dropped span --
# EXCEPT before an ellipsis, where the space is the author's and removing
# it changes the written form the synthesizer sees.
_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+(?=[,.;:!?，。；：！？](?![.。]))")
# A dropped span can strand a separator against the next punctuation mark
# (", ." / ", ,"). Delete the stranded separator, but NEVER when what
# follows is an ellipsis -- "Wait, ... what?" is ordinary prose and the
# ellipsis carries a real prosodic pause.
_REPEATED_PUNCT = re.compile(r"[,;:，；：][ \t]*(?=[.,;:。，；：!！?？](?![.。]))")


def _fix_orphan_punctuation(text: str) -> str:
    text = _EMPTY_BRACKETS.sub("", text)
    text = _REPEATED_PUNCT.sub("", text)
    text = _SPACE_BEFORE_PUNCT.sub("", text)
    return text


def _collapse_whitespace(text: str) -> str:
    text = _SPACES_AROUND_NL.sub("\n", text)   # trim spaces hugging newlines
    text = _MULTI_NL.sub("\n\n", text)          # 3+ newlines -> one paragraph gap
    text = _MULTI_SPACE.sub(" ", text)          # runs of spaces -> single
    return text


class TextFrontend:
    def __init__(self, *, normalizer: Normalizer | None, policy: SpeechPolicy) -> None:
        self._normalizer = normalizer
        self._policy = policy

    def process(self, doc: str, lang: str) -> str:
        stripped = strip_markdown(doc, self._policy, lang)
        text = strip_pause_tags(strip_emoji(stripped.text))
        if self._normalizer is not None and text.strip():
            text = self._normalize_blocks(text, lang)
        text = stripped.masks.restore(text)
        text = _collapse_whitespace(_fix_orphan_punctuation(text))
        out = text.strip()
        log.debug("process in_len=%d out_len=%d lang=%s normalize=%s",
                  len(doc), len(out), lang, self._normalizer is not None)
        return out

    def _normalize_blocks(self, text: str, lang: str) -> str:
        # wetext flattens newlines, so normalizing the whole document glues
        # paragraph blocks together and destroys the \n\n prosodic gaps that
        # strip_markdown emits. Normalize each block independently and
        # rejoin with \n\n to preserve them.
        blocks = text.split("\n\n")
        out = [
            self._normalizer.normalize(b, lang) if b.strip() else b
            for b in blocks
        ]
        return "\n\n".join(out)


def build_frontend(*, normalize_enabled: bool, policy: SpeechPolicy) -> TextFrontend:
    return TextFrontend(
        normalizer=Normalizer() if normalize_enabled else None,
        policy=policy,
    )
