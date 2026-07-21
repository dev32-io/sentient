"""Text normalization: written form -> spoken form.

Core engine is wetext (WFST, zh+en+ja). A thin regex pre-shim runs
BEFORE wetext to (a) fix wetext's EN numeric-range bug — `5-10 word`
corrupts the following word — by rewriting `N-N` to `N to N`, and
(b) speak a leading negative sign in EN (wetext EN leaves "-5" as
"-five"; zh already says 负).

Ambiguous cases (e.g. "100m" = meters vs millions) are NOT resolved —
wetext picks one reading; that residual is accepted by design.
"""

from __future__ import annotations

import logging
import re

from wetext import Normalizer as WeNormalizer

log = logging.getLogger("local_tts.text_frontend.normalize")

# Digit-hyphen-digit range -> "N to N". Also kills the wetext EN corruption
# where a range immediately followed by a word duplicates the word's tail.
_RANGE_RE = re.compile(r"(\d)\s*-\s*(\d)")
# Leading negative number (EN): "-5" -> "negative 5", when not part of a
# word/range (range already rewritten above).
_NEG_RE = re.compile(r"(?<![\w\d])-(\d)")


def _engine_key(lang: str) -> str:
    """Resolve the lang tag to the wetext engine it will actually use.
    Unsupported/unknown tags (including the shipped default "auto") fall
    back to the "en" engine."""
    return lang if lang in ("en", "zh", "ja") else "en"


class Normalizer:
    def __init__(self) -> None:
        self._cache: dict[str, WeNormalizer] = {}

    def _for(self, lang: str) -> WeNormalizer:
        key = _engine_key(lang)
        if key not in self._cache:
            log.info("build_normalizer lang=%s", key)
            self._cache[key] = WeNormalizer(lang=key, operator="tn")
        return self._cache[key]

    def normalize(self, text: str, lang: str) -> str:
        pre = _RANGE_RE.sub(r"\1 to \2", text)
        if _engine_key(lang) == "en":
            pre = _NEG_RE.sub(r"negative \1", pre)
        out = self._for(lang).normalize(pre)
        log.debug("normalize lang=%s in_len=%d out_len=%d", lang, len(text), len(out))
        return out
