"""Markdown table -> speech.

Without the mistune ``table`` plugin a GFM table never becomes a node:
it stays literal pipe text and TN reads it as "vertical bar Service
vertical bar Port vertical bar". With the plugin we get a real tree and
can do what a screen reader does — linearize row by row, prefixing each
value with its column header so the listener keeps context.

Size gate: reading a 20-row table aloud is a minute of recitation, so
anything past ``policy.table_max_cells`` body cells collapses to a
one-sentence summary instead.
"""

from __future__ import annotations

import logging
from typing import Callable

from .phrases import phrase
from .policy import SpeechPolicy

log = logging.getLogger("local_tts.text_frontend.table")

RenderCell = Callable[[list], str]


def render_table(tok: dict, render_cell: RenderCell, policy: SpeechPolicy, lang: str) -> str:
    heads, rows = _split(tok, render_cell)
    cols = max(len(heads), max((len(r) for r in rows), default=0))
    cell_count = len(rows) * cols
    has_content = any(any(cell for cell in row) for row in rows)
    if not rows or not has_content or cell_count > policy.table_max_cells:
        log.debug("table_summarized rows=%d cols=%d cells=%d", len(rows), cols, cell_count)
        return phrase(lang, "table_summary").format(rows=len(rows), cols=cols)

    sep = phrase(lang, "cell_sep")
    end = phrase(lang, "row_end")
    log.debug("table_linearized rows=%d cols=%d", len(rows), cols)
    return "".join(f"{sep.join(_pairs(heads, row))}{end}" for row in rows if any(row))


def _split(tok: dict, render_cell: RenderCell) -> tuple[list[str], list[list[str]]]:
    heads: list[str] = []
    rows: list[list[str]] = []
    for section in tok.get("children", []):
        stype = section.get("type")
        if stype == "table_head":
            heads = [render_cell(c.get("children", [])).strip() for c in section.get("children", [])]
        elif stype == "table_body":
            rows = [
                [render_cell(c.get("children", [])).strip() for c in row.get("children", [])]
                for row in section.get("children", [])
            ]
    return heads, rows


def _pairs(heads: list[str], row: list[str]) -> list[str]:
    """One "Header value" chunk per non-empty cell; bare value if headerless."""
    out: list[str] = []
    for index, value in enumerate(row):
        if not value:
            continue
        head = heads[index] if index < len(heads) else ""
        out.append(f"{head} {value}" if head else value)
    return out
