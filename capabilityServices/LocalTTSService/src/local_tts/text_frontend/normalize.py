"""Text normalization: written form -> spoken form.

Core engine is wetext (WFST, zh+en+ja). Callers MUST resolve a concrete
language via ``resolve_lang`` before calling ``Normalizer.normalize``.

Passing "auto" straight through mostly works -- wetext re-detects per call
-- but its own ``get_lang`` has no kana check and returns "en" for
kana-only Japanese, so a Japanese reply would be normalized with the
English grammar. ``detect_lang`` below checks kana first, which is why
resolution belongs to the caller rather than to wetext.

Ambiguous cases (e.g. "100m" = meters vs millions) are NOT resolved --
wetext picks one reading; that residual is accepted by design.

Two EN regex pre-shims used to run here to patch wetext's English grammar:
a leading-negative shim ("-5" -> "negative 5") and a range shim ("N-N" ->
"N to N"). Both were deleted, but their justifications are NOT symmetric --
read carefully before touching either.

``_NEG_RE`` really was dead code on the default path: it was gated
``if _engine_key(lang) == "en"`` in the old pipeline, and the per-language
gate in ``frontend.py`` now stops normalizing English at all, so it never
ran regardless.

``_RANGE_RE`` was NOT gated -- it ran unconditionally, for every language,
including zh/ja, which ARE still normalized under the new gate. Deleting
it measurably changed live Chinese output:
  "5-10 分钟"   before: "五 to 十分钟"        now: "五到十分钟"      (better)
  "60-80%"      before: "六十 to 百分之八十"   now: "六十减百分之八十" (worse --
                                                "减"/minus, a lateral read)
Net audible result across the measured cases was fine-to-better, so this
is not a behavioural blocker, but it IS untested territory -- no test pins
zh/ja range-reading behaviour either way. Do not re-add the shim on the
theory that it was dead code; it wasn't, for zh/ja.

A ~250-case TTS->STT loop-back measurement also showed the range shim
was NEVER the cause of "2026-07-20" being read as "2026 to 07 to 20" -- the
model reads the bare ISO date that way with NO normalization involved. Do
not re-add it on that theory either.
"""

from __future__ import annotations

import logging
import re

from wetext import Normalizer as WeNormalizer

log = logging.getLogger("local_tts.text_frontend.normalize")

# Kana range: Hiragana + Katakana + the katakana phonetic extensions, MINUS
# U+30FB (katakana middle dot) and U+30FC (prolonged sound mark) -- both are
# common in CHINESE text for transliterating foreign names ("史蒂夫・乔布斯"
# = Steve Jobs) and would otherwise force a false "ja" verdict on zh text
# (Finding 7).
_KANA_RE = re.compile(r"[ぁ-ゟァ-ヺヽ-ヿ]")
# Han range. Written as ESCAPES, not literal characters: the correct second
# range is U+F900-FAFF (CJK Compatibility Ideographs), but U+F900's typical
# glyph is visually IDENTICAL to U+8C48 (an ordinary CJK Unified Ideograph)
# in most fonts. A literal U+8C48 typed here by mistake silently widened the
# range to U+8C48-FAFF, which swallows Hangul Syllables (U+AC00-D7A3), Yi,
# Latin Extended-D, and the entire Private Use Area -- Korean text was being
# routed to the Chinese WFST engine and spoken with Chinese number words
# (Finding 1). Escapes make the intended codepoint unambiguous to the next
# reader regardless of what font renders this file.
_HAN_RE = re.compile(r"[㐀-鿿豈-﫿]")

_SUPPORTED = ("en", "zh", "ja")


def _cjk_share(text: str) -> float:
    """Share of ``text``'s non-whitespace characters that are Han or kana."""
    non_ws = [c for c in text if not c.isspace()]
    if not non_ws:
        return 0.0
    cjk = sum(1 for c in non_ws if _HAN_RE.match(c) or _KANA_RE.match(c))
    return cjk / len(non_ws)


def detect_lang(text: str, cjk_ratio: float) -> str:
    """Resolve a language from the script actually present in ``text``.

    CJK (Han+kana) must be at least ``cjk_ratio`` share of the block's
    non-whitespace characters, not merely PRESENT -- one quoted Chinese
    name or word in an otherwise-English sentence must not flip the whole
    block to the Chinese engine (Finding 2). ``cjk_ratio`` is
    ``config.yaml``'s ``text_frontend.cjk_ratio``, threaded in by the
    caller rather than hardcoded here.
    """
    if _cjk_share(text) < cjk_ratio:
        return "en"
    if _KANA_RE.search(text):
        return "ja"
    return "zh"


def resolve_lang(declared: str, text: str, cjk_ratio: float) -> str:
    """Concrete language for ``text``; detects when ``declared`` is not one.

    ``default_lang`` ships as "auto". The previous implementation mapped
    anything unrecognized to "en", which meant every Chinese reply was
    normalized by the ENGLISH engine and spoke "fifty dollars" instead of
    "五十美元". Detection is what "auto" was always supposed to mean.
    """
    if declared in _SUPPORTED:
        return declared
    return detect_lang(text, cjk_ratio)


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
