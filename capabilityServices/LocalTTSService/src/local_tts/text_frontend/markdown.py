"""Markdown document -> speakable plaintext via mistune's AST.

Runs on a COMPLETE document (buffered at flush/end), not a stream — so
mistune parses reliably (unclosed fences/bold across delta boundaries,
which broke the old TS streaming stripper, can't happen here).

Policy:
  drop   : code blocks, images, math (inline + block), footnote bodies
           and refs, raw HTML, autolinked/bare URLs
  route  : tables -> table.render_table (linearize or summarize)
           inline code -> spans.render_code_span (keep+mask or phrase)
  keep   : link TEXT (url dropped), bold/italic/strike text
  layout : block-level elements separated by a blank line so the synth
           gets a prosodic gap between paragraphs/headings/list items.

Plugin notes (verified against the installed mistune 3.3.x):
  * ``url`` promotes bare "https://..." and <...> autolinks into ``link``
    tokens whose child text IS the url — that text-equals-url signal is
    how ``_render_link`` tells an autolink (drop) from ``[text](url)``.
    It does NOT promote "www.foo.com"; spans.replace_bare_spans handles
    those at the prose level.
  * ``strikethrough`` yields a ``strikethrough`` token (NOT ``del``);
    without it ``~~x~~`` keeps its literal markers.
  * ``task_lists`` yields ``task_list_item`` and strips the [ ]/[x]
    marker; without it the marker is spoken.
  * ``math`` yields ``inline_math`` / ``block_math``; without it "$x^2$"
    is read as "dollar x circumflex two dollar".
  * ``footnotes`` yields ``footnote_ref`` (no children) plus a trailing
    ``footnotes`` block — dropped, or the note bodies get read out.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import mistune

from .mask import MaskTable
from .normalize import resolve_lang
from .phrases import phrase
from .policy import SpeechPolicy
from .spans import render_code_span, replace_bare_spans
from .table import render_table

log = logging.getLogger("local_tts.text_frontend.markdown")

_PARSE = mistune.create_markdown(
    renderer=None,
    plugins=[
        "url",
        "strikethrough",
        "table",
        # The bare `table` plugin only registers into the ROOT block parser.
        # An LLM very often indents a table under a numbered list or inside a
        # quote; without these two it stays literal pipe text and the
        # normalizer reads it as "vertical bar Service vertical bar Port".
        "mistune.plugins.table.table_in_quote",
        "mistune.plugins.table.table_in_list",
        "task_lists",
        "math",
        "footnotes",
    ],
)

# Block token types with no speakable content.
_BLOCK_DROP = frozenset({"block_code", "block_math", "block_html", "thematic_break",
                         "blank_line", "footnotes"})
# Inline token types dropped entirely.
_INLINE_DROP = frozenset({"image", "inline_math", "inline_html", "footnote_ref"})
# Inline breaks: a line-wrap point inside a block, not a word boundary to
# delete — dropping them outright glues adjacent words ("heremore").
_INLINE_SPACE = frozenset({"softbreak", "linebreak"})


@dataclass(frozen=True)
class StrippedDoc:
    """Speakable text plus the mask table protecting its kept spans."""

    text: str
    masks: MaskTable


@dataclass(frozen=True)
class _Ctx:
    policy: SpeechPolicy
    lang: str
    masks: MaskTable


def strip_markdown(doc: str, policy: SpeechPolicy, lang: str, cjk_ratio: float) -> StrippedDoc:
    masks = MaskTable(doc=doc)
    if not doc.strip():
        return StrippedDoc(text="", masks=masks)
    # Resolve ONCE for the whole document -- unlike TN's per-block gate in
    # frontend.py, every phrase() call downstream (dropped-span
    # placeholders, table summaries) needs one concrete language. Without
    # this, a Chinese document under the shipped "auto" default_lang got
    # the raw "auto" tag handed straight to phrase(), which falls back to
    # the English table -- a Chinese reply spoke "a link"/"a command".
    resolved_lang = resolve_lang(lang, doc, cjk_ratio)
    ctx = _Ctx(policy=policy, lang=resolved_lang, masks=masks)
    blocks: list[str] = []
    for tok in _PARSE(doc):
        text = _render_block(tok, ctx)
        if text and text.strip():
            blocks.append(text.strip())
    out = "\n\n".join(blocks)
    log.debug(
        "strip in_len=%d out_len=%d blocks=%d declared_lang=%s resolved_lang=%s",
        len(doc), len(out), len(blocks), lang, resolved_lang,
    )
    return StrippedDoc(text=out, masks=masks)


def _render_block(tok: dict, ctx: _Ctx) -> str:
    ttype = tok.get("type")
    if ttype in _BLOCK_DROP:
        return ""
    if ttype == "table":
        return render_table(tok, lambda ch: _render_children(ch, ctx), ctx.policy, ctx.lang)
    if ttype in ("heading", "paragraph"):
        return _render_children(tok.get("children", []), ctx)
    if ttype == "list":
        items = [_render_block(item, ctx) for item in tok.get("children", [])]
        return "\n\n".join(i.strip() for i in items if i.strip())
    if ttype in ("list_item", "task_list_item", "block_quote"):
        parts = [_render_block(c, ctx) for c in tok.get("children", [])]
        return " ".join(p.strip() for p in parts if p.strip())
    # Unknown block: best-effort read of any children.
    return _render_children(tok.get("children", []), ctx)


def _render_children(children: list, ctx: _Ctx) -> str:
    return "".join(_render_inline(child, ctx) for child in children)


def _render_inline(child: dict, ctx: _Ctx) -> str:
    ctype = child.get("type")
    if ctype == "text":
        return replace_bare_spans(child.get("raw", ""), ctx.policy, ctx.lang)
    if ctype == "codespan":
        return render_code_span(child.get("raw", ""), ctx.policy, ctx.lang, ctx.masks)
    if ctype == "link":
        return _render_link(child, ctx)
    if ctype in _INLINE_SPACE:
        return " "
    if ctype in _INLINE_DROP:
        return ""
    # Every remaining container type (strong, emphasis, strikethrough,
    # block_text, ...) carries `children` — one dispatch rule, no allow-list.
    if "children" in child:
        return _render_children(child.get("children", []), ctx)
    return ""


def _render_link(child: dict, ctx: _Ctx) -> str:
    text = _render_children(child.get("children", []), ctx)
    url = child.get("attrs", {}).get("url", "")
    if url.lower().startswith("mailto:"):
        # Email autolink: child text is the bare address (no "mailto:"
        # prefix), so the text==url signal below never fires for it --
        # without this branch the address gets spoken character by character.
        log.debug("link_dropped kind=email text_len=%d", len(text))
        return phrase(ctx.lang, "email") if ctx.policy.speak_dropped_spans else ""
    if text == url or not text.strip():
        # Autolink / bare URL: visible text IS the url -> speak a phrase
        # (or nothing) instead of leaving a grammatical hole.
        log.debug("link_dropped kind=autolink text_len=%d", len(text))
        return phrase(ctx.lang, "link") if ctx.policy.speak_dropped_spans else ""
    return text
