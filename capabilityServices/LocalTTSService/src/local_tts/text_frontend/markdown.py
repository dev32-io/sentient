"""Markdown document -> speakable plaintext via mistune's AST.

Runs on a COMPLETE document (buffered at flush/end), not a stream — so
mistune parses reliably (unclosed fences/bold across delta boundaries,
which broke the old TS streaming stripper, can't happen here).

Policy (mirrors the retired gateway markdown-stripper renderer):
  drop   : code blocks, images, raw/autolink URLs, math
  keep   : link TEXT (url dropped), inline-code text, bold/italic/strike text
  layout : block-level elements separated by a blank line so the synth
           gets a prosodic gap between paragraphs/headings/list items.

AST note (verified against the installed mistune==3.3.3): the default
parser does NOT autolink a bare "https://..." typed inline in prose — it
stays glued into the surrounding `text` token's `raw` string, so it can't
be dropped structurally. The `url` plugin below promotes bare URLs (and
CommonMark `<...>` autolinks, which are always active) into `link` tokens
whose child text is literally the url. `_render_link` uses that
text-equals-url signal to tell an autolink (drop) from an explicit
`[text](url)` link (keep the text). Likewise `~~struck~~` stays a plain
`text` token (markers and all) unless the `strikethrough` plugin is
enabled; enabling it yields a `strikethrough` token (NOT `del`).
"""

from __future__ import annotations

import logging

import mistune

log = logging.getLogger("local_tts.text_frontend.markdown")

# mistune 3 AST: renderer=None yields a list of block-token dicts.
# `url`: promotes bare "https://..." prose text into `link` tokens (see
# module docstring) so bare URLs can be dropped like other links.
# `strikethrough`: without it, `~~struck~~` stays a literal `text` token
# with the `~~` markers included.
_PARSE = mistune.create_markdown(renderer=None, plugins=["url", "strikethrough"])

# Inline token types dropped entirely (no speakable content).
_INLINE_DROP = frozenset({"image", "inline_math"})
# Inline token types rendered as a single space: these mark a line-wrap
# point inside a block (soft/hard break), not a word boundary removal —
# dropping them outright concatenates adjacent words ("here" + "more" ->
# "heremore").
_INLINE_SPACE = frozenset({"softbreak", "linebreak"})


def strip_markdown(doc: str) -> str:
    if not doc.strip():
        return ""
    tokens = _PARSE(doc)
    blocks: list[str] = []
    for tok in tokens:
        text = _render_block(tok)
        if text and text.strip():
            blocks.append(text.strip())
    out = "\n\n".join(blocks)
    log.debug("strip in_len=%d out_len=%d blocks=%d", len(doc), len(out), len(blocks))
    return out


def _render_block(tok: dict) -> str:
    ttype = tok.get("type")
    if ttype in ("block_code", "block_math", "thematic_break", "blank_line"):
        return ""
    if ttype in ("heading", "paragraph"):
        return _render_children(tok.get("children", []))
    if ttype == "list":
        items = [_render_block(item) for item in tok.get("children", [])]
        return "\n\n".join(i.strip() for i in items if i.strip())
    if ttype in ("list_item", "block_quote"):
        parts = [_render_block(c) for c in tok.get("children", [])]
        return " ".join(p.strip() for p in parts if p.strip())
    # Unknown block: best-effort read of any children.
    return _render_children(tok.get("children", []))


def _render_children(children: list[dict]) -> str:
    return "".join(_render_inline(child) for child in children)


def _render_inline(child: dict) -> str:
    ctype = child.get("type")
    if ctype in ("text", "codespan"):
        return child.get("raw", "")
    if ctype == "link":
        return _render_link(child)
    if ctype in _INLINE_SPACE:
        return " "
    if ctype in _INLINE_DROP:
        return ""
    # Every remaining container type we care about (strong, emphasis,
    # strikethrough, block_text, paragraph, ...) carries `children` —
    # no separate allow-list needed, this is the one dispatch rule.
    if "children" in child:
        return _render_children(child.get("children", []))
    return ""


def _render_link(child: dict) -> str:
    text = _render_children(child.get("children", []))
    url = child.get("attrs", {}).get("url", "")
    if text == url:
        # Bare/autolink URL: visible text IS the url -> drop per policy.
        return ""
    return text
