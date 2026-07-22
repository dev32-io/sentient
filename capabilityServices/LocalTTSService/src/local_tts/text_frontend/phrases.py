"""Per-language spoken phrases for dropped spans and summarized tables.

These are localization resources, not deployment tunables, so they live
in code next to the logic that uses them (same call as
``languages.py``'s SUPPORTED_LANGUAGES frozenset) rather than in
config.yaml. Numbers are left as DIGITS in ``table_summary`` on purpose:
wetext, WHEN IT RUNS, turns "12" into "twelve" (zh "12" into "十二"), so we
never hand-write number words per language -- but note it does NOT always
run: ``config.yaml``'s ``text_frontend.normalize_languages`` gate (see
``frontend.py``) skips English by default (measured to sound better
un-normalized), so an English ``table_summary`` reaches the synth with a
literal digit today. That is a deliberate, measured choice, not a gap in
this module.

Reachability note: ``phrase()`` resolves a single ``lang`` tag per call.
Callers are responsible for resolving a CONCRETE tag before calling it --
``markdown.py``'s ``strip_markdown`` does this once per document via
``normalize.resolve_lang`` (Finding 8's fix), rather than passing
``config.yaml``'s raw ``default_lang`` (which ships as "auto" and is not
a key in ``PHRASES``) straight through. Deriving per-document language
was previously out of scope and every Chinese reply under the shipped
default got English phrases spliced in (e.g. "请运行 flush 命令，参考 a
link。"); that per-document derivation now exists, which is what makes the
``zh`` table below reachable under the shipped "auto" default, not only
when an operator pins ``default_lang: "zh"``.
"""

from __future__ import annotations

_FALLBACK_LANG = "en"

PHRASES: dict[str, dict[str, str]] = {
    "en": {
        "link": "a link",
        "email": "an email address",
        "file_path": "a file path",
        "command": "a command",
        "table_summary": "a table with {rows} rows and {cols} columns",
        "cell_sep": ", ",
        "row_end": ". ",
    },
    "zh": {
        "link": "一个链接",
        "email": "一个邮件地址",
        "file_path": "一个文件路径",
        "command": "一条命令",
        "table_summary": "一张 {rows} 行 {cols} 列的表格",
        "cell_sep": "，",
        "row_end": "。",
    },
}


def phrase(lang: str, key: str) -> str:
    """Spoken phrase for ``key`` in ``lang``; unknown langs fall back to en.

    Raises ``KeyError`` for an unknown ``key`` — a typo must fail loudly
    rather than silently speak an empty string.
    """
    table = PHRASES.get(lang) or PHRASES[_FALLBACK_LANG]
    if key in table:
        return table[key]
    # Known lang, missing key: fall back to en before giving up, so a
    # partially-translated table still speaks something.
    return PHRASES[_FALLBACK_LANG][key]
