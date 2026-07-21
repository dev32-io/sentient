"""Composes the text-frontend stages into one process() call."""

from __future__ import annotations

import logging
import re

from .emoji_clean import strip_emoji, strip_pause_tags
from .markdown import strip_markdown
from .normalize import Normalizer

log = logging.getLogger("local_tts.text_frontend.frontend")

# Collapse whitespace artifacts left by stripping (dropped inline nodes,
# removed pause tags) WITHOUT destroying the \n\n paragraph gaps that give
# the synth its prosodic breaks.
_SPACES_AROUND_NL = re.compile(r"[ \t]*\n[ \t]*")
_MULTI_NL = re.compile(r"\n{3,}")
_MULTI_SPACE = re.compile(r"[ \t]{2,}")


def _collapse_whitespace(text: str) -> str:
    text = _SPACES_AROUND_NL.sub("\n", text)   # trim spaces hugging newlines
    text = _MULTI_NL.sub("\n\n", text)          # 3+ newlines -> one paragraph gap
    text = _MULTI_SPACE.sub(" ", text)          # runs of spaces -> single
    return text


class TextFrontend:
    def __init__(self, *, normalizer: Normalizer | None) -> None:
        self._normalizer = normalizer

    def process(self, doc: str, lang: str) -> str:
        text = strip_markdown(doc)
        text = strip_pause_tags(strip_emoji(text))
        if self._normalizer is not None and text.strip():
            text = self._normalize_blocks(text, lang)
        text = _collapse_whitespace(text)
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


def build_frontend(*, normalize_enabled: bool) -> TextFrontend:
    return TextFrontend(normalizer=Normalizer() if normalize_enabled else None)
