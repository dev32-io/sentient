"""Text normalization: written form -> spoken form.

Core engine is wetext (WFST, zh+en+ja). Callers resolve a concrete language
via ``resolve_lang`` before calling ``Normalizer.normalize`` -- wetext keys
its grammar off the declared language, and the shipped ``default_lang``
value is the sentinel "auto", never a language wetext itself understands.

Ambiguous cases (e.g. "100m" = meters vs millions) are NOT resolved --
wetext picks one reading; that residual is accepted by design.

Two EN regex pre-shims (range "N-N" -> "N to N", leading negative "-5" ->
"negative 5") used to run here to patch wetext's English grammar. Both were
deleted: English is no longer normalized by default (language-gated
normalization landed separately), so they were dead code on the default
path, and a ~250-case TTS->STT loop-back measurement showed the range shim
was NEVER the cause of "2026-07-20" being read as "2026 to 07 to 20" -- the
model reads the bare ISO date that way with NO normalization involved. Do
not re-add them on that theory.
"""

from __future__ import annotations

import logging
import re

from wetext import Normalizer as WeNormalizer

log = logging.getLogger("local_tts.text_frontend.normalize")

# Kana implies Japanese; Han without kana implies Chinese.
_KANA_RE = re.compile(r"[぀-ヿ]")
_HAN_RE = re.compile(r"[㐀-鿿豈-﫿]")

_SUPPORTED = ("en", "zh", "ja")


def detect_lang(text: str) -> str:
    """Resolve a language from the script actually present in ``text``."""
    if _KANA_RE.search(text):
        return "ja"
    if _HAN_RE.search(text):
        return "zh"
    return "en"


def resolve_lang(declared: str, text: str) -> str:
    """Concrete language for ``text``; detects when ``declared`` is not one.

    ``default_lang`` ships as "auto". The previous implementation mapped
    anything unrecognized to "en", which meant every Chinese reply was
    normalized by the ENGLISH engine and spoke "fifty dollars" instead of
    "五十美元". Detection is what "auto" was always supposed to mean.
    """
    if declared in _SUPPORTED:
        return declared
    return detect_lang(text)


class Normalizer:
    def __init__(self) -> None:
        self._cache: dict[str, WeNormalizer] = {}

    def _for(self, lang: str) -> WeNormalizer:
        if lang not in self._cache:
            log.info("build_normalizer lang=%s", lang)
            self._cache[lang] = WeNormalizer(lang=lang, operator="tn")
        return self._cache[lang]

    def normalize(self, text: str, lang: str) -> str:
        out = self._for(lang).normalize(text)
        log.debug("normalize lang=%s in_len=%d out_len=%d", lang, len(text), len(out))
        return out
