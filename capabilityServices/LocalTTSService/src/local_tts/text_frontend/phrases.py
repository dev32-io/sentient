"""Per-language spoken phrases for dropped spans and summarized tables.

These are localization resources, not deployment tunables, so they live
in code next to the logic that uses them (same call as
``languages.py``'s SUPPORTED_LANGUAGES frozenset) rather than in
config.yaml. Numbers are left as DIGITS in ``table_summary`` on purpose:
wetext runs after this and turns "12" into "twelve" (and zh "12" into
"十二"), so we never hand-write number words per language.
"""

from __future__ import annotations

_FALLBACK_LANG = "en"

PHRASES: dict[str, dict[str, str]] = {
    "en": {
        "link": "a link",
        "file_path": "a file path",
        "command": "a command",
        "table_summary": "a table with {rows} rows and {cols} columns",
        "cell_sep": ", ",
        "row_end": ". ",
    },
    "zh": {
        "link": "一个链接",
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
