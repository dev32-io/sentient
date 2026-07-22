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
        cjk_ratio: float,
    ) -> None:
        self._normalizer = normalizer
        self._normalize_languages = tuple(normalize_languages)
        self._policy = policy
        self._cjk_ratio = cjk_ratio

    def process(self, doc: str, lang: str) -> str:
        stripped = self._strip(doc, lang)
        text = strip_pause_tags(strip_emoji(stripped.text))
        normalized_blocks = 0
        if self._normalizer is not None and text.strip():
            text, normalized_blocks = self._normalize_blocks(text, lang)
        text = stripped.masks.restore(text)
        text = _collapse_whitespace(_fix_orphan_punctuation(text))
        out = text.strip()
        # Report blocks ACTUALLY normalized, not merely whether a Normalizer
        # exists: with the default ("zh","ja") gate an all-English document
        # normalizes nothing, and a flag would misreport that as normalize=True.
        log.debug("process in_len=%d out_len=%d lang=%s normalized_blocks=%d",
                  len(doc), len(out), lang, normalized_blocks)
        return out

    def _strip(self, doc: str, lang: str):
        """Strip markdown, re-running once if that changes the language verdict.

        The strip picks the language for its spoken phrases ("a link" vs
        "一个链接") -- but the strip is also what REMOVES the URLs and code
        spans that dilute the script ratio. Measuring the raw document can
        therefore disagree with the text the listener actually hears: a
        Chinese sentence containing one long URL scores 0.164 CJK raw and
        0.375 once stripped, so it emitted English phrases mid-Chinese.
        Re-strip only when the verdict actually changed; a concrete declared
        language resolves to itself both times, so the common path parses once.
        """
        stripped = strip_markdown(doc, self._policy, lang, self._cjk_ratio)
        refined = resolve_lang(lang, stripped.text, self._cjk_ratio)
        if refined != resolve_lang(lang, doc, self._cjk_ratio):
            log.debug("relang declared=%s refined=%s", lang, refined)
            stripped = strip_markdown(doc, self._policy, refined, self._cjk_ratio)
        return stripped

    def _normalize_blocks(self, text: str, lang: str) -> tuple[str, int]:
        # wetext flattens newlines, so each block is normalized separately to
        # preserve the \n\n prosodic gaps. Language is resolved PER BLOCK: a
        # reply can mix scripts, and English measurably sounds better with no
        # normalization at all while Chinese needs it for currency and times.
        out: list[str] = []
        normalized = 0
        for index, block in enumerate(text.split("\n\n")):
            if not block.strip():
                out.append(block)
                continue
            resolved = resolve_lang(lang, block, self._cjk_ratio)
            should_normalize = resolved in self._normalize_languages
            log.debug("block_lang idx=%d len=%d declared=%s resolved=%s normalize=%s",
                      index, len(block), lang, resolved, should_normalize)
            if should_normalize:
                out.append(self._normalizer.normalize(block, resolved))
                normalized += 1
            else:
                out.append(block)
        return "\n\n".join(out), normalized


def build_frontend(
    *,
    normalize_enabled: bool,
    normalize_languages: tuple[str, ...],
    policy: SpeechPolicy,
    cjk_ratio: float,
) -> TextFrontend:
    return TextFrontend(
        normalizer=Normalizer() if normalize_enabled else None,
        normalize_languages=normalize_languages,
        policy=policy,
        cjk_ratio=cjk_ratio,
    )
