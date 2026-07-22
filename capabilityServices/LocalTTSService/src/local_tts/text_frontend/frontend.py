"""Composes the text-frontend stages into one process() call.

Stage order is load-bearing:
  strip markdown (spans masked) -> emoji/pause strip -> normalize (gated
  per language, per block) -> UNMASK -> punctuation cleanup -> whitespace
  collapse
Unmasking before TN would defeat the mask; cleaning punctuation before
unmasking would operate on sentinels instead of the real text.
"""

from __future__ import annotations

import logging
import re

from .emoji_clean import strip_emoji, strip_pause_tags
from .markdown import strip_markdown
from .normalize import Normalizer, resolve_lang
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
    def __init__(
        self,
        *,
        normalizer: Normalizer | None,
        normalize_languages: tuple[str, ...],
        policy: SpeechPolicy,
    ) -> None:
        self._normalizer = normalizer
        self._normalize_languages = tuple(normalize_languages)
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
        # wetext flattens newlines, so each block is normalized separately to
        # preserve the \n\n prosodic gaps. Language is resolved PER BLOCK: a
        # reply can mix scripts, and English measurably sounds better with no
        # normalization at all while Chinese needs it for currency and times.
        out: list[str] = []
        for block in text.split("\n\n"):
            resolved = resolve_lang(lang, block)
            if block.strip() and resolved in self._normalize_languages:
                out.append(self._normalizer.normalize(block, resolved))
            else:
                out.append(block)
        return "\n\n".join(out)


def build_frontend(
    *, normalize_enabled: bool, normalize_languages: tuple[str, ...], policy: SpeechPolicy
) -> TextFrontend:
    return TextFrontend(
        normalizer=Normalizer() if normalize_enabled else None,
        normalize_languages=normalize_languages,
        policy=policy,
    )
