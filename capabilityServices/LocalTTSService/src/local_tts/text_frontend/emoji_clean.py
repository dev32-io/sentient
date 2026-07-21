"""Emoji removal + defensive pause-tag stripping."""

from __future__ import annotations

import re

import emoji

# Ported from the gateway's stripEdgePauses safety net. Emotion tagging
# (which could emit these) was removed, but a raw LLM reply may still
# contain literal pause-tag text.
_PAUSE_TAG_RE = re.compile(
    r"\[(?:pause|short pause|long pause|停顿|短停顿|长停顿)\]",
    re.IGNORECASE,
)


def strip_emoji(text: str) -> str:
    return emoji.replace_emoji(text, "")


def strip_pause_tags(text: str) -> str:
    return _PAUSE_TAG_RE.sub("", text)
