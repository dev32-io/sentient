"""Decide which non-prose spans get spoken, and how.

Text normalization (wetext, NeMo, any WFST engine) is built to give
EVERY symbol a spoken form — NeMo's own docs turn a URL into "HTTPS
colon slash slash WWW dot ...". That is correct for its job and wrong
for ours, so the "should this be spoken at all" judgement has to happen
HERE, above TN.

Two entry points:
  * ``render_code_span``  — a `codespan` AST node (backticked text).
  * ``replace_bare_spans`` — URLs/paths sitting in plain prose text,
    which mistune does not promote to nodes (only ``scheme://`` becomes
    a ``link``; ``www.foo.com`` and ``/Users/x/y`` stay plain text).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from .mask import MaskTable
from .phrases import phrase
from .policy import SpeechPolicy

log = logging.getLogger("local_tts.text_frontend.spans")

# Speakable identifier: alnum runs joined by a single . _ or - and no
# leading separator. Covers flush, config.yaml, v1.2.3, 8080, snake_case.
_WORD_LIKE_RE = re.compile(r"^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$")
_URL_LIKE_RE = re.compile(r"^(?:[a-z][a-z0-9+.-]*://|www\.)", re.IGNORECASE)
# Path-like: starts at root/home, or has 2+ separators anywhere.
_PATH_LIKE_RE = re.compile(r"^(?:~|/|\.{1,2}/|[A-Za-z]:\\)|(?:[^/\s]*/){2,}")

# Prose-level scanners. Both require enough structure that ordinary
# sentences (and "50/50", "and/or") can't match, and both must STOP before
# trailing sentence punctuation -- a URL or path followed directly by a
# period is ordinary English, and swallowing that period costs the
# sentence its prosodic boundary.
_BARE_URL_RE = re.compile(
    r"(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'\"]",
    re.IGNORECASE,
)
_BARE_PATH_RE = re.compile(r"(?<![\w/])(?:~|\.{0,2})/[\w.-]*[\w-](?:/[\w.-]*[\w-])+")
# Bare email address in prose. mistune only promotes the BRACKETED form
# (<a@b.com>) to a mailto link, so an unbracketed address reaches us as
# plain text and would otherwise be spoken character by character.
_BARE_EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


@dataclass(frozen=True)
class SpanVerdict:
    """keep=True -> speak verbatim (masked from TN). keep=False -> phrase."""

    keep: bool
    phrase_key: str


_KEEP = SpanVerdict(keep=True, phrase_key="")


def classify_code_span(raw: str, policy: SpeechPolicy) -> SpanVerdict:
    text = raw.strip()
    if not text:
        return SpanVerdict(keep=False, phrase_key="")
    if _URL_LIKE_RE.search(text):
        return SpanVerdict(keep=False, phrase_key="link")
    if _PATH_LIKE_RE.search(text):
        return SpanVerdict(keep=False, phrase_key="file_path")
    if len(text) > policy.code_span_max_chars or " " in text:
        return SpanVerdict(keep=False, phrase_key="command")
    if _WORD_LIKE_RE.match(text):
        return _KEEP
    return SpanVerdict(keep=False, phrase_key="command")


def render_code_span(raw: str, policy: SpeechPolicy, lang: str, masks: MaskTable) -> str:
    verdict = classify_code_span(raw, policy)
    if verdict.keep:
        return masks.add(raw.strip())
    log.debug("code_span_dropped len=%d phrase=%s", len(raw), verdict.phrase_key or "silent")
    if not verdict.phrase_key or not policy.speak_dropped_spans:
        return ""
    return phrase(lang, verdict.phrase_key)


def replace_bare_spans(text: str, policy: SpeechPolicy, lang: str) -> str:
    """Rewrite bare URLs / paths / emails that mistune left in prose text."""
    email_repl = phrase(lang, "email") if policy.speak_dropped_spans else ""
    url_repl = phrase(lang, "link") if policy.speak_dropped_spans else ""
    path_repl = phrase(lang, "file_path") if policy.speak_dropped_spans else ""
    # Pass replacements as callables, not strings -- re.sub interprets
    # backslash escapes (\1, \g<name>, ...) in string replacements, so a
    # future phrase-catalog entry containing one would break or raise.
    # Email runs first: an address like user@www.example.com contains a
    # "www." that _BARE_URL_RE would otherwise match first, mangling it.
    out, email_subs = _BARE_EMAIL_RE.subn(lambda _match: email_repl, text)
    out, url_subs = _BARE_URL_RE.subn(lambda _match: url_repl, out)
    out, path_subs = _BARE_PATH_RE.subn(lambda _match: path_repl, out)
    log.debug(
        "replace_bare_spans email_subs=%d url_subs=%d path_subs=%d in_len=%d out_len=%d",
        email_subs,
        url_subs,
        path_subs,
        len(text),
        len(out),
    )
    return out
