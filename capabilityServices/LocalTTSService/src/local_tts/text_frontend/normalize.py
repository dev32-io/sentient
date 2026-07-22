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

# ASCII Latin letters. Digits, currency symbols, punctuation and CJK
# punctuation are NOT letters and take neither side of ``script_share``'s
# ratio -- see that function's docstring for why this is the correction
# that matters.
_LATIN_RE = re.compile(r"[A-Za-z]")

_SUPPORTED = ("en", "zh", "ja")


def script_share(text: str) -> float:
    """CJK share of the SCRIPT-BEARING letters in ``text``.

    Digits, currency symbols, punctuation and whitespace are script-neutral
    and are excluded from BOTH sides of the ratio -- counting them is what
    made an earlier revision score "这个价格是 $50。" as 0.16 and speak it
    with the English engine.
    """
    cjk = len(_HAN_RE.findall(text)) + len(_KANA_RE.findall(text))
    latin = len(_LATIN_RE.findall(text))
    total = cjk + latin
    return cjk / total if total else 0.0


def detect_lang(text: str, confidence: float) -> str | None:
    """Language of a script-PURE block, or None when genuinely mixed.

    ``confidence`` is ``config.yaml``'s ``text_frontend.script_confidence``,
    threaded in by the caller rather than hardcoded here.
    """
    share = script_share(text)
    if share >= confidence:
        return "ja" if _KANA_RE.search(text) else "zh"
    if share <= 1.0 - confidence:
        return "en"
    return None


def resolve_lang(declared: str, text: str, confidence: float) -> str:
    """Language for ``text``; ``declared`` breaks ties only.

    Content wins whenever content is unambiguous. A declared value (voice
    pack, then config.default_lang) is a STALE prior -- the assistant can
    switch language at any turn -- so it may never override clear evidence,
    only decide a block that is genuinely mixed. Undeclared falls to English.
    """
    detected = detect_lang(text, confidence)
    if detected is not None:
        return detected
    return declared if declared in _SUPPORTED else "en"


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
