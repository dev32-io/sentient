# TTS Text-Frontend Robustness (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LocalTTSService`'s text frontend produce speakable audio from real LLM markdown — tables, inline code, URLs, file paths, math, task lists and footnotes currently reach the synthesizer as symbol soup ("vertical bar Service vertical bar Port", "at circumflex two zero point one", "slash Users slash kev slash…").

**Architecture:** Three layers, strictly ordered. **L1 structure** — the mistune AST gains the `table`, `task_lists`, `math` and `footnotes` plugins so those constructs become typed nodes we can route instead of literal punctuation; tables are size-gated and linearized screen-reader style, math/footnotes/HTML are dropped. **L2 span policy** — inline-code spans and bare URLs/paths in prose are *classified* into keep-vs-drop; dropped ones become a short spoken phrase ("a command", "a file path", "a link") so the sentence keeps its grammar, kept ones are *masked* behind an alphabetic sentinel so text normalization cannot mangle them. **L3 normalization** — the existing wetext WFST pass, now only ever seeing prose. Nothing about streaming, latency or the wire protocol changes: the frontend still runs once per cycle on the buffered document at `flush`.

**Tech Stack:** Python 3.11, `mistune>=3.3,<4` (markdown AST + plugins), `wetext>=0.1` (WFST TN), `emoji>=2.14,<3`. Deploy tooling: `ruamel.yaml`. No new dependencies.

## Global Constraints

- Service files MUST stay under 300 lines; functions under 40 lines; max nesting depth 3.
- Every tunable lives in `config/config.example.yaml`, parsed by `config.py` into a frozen dataclass, **every key REQUIRED** (fail-loud, no silent defaults) — mirror the existing `_require` / `_require_section` pattern exactly.
- Logging: `logging.getLogger("local_tts.<module>")`. Log **lengths / counts / kinds only** — NEVER text content (`text_len=`, `kind=`, never `text=`).
- Synthesis granularity is UNCHANGED. The frontend runs once per cycle on the buffered document. No per-sentence synthesis, no wire-protocol change, no gateway change.
- New Python deps go in BOTH `pyproject.toml` AND `requirements.txt`. **This plan adds none.**
- Sentinel tokens used for TN masking MUST be **ASCII letters only** — no digits, no underscores, no private-use codepoints. Verified against the installed wetext: `__TTS0__` → "underscore underscore TTS zero…", `` → spaced + digit-normalized, `TTSTOKZERO` → unchanged. This is a hard constraint, not a preference.
- Language handling: `default_lang` may be the shipped value `"auto"`. Every language lookup falls back to `en` for anything that is not an exact key match — same rule as `normalize._engine_key`.
- No e2e audio verification in this plan (audio cannot be validated by the agent). Verification is: service unit suite + gateway CI + a real chat reply through the local stack with the service log trail confirming the frontend ran.

---

## File Structure

**New (`capabilityServices/LocalTTSService/src/local_tts/text_frontend/`):**
- `policy.py` — `SpeechPolicy` frozen dataclass (the three new tunables). No logic.
- `phrases.py` — per-language spoken phrases + separators for dropped spans and table summaries; `phrase(lang, key)` with `en` fallback.
- `spans.py` — L2 classification: `classify_code_span()` for `` `codespan` `` nodes, `replace_bare_spans()` for URLs/paths that appear in plain prose text.
- `mask.py` — `MaskTable`: allocate alphabetic sentinels, restore after TN.
- `table.py` — `render_table()`: size-gated linearizer / summarizer.

**Modified (service):**
- `text_frontend/markdown.py` — enable 4 plugins, drop `footnotes`, thread a render context, delegate codespans/tables to L2/L1 helpers, return `StrippedDoc`.
- `text_frontend/frontend.py` — accept `SpeechPolicy`, unmask after TN, add orphan-punctuation cleanup.
- `text_frontend/__init__.py` — export `SpeechPolicy`.
- `config.py` — three new required keys under `text_frontend`.
- `config/config.example.yaml` — same three keys, each with an inline comment.
- `server.py:85-88` — build `SpeechPolicy` from config, pass to `build_frontend`.
- `pyproject.toml` — version `1.1.0` → `1.2.0`.
- Tests: `tests/test_markdown_strip.py`, `tests/test_frontend.py`, `tests/test_config.py` updated; `tests/test_spans.py`, `tests/test_mask.py`, `tests/test_table.py` added.

**Modified (deploy):**
- `deploy/mac-prod/native/service-config-reconcile.py` — recurse additively into nested mappings. Without this, the three new **nested** keys never reach an already-seeded prod config and local-tts crashes on boot with `ConfigError` (the exact failure this script was written for, one level deeper).

**Untouched:** the whole `gateway/` tree, the wire protocol, `synthesis.py`, `connection_session.py`.

---

## Task 1: Policy + phrases foundations

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/policy.py`
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/phrases.py`
- Test: `capabilityServices/LocalTTSService/tests/test_phrases.py`

**Interfaces:**
- Produces: `SpeechPolicy(table_max_cells: int, code_span_max_chars: int, speak_dropped_spans: bool)` — frozen dataclass, all fields required positionally-or-by-keyword.
- Produces: `phrase(lang: str, key: str) -> str`. Valid keys: `link`, `file_path`, `command`, `email`, `table_summary`, `cell_sep`, `row_end`. `table_summary` is a `str.format` template taking `rows=` and `cols=`. Unknown `lang` falls back to `en`. Unknown `key` raises `KeyError` (fail loud — a typo'd key must not silently speak nothing).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_phrases.py
import pytest

from local_tts.text_frontend.phrases import phrase
from local_tts.text_frontend.policy import SpeechPolicy


def test_policy_is_frozen():
    p = SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)
    assert p.table_max_cells == 24
    with pytest.raises(Exception):
        p.table_max_cells = 1  # frozen dataclass


def test_english_phrases():
    assert phrase("en", "command") == "a command"
    assert phrase("en", "file_path") == "a file path"
    assert phrase("en", "link") == "a link"


def test_chinese_phrases_differ():
    assert phrase("zh", "command") != phrase("en", "command")
    assert phrase("zh", "cell_sep") == "，"


def test_unknown_lang_falls_back_to_english():
    # "auto" is the shipped default_lang value.
    assert phrase("auto", "command") == phrase("en", "command")
    assert phrase("ko", "link") == phrase("en", "link")


def test_table_summary_is_a_format_template():
    out = phrase("en", "table_summary").format(rows=12, cols=6)
    assert "12" in out and "6" in out


def test_unknown_key_raises():
    with pytest.raises(KeyError):
        phrase("en", "not_a_key")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_phrases.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_tts.text_frontend.policy'`

- [ ] **Step 3: Implement `policy.py`**

```python
# src/local_tts/text_frontend/policy.py
"""Tunables that decide WHAT the text frontend speaks.

Separate from ``config.py`` on purpose: ``config.py`` owns "what does
config.yaml contain", this owns "what does the speech policy need". The
server builds one of these at startup and hands it to the frontend, so
every stage below reads the same immutable policy object instead of
reaching back into global config.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SpeechPolicy:
    """Immutable speech-shaping policy for one process."""

    # Tables with MORE than this many body cells (rows x columns) are
    # summarized ("a table with N rows and M columns") instead of read.
    table_max_cells: int
    # Inline-code spans longer than this are treated as non-prose and
    # replaced by a phrase rather than spoken verbatim.
    code_span_max_chars: int
    # When a span is dropped, speak a short placeholder phrase ("a
    # command") instead of leaving a hole in the sentence.
    speak_dropped_spans: bool
```

- [ ] **Step 4: Implement `phrases.py`**

```python
# src/local_tts/text_frontend/phrases.py
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
        "email": "an email address",
        "table_summary": "a table with {rows} rows and {cols} columns",
        "cell_sep": ", ",
        "row_end": ". ",
    },
    "zh": {
        "link": "一个链接",
        "file_path": "一个文件路径",
        "command": "一条命令",
        "email": "一个邮件地址",
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_phrases.py -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/policy.py \
        capabilityServices/LocalTTSService/src/local_tts/text_frontend/phrases.py \
        capabilityServices/LocalTTSService/tests/test_phrases.py
git commit -m "feat(local-tts): add speech policy + per-language phrase table"
```

---

## Task 2: TN mask table (alphabetic sentinels)

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/mask.py`
- Test: `capabilityServices/LocalTTSService/tests/test_mask.py`

**Interfaces:**
- Produces: `MaskTable` with `add(text: str) -> str` (returns the sentinel that replaces `text`) and `restore(text: str) -> str` (substitutes every allocated sentinel back). `MaskTable()` takes no arguments; one instance per document.

**Why:** wetext normalizes *everything* it sees. A kept inline-code span like `` `v1.2.3` `` or `` `8080` `` would be rewritten ("one point two point three", "eight thousand and eighty"). Masking replaces it with an inert token for the duration of the TN pass. The sentinel alphabet is letters-only because that is the only form verified to survive wetext untouched (see Global Constraints).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_mask.py
from wetext import Normalizer

from local_tts.text_frontend.mask import MaskTable


def test_add_returns_distinct_sentinels():
    m = MaskTable()
    a = m.add("v1.2.3")
    b = m.add("8080")
    assert a != b


def test_restore_round_trips():
    m = MaskTable()
    s = m.add("--save-dev")
    assert m.restore(f"run {s} now") == "run --save-dev now"


def test_restore_is_noop_without_sentinels():
    assert MaskTable().restore("plain text") == "plain text"


def test_sentinels_are_letters_only():
    m = MaskTable()
    for i in range(60):  # forces the second base-26 digit
        assert m.add(f"x{i}").isalpha()


def test_sentinels_survive_wetext_normalization():
    # THE reason this module exists: any sentinel shape containing digits
    # or underscores gets verbalized by wetext and the restore misses.
    m = MaskTable()
    sentinels = [m.add(f"tok{i}") for i in range(30)]
    text = " and ".join(sentinels)
    out = Normalizer(lang="en", operator="tn").normalize(text)
    for s in sentinels:
        assert s in out, f"sentinel {s} did not survive TN"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_mask.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_tts.text_frontend.mask'`

- [ ] **Step 3: Implement**

```python
# src/local_tts/text_frontend/mask.py
"""Protect spans from text normalization behind inert sentinel tokens.

wetext's job is to give EVERY token a spoken form, so a span we decided
to keep verbatim (a short identifier, a version, a port number) gets
rewritten if TN can see it. We swap those spans for a sentinel before
TN and swap them back after.

Sentinel shape is load-bearing: it must be pure ASCII letters. Verified
against the installed wetext —
    "__TTS0__"   -> "underscore underscore TTS zero underscore ..."
    "\\ue000..."  -> spaces injected, inner digit normalized
    "TTSTOKZERO" -> unchanged
so the index is encoded in base-26 letters, never digits.
"""

from __future__ import annotations

import logging

log = logging.getLogger("local_tts.text_frontend.mask")

# Deliberately unlikely to occur in prose, and letters-only (see docstring).
_PREFIX = "zqxmask"
# 'z' is reserved as the terminator and excluded from the digit alphabet.
_ALPHABET = "abcdefghijklmnopqrstuvwxy"
_TERMINATOR = "z"


def _encode(index: int) -> str:
    """Prefix-free base-25 letter code, terminated by 'z'.

    Because 'z' never appears among the digits, no code can be a prefix of
    another: a shorter code's terminating 'z' would have to align with a
    digit of the longer one, which is impossible. That makes restore()
    order-independent. A plain base-26 code is NOT prefix-free — index 26
    ("ba") prefixes index 676 ("baa"), and replacing the shorter sentinel
    first corrupts the longer one's span.
    """
    digits = ""
    n = index
    while True:
        digits = _ALPHABET[n % 25] + digits
        n //= 25
        if n == 0:
            break
    return digits + _TERMINATOR


class MaskTable:
    """Per-document allocator for TN-proof sentinels."""

    def __init__(self) -> None:
        self._spans: dict[str, str] = {}

    def add(self, text: str) -> str:
        sentinel = f"{_PREFIX}{_encode(len(self._spans))}"
        self._spans[sentinel] = text
        log.debug("add sentinel=%s text_len=%d spans=%d", sentinel, len(text), len(self._spans))
        return sentinel

    def restore(self, text: str) -> str:
        if not self._spans:
            return text
        out = text
        for sentinel, original in self._spans.items():
            out = out.replace(sentinel, original)
        log.debug("restore spans=%d in_len=%d out_len=%d", len(self._spans), len(text), len(out))
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_mask.py -v`
Expected: PASS (5 tests). If `test_sentinels_survive_wetext_normalization` fails, the prefix collided with a wetext rule — change `_PREFIX` to another letters-only string and re-run; do NOT introduce digits.

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/mask.py \
        capabilityServices/LocalTTSService/tests/test_mask.py
git commit -m "feat(local-tts): add TN-proof span mask table"
```

---

## Task 3: Span classification (inline code, bare URLs, paths)

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/spans.py`
- Test: `capabilityServices/LocalTTSService/tests/test_spans.py`

**Interfaces:**
- Consumes: `SpeechPolicy` (Task 1), `phrase` (Task 1), `MaskTable` (Task 2).
- Produces:
  - `SpanVerdict(keep: bool, phrase_key: str)` — frozen dataclass. `keep=True` means "speak it verbatim, masked from TN"; `keep=False` means "replace with `phrase(lang, phrase_key)`", or with `""` when `phrase_key` is empty.
  - `classify_code_span(raw: str, policy: SpeechPolicy) -> SpanVerdict`
  - `render_code_span(raw: str, policy: SpeechPolicy, lang: str, masks: MaskTable) -> str` — applies the verdict, masking kept spans.
  - `replace_bare_spans(text: str, policy: SpeechPolicy, lang: str) -> str` — rewrites bare URLs and absolute file paths found in **plain prose** (mistune leaves `www.example.com` and `/Users/x/y/z.ts` inside plain `text` tokens; only `scheme://` gets promoted to a `link` node).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_spans.py
import pytest

from local_tts.text_frontend.mask import MaskTable
from local_tts.text_frontend.policy import SpeechPolicy
from local_tts.text_frontend.spans import (
    classify_code_span,
    render_code_span,
    replace_bare_spans,
)


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


@pytest.mark.parametrize("raw", ["flush", "config.yaml", "v1.2.3", "8080", "snake_case_name"])
def test_word_like_spans_are_kept(raw, policy):
    assert classify_code_span(raw, policy).keep is True


@pytest.mark.parametrize(
    ("raw", "expected_key"),
    [
        ("npm install --save-dev @types/node", "command"),
        ("--save-dev", "command"),
        ("/Users/kev/dev/sentient/gateway/src/a.ts", "file_path"),
        ("~/.sentient/gateway/config.yaml", "file_path"),
        ("https://example.com/a?b=1", "link"),
        ("www.example.com", "link"),
    ],
)
def test_non_prose_spans_are_dropped_with_the_right_phrase(raw, expected_key, policy):
    verdict = classify_code_span(raw, policy)
    assert verdict.keep is False
    assert verdict.phrase_key == expected_key


def test_over_length_span_is_dropped(policy):
    long_word = "a" * (policy.code_span_max_chars + 1)
    assert classify_code_span(long_word, policy).keep is False


def test_render_kept_span_is_masked(policy):
    masks = MaskTable()
    out = render_code_span("v1.2.3", policy, "en", masks)
    assert "v1.2.3" not in out          # masked for the TN pass
    assert masks.restore(out) == "v1.2.3"


def test_render_dropped_span_speaks_a_phrase(policy):
    out = render_code_span("npm i --save-dev x", policy, "en", MaskTable())
    assert out == "a command"


def test_render_dropped_span_is_silent_when_disabled():
    quiet = SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=False)
    assert render_code_span("npm i --save-dev x", quiet, "en", MaskTable()) == ""


def test_replace_bare_url_in_prose(policy):
    out = replace_bare_spans("Also www.example.com here.", policy, "en")
    assert "www" not in out
    assert "a link" in out


def test_replace_bare_path_in_prose(policy):
    out = replace_bare_spans("Path: /Users/kev/dev/a.ts done.", policy, "en")
    assert "/Users" not in out
    assert "a file path" in out


def test_replace_bare_spans_leaves_prose_alone(policy):
    s = "The weather is nice today, e.g. sunny."
    assert replace_bare_spans(s, policy, "en") == s


def test_replace_bare_spans_does_not_eat_simple_division(policy):
    # A single slash between words is prose, not a path.
    s = "a 50/50 split and and/or logic"
    assert replace_bare_spans(s, policy, "en") == s
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_spans.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_tts.text_frontend.spans'`

- [ ] **Step 3: Implement**

```python
# src/local_tts/text_frontend/spans.py
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
# period is ordinary English, and swallowing that period costs the sentence
# its prosodic boundary. Hence the mandatory non-punctuation final char.
_BARE_URL_RE = re.compile(
    r"(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'\"]",
    re.IGNORECASE,
)
# Segment is `[\w.-]*[\w-]`: dots allowed INSIDE a segment but never at its
# end, so "~/.sentient/gateway/config.yaml" still matches while a trailing
# "." stays outside the match.
_BARE_PATH_RE = re.compile(r"(?<![\w/])(?:~|\.{0,2})/[\w.-]*[\w-](?:/[\w.-]*[\w-])+")


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
    """Rewrite bare URLs / absolute paths that mistune left in prose text."""
    url_repl = phrase(lang, "link") if policy.speak_dropped_spans else ""
    path_repl = phrase(lang, "file_path") if policy.speak_dropped_spans else ""
    # Callables, not replacement STRINGS: re.sub interprets backslash escapes
    # in a string replacement, so a future phrase containing one would break.
    out, url_subs = _BARE_URL_RE.subn(lambda _match: url_repl, text)
    out, path_subs = _BARE_PATH_RE.subn(lambda _match: path_repl, out)
    log.debug("bare_spans url_subs=%d path_subs=%d in_len=%d out_len=%d",
              url_subs, path_subs, len(text), len(out))
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_spans.py -v`
Expected: PASS (17 parametrized cases). If `test_replace_bare_spans_does_not_eat_simple_division` fails, `_BARE_PATH_RE` is too greedy — it requires at least two `/`-joined segments AFTER a leading `/`, `./` or `~/`; tighten rather than loosen the surrounding lookbehind.

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/spans.py \
        capabilityServices/LocalTTSService/tests/test_spans.py
git commit -m "feat(local-tts): classify inline-code, bare URL and path spans for speech"
```

---

## Task 4: Size-gated table linearizer

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/table.py`
- Test: `capabilityServices/LocalTTSService/tests/test_table.py`

**Interfaces:**
- Consumes: `SpeechPolicy`, `phrase` (Task 1).
- Produces: `render_table(tok: dict, render_cell: Callable[[list[dict]], str], policy: SpeechPolicy, lang: str) -> str`.
  `tok` is a mistune `table` token. `render_cell` renders one cell's `children` list to a string — injected by the caller so cell contents go through the SAME inline renderer (a cell can hold a codespan, and it must obey the span policy). Returns one speakable block.

**AST shape (verified against installed mistune 3.3.x):**
```
table -> children: [ table_head -> [table_cell...], table_body -> [table_row -> [table_cell...]] ]
table_cell: {"type":"table_cell", "attrs":{"align":..., "head":bool}, "children":[...]}
```

- [ ] **Step 1: Write the failing test**

```python
# tests/test_table.py
import mistune
import pytest

from local_tts.text_frontend.policy import SpeechPolicy
from local_tts.text_frontend.table import render_table

_PARSE = mistune.create_markdown(renderer=None, plugins=["table"])


def _first_table(doc):
    return [t for t in _PARSE(doc) if t["type"] == "table"][0]


def _plain_cell(children):
    return "".join(c.get("raw", "") for c in children)


SMALL = "| Service | Port |\n|---|---|\n| gateway | 8080 |\n| tts | 8888 |\n"


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def test_small_table_is_linearized_with_header_prefixes(policy):
    out = render_table(_first_table(SMALL), _plain_cell, policy, "en")
    assert "Service gateway, Port 8080." in out
    assert "Service tts, Port 8888." in out
    assert "|" not in out


def test_large_table_is_summarized(policy):
    rows = "\n".join(f"| r{i} | v{i} |" for i in range(20))
    doc = f"| A | B |\n|---|---|\n{rows}\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert "20" in out and "2" in out
    assert "r0" not in out


def test_zh_uses_chinese_separators(policy):
    out = render_table(_first_table(SMALL), _plain_cell, policy, "zh")
    assert "，" in out
    assert ", " not in out


def test_cells_go_through_the_injected_renderer(policy):
    doc = "| A |\n|---|\n| x |\n"
    out = render_table(_first_table(doc), lambda ch: "RENDERED", policy, "en")
    assert "RENDERED" in out


def test_empty_body_summarizes_rather_than_emitting_junk(policy):
    doc = "| A | B |\n|---|---|\n"
    out = render_table(_first_table(doc), _plain_cell, policy, "en")
    assert "|" not in out
    assert out.strip() != ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_table.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_tts.text_frontend.table'`

- [ ] **Step 3: Implement**

```python
# src/local_tts/text_frontend/table.py
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
    # A body that renders entirely blank (valid GFM "|   |   |", or a row whose
    # only content is images the inline renderer drops) must NOT fall through
    # to the join below — that returned "" and silently vanished the table,
    # breaking the two-outcome contract. Route it to the summary instead.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_table.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/table.py \
        capabilityServices/LocalTTSService/tests/test_table.py
git commit -m "feat(local-tts): linearize small tables, summarize large ones"
```

---

## Task 5: Markdown layer — plugins, render context, delegation

**Files:**
- Modify: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/markdown.py` (whole file)
- Modify: `capabilityServices/LocalTTSService/tests/test_markdown_strip.py` (whole file — the `strip_markdown` signature changes)

**Interfaces:**
- Consumes: `SpeechPolicy`, `phrase` (Task 1), `MaskTable` (Task 2), `render_code_span` / `replace_bare_spans` (Task 3), `render_table` (Task 4).
- Produces: `StrippedDoc(text: str, masks: MaskTable)` frozen dataclass, and `strip_markdown(doc: str, policy: SpeechPolicy, lang: str) -> StrippedDoc`. **Breaking signature change** — the old one-arg form is gone; Task 6 updates the only caller.

**Plugin AST facts (verified against installed mistune 3.3.x — do not re-derive):**
- `table` → `table` / `table_head` / `table_body` / `table_row` / `table_cell`.
- `task_lists` → list items become `task_list_item` with `attrs.checked`; the `[ ]` / `[x]` marker is removed from the text. Without the plugin the marker is spoken.
- `math` → `inline_math` (inline) and `block_math` (fenced `$$`), both carrying `raw`.
- `footnotes` → `footnote_ref` inline (no children) and a trailing `footnotes` block holding `footnote_item`s. The block MUST be dropped or the note bodies get read out at the end of the reply.
- `block_html` / `inline_html` carry `raw` and no `children`, so they fall through to "" already.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_markdown_strip.py
import pytest

from local_tts.text_frontend.markdown import strip_markdown
from local_tts.text_frontend.policy import SpeechPolicy


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def _text(doc, policy, lang="en"):
    return strip_markdown(doc, policy, lang).text


def test_drops_code_block_keeps_prose(policy):
    out = _text("Here is code:\n\n```py\nprint(1)\n```\n\nDone.", policy)
    assert "print" not in out
    assert "Here is code:" in out and "Done." in out


def test_keeps_link_text_drops_url(policy):
    out = _text("See [the docs](https://example.com/x) now.", policy)
    assert "the docs" in out
    assert "example.com" not in out


def test_heading_and_list_become_separated_blocks(policy):
    out = _text("# Title\n\n- one\n- two", policy)
    assert "Title" in out and "one" in out and "two" in out
    assert "\n\n" in out


def test_drops_images(policy):
    out = _text("Look ![alt](a.png) here.", policy)
    assert "a.png" not in out
    assert "Look" in out and "here" in out


def test_empty_document_returns_empty(policy):
    assert _text("", policy) == ""
    assert _text("```\nonly code\n```", policy).strip() == ""


# --- v2 behaviours ---------------------------------------------------------

def test_table_is_linearized_not_piped(policy):
    doc = "| Service | Port |\n|---|---|\n| gateway | 8080 |\n"
    out = _text(doc, policy)
    assert "|" not in out
    assert "Service gateway" in out and "Port 8080" in out


def test_task_list_markers_are_not_spoken(policy):
    out = _text("- [ ] undone\n- [x] done\n", policy)
    assert "[" not in out and "]" not in out
    assert "undone" in out and "done" in out


def test_math_is_dropped(policy):
    out = _text("Math $x^2$ here.\n\n$$\na=b\n$$\n", policy)
    assert "^" not in out and "$" not in out
    assert "Math" in out and "here." in out


def test_footnote_body_is_not_spoken(policy):
    out = _text("Text[^1]\n\n[^1]: secret note body\n", policy)
    assert "secret note body" not in out
    assert "Text" in out


def test_symbol_heavy_inline_code_becomes_a_phrase(policy):
    out = _text("Install with `npm i --save-dev @types/node` now.", policy)
    assert "--save-dev" not in out
    assert "a command" in out


def test_word_like_inline_code_is_kept_but_masked(policy):
    result = strip_markdown("Then call `flush` on it.", policy, "en")
    assert "flush" not in result.text          # masked until after TN
    assert "flush" in result.masks.restore(result.text)


def test_bare_url_in_prose_becomes_a_phrase(policy):
    out = _text("Also www.example.com here.", policy)
    assert "www" not in out
    assert "a link" in out


def test_html_is_dropped(policy):
    out = _text("<div>hidden</div>\n\nInline <b>bold</b> text.\n", policy)
    assert "hidden" not in out and "<b>" not in out
    assert "bold" in out and "text." in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_markdown_strip.py -v`
Expected: FAIL — `strip_markdown() takes 1 positional argument but 3 were given`.

- [ ] **Step 3: Rewrite `markdown.py`**

```python
# src/local_tts/text_frontend/markdown.py
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
from .phrases import phrase
from .policy import SpeechPolicy
from .spans import render_code_span, replace_bare_spans
from .table import render_table

log = logging.getLogger("local_tts.text_frontend.markdown")

_PARSE = mistune.create_markdown(
    renderer=None,
    plugins=["url", "strikethrough", "table", "task_lists", "math", "footnotes"],
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


def strip_markdown(doc: str, policy: SpeechPolicy, lang: str) -> StrippedDoc:
    masks = MaskTable()
    if not doc.strip():
        return StrippedDoc(text="", masks=masks)
    ctx = _Ctx(policy=policy, lang=lang, masks=masks)
    blocks: list[str] = []
    for tok in _PARSE(doc):
        text = _render_block(tok, ctx)
        if text and text.strip():
            blocks.append(text.strip())
    out = "\n\n".join(blocks)
    log.debug("strip in_len=%d out_len=%d blocks=%d", len(doc), len(out), len(blocks))
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
```

> Note on `_render_link`: `replace_bare_spans` already substituted the phrase inside plain `text` tokens, so when mistune's `url` plugin promoted the URL to a `link` node the child text arrives here **already rewritten** — meaning `text == url` will be False and the phrase would be emitted twice. Guard against that in Step 4's verification: if `test_bare_url_in_prose_becomes_a_phrase` shows a doubled phrase, move the `replace_bare_spans` call so it runs on `text` tokens ONLY (it already does) and confirm the autolink path returns the phrase exactly once by asserting `out.count("a link") == 1`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_markdown_strip.py -v`
Expected: PASS (13 tests). Then add and run this guard for the doubled-phrase risk called out above:

```python
def test_autolink_speaks_the_phrase_exactly_once(policy):
    out = _text("See <https://example.com/x> now.", policy)
    assert out.count("a link") == 1
```

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/markdown.py \
        capabilityServices/LocalTTSService/tests/test_markdown_strip.py
git commit -m "feat(local-tts): route tables, code spans, math and footnotes in the markdown layer"
```

---

## Task 6: Frontend composition — unmask + punctuation cleanup

**Files:**
- Modify: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/frontend.py`
- Modify: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/__init__.py`
- Modify: `capabilityServices/LocalTTSService/tests/test_frontend.py`

**Interfaces:**
- Consumes: `strip_markdown` / `StrippedDoc` (Task 5), `SpeechPolicy` (Task 1), existing `strip_emoji` / `strip_pause_tags` / `Normalizer`.
- Produces: `build_frontend(*, normalize_enabled: bool, policy: SpeechPolicy) -> TextFrontend` — **keyword-only, `policy` is required**. `TextFrontend.process(doc: str, lang: str) -> str` is unchanged in signature.
- `text_frontend/__init__.py` exports `TextFrontend`, `build_frontend`, `SpeechPolicy`.

**Order matters:** strip → emoji/pause → **TN (masked)** → **unmask** → punctuation cleanup → whitespace collapse. Unmasking before TN would defeat the mask; cleaning punctuation before unmasking would run on sentinels instead of real text.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_frontend.py
import pytest

from local_tts.text_frontend import SpeechPolicy, build_frontend


@pytest.fixture
def policy():
    return SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)


def test_end_to_end_markdown_currency_emoji(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    doc = "## Weather 🎉\n\nIt costs **$50** for 2 items.\n\n```py\nx=1\n```"
    out = fe.process(doc, "en").lower()
    assert "dollars" in out
    assert "🎉" not in out and "weather" in out
    assert "x=1" not in out
    assert "$" not in out


def test_normalize_disabled_keeps_symbols_but_strips_markdown(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("Cost is **$50** 🎉", "en")
    assert "$50" in out
    assert "🎉" not in out


def test_empty_after_strip_returns_empty(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    assert fe.process("```\njust code\n```", "en").strip() == ""


def test_masked_span_is_restored_verbatim_after_normalization(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("Then call `flush` and check `v1.2.3`.", "en")
    assert "flush" in out
    assert "v1.2.3" in out            # NOT "one point two point three"
    assert "zqxmask" not in out       # no sentinel leaked


def test_table_survives_the_full_pipeline(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("| Service | Port |\n|---|---|\n| gateway | 8080 |\n", "en")
    assert "vertical bar" not in out
    assert "Service gateway" in out


def test_no_orphan_punctuation_after_dropped_spans(policy):
    fe = build_frontend(normalize_enabled=False, policy=policy)
    out = fe.process("See [x](https://a.b) , and ( ) done.", "en")
    assert " ," not in out
    assert "( )" not in out and "()" not in out


def test_paragraph_gaps_are_preserved(policy):
    fe = build_frontend(normalize_enabled=True, policy=policy)
    out = fe.process("First para.\n\nSecond para.", "en")
    assert "\n\n" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_frontend.py -v`
Expected: FAIL — `cannot import name 'SpeechPolicy' from 'local_tts.text_frontend'`.

- [ ] **Step 3: Rewrite `frontend.py`**

```python
# src/local_tts/text_frontend/frontend.py
"""Composes the text-frontend stages into one process() call.

Stage order is load-bearing:
  strip markdown (spans masked) -> emoji/pause strip -> normalize
  -> UNMASK -> punctuation cleanup -> whitespace collapse
Unmasking before TN would defeat the mask; cleaning punctuation before
unmasking would operate on sentinels instead of the real text.
"""

from __future__ import annotations

import logging
import re

from .emoji_clean import strip_emoji, strip_pause_tags
from .markdown import strip_markdown
from .normalize import Normalizer
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
    def __init__(self, *, normalizer: Normalizer | None, policy: SpeechPolicy) -> None:
        self._normalizer = normalizer
        self._policy = policy

    def process(self, doc: str, lang: str) -> str:
        stripped = strip_markdown(doc, self._policy, lang)
        text = strip_pause_tags(strip_emoji(stripped.text))
        if self._normalizer is not None and text.strip():
            text = self._normalize_blocks(text, lang)
        text = stripped.masks.restore(text)
        text = _collapse_whitespace(_fix_orphan_punctuation(text))
        out = text.strip()
        log.debug("process in_len=%d out_len=%d lang=%s normalize=%s",
                  len(doc), len(out), lang, self._normalizer is not None)
        return out

    def _normalize_blocks(self, text: str, lang: str) -> str:
        # wetext flattens newlines, so normalizing the whole document glues
        # paragraph blocks together and destroys the \n\n prosodic gaps that
        # strip_markdown emits. Normalize each block independently and
        # rejoin with \n\n to preserve them.
        blocks = text.split("\n\n")
        out = [
            self._normalizer.normalize(b, lang) if b.strip() else b
            for b in blocks
        ]
        return "\n\n".join(out)


def build_frontend(*, normalize_enabled: bool, policy: SpeechPolicy) -> TextFrontend:
    return TextFrontend(
        normalizer=Normalizer() if normalize_enabled else None,
        policy=policy,
    )
```

- [ ] **Step 4: Update `__init__.py`**

```python
# src/local_tts/text_frontend/__init__.py
"""Text frontend: markdown/emoji strip + normalization before synthesis."""

from .frontend import TextFrontend, build_frontend
from .policy import SpeechPolicy

__all__ = ["SpeechPolicy", "TextFrontend", "build_frontend"]
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_frontend.py -v`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/frontend.py \
        capabilityServices/LocalTTSService/src/local_tts/text_frontend/__init__.py \
        capabilityServices/LocalTTSService/tests/test_frontend.py
git commit -m "feat(local-tts): unmask after TN and clean orphan punctuation"
```

---

## Task 7: Config wiring — three new required keys

**Files:**
- Modify: `capabilityServices/LocalTTSService/src/local_tts/config.py:65-71` (dataclass) and `:175-178` (`_parse`)
- Modify: `capabilityServices/LocalTTSService/config/config.example.yaml:112-119`
- Modify: `capabilityServices/LocalTTSService/src/local_tts/server.py:85-88`
- Modify: `capabilityServices/LocalTTSService/tests/test_config.py`
- Modify: `capabilityServices/LocalTTSService/tests/test_synthesis_frontend.py`

**Interfaces:**
- Consumes: `SpeechPolicy` (Task 1), `build_frontend(normalize_enabled=..., policy=...)` (Task 6).
- Produces: `TextFrontendConfig(enabled: bool, normalize: bool, table_max_cells: int, code_span_max_chars: int, speak_dropped_spans: bool)`. All five REQUIRED — `_require` raises `ConfigError` on any missing key.

- [ ] **Step 1: Add the config keys to the example YAML**

In `config/config.example.yaml`, replace the `text_frontend:` block (currently lines 113-118) with:

```yaml
text_frontend:
  # Master switch: run markdown/emoji strip + normalization at all.
  enabled: true

  # Run wetext WFST text normalization ($/%/numbers/dates/units).
  normalize: true

  # Tables with MORE body cells than this (rows x columns) are summarized
  # ("a table with 20 rows and 6 columns") instead of read out row by row.
  # Small tables are linearized screen-reader style: "Service gateway,
  # Port 8080." Range: 0-200; 0 summarizes every table.
  table_max_cells: 24

  # Inline `code` longer than this many characters is treated as non-prose
  # (a command, not a word) and replaced by a short phrase rather than
  # spoken character by character. Range: 8-120.
  code_span_max_chars: 32

  # When a span is dropped (command, file path, URL), speak a short
  # placeholder ("a command") so the sentence keeps its grammar. Set false
  # to drop silently.
  speak_dropped_spans: true
```

- [ ] **Step 2: Write the failing test**

In `tests/test_config.py`, update the module-level `_MINIMAL_YAML` constant so its `text_frontend:` section matches the block above verbatim, then add:

```python
def test_text_frontend_speech_policy_keys_parsed(tmp_path):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(_MINIMAL_YAML)
    cfg = load_config(str(cfg_file))
    assert cfg.text_frontend.table_max_cells == 24
    assert cfg.text_frontend.code_span_max_chars == 32
    assert cfg.text_frontend.speak_dropped_spans is True


def test_missing_table_max_cells_raises(tmp_path):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(_MINIMAL_YAML.replace("  table_max_cells: 24\n", ""))
    with pytest.raises(ConfigError):
        load_config(str(cfg_file))
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_config.py -v`
Expected: FAIL — `AttributeError: 'TextFrontendConfig' object has no attribute 'table_max_cells'`.

- [ ] **Step 4: Extend `config.py`**

Replace the `TextFrontendConfig` dataclass:

```python
@dataclass(frozen=True)
class TextFrontendConfig:
    """Text preprocessing before synthesis (markdown/emoji strip + TN)."""

    enabled: bool
    normalize: bool
    table_max_cells: int
    code_span_max_chars: int
    speak_dropped_spans: bool
```

and the `text_frontend=` block inside `_parse`'s `Config(...)`:

```python
        text_frontend=TextFrontendConfig(
            enabled=_require(text_frontend_raw, "text_frontend.enabled", bool),
            normalize=_require(text_frontend_raw, "text_frontend.normalize", bool),
            table_max_cells=_require(text_frontend_raw, "text_frontend.table_max_cells", int),
            code_span_max_chars=_require(
                text_frontend_raw, "text_frontend.code_span_max_chars", int
            ),
            speak_dropped_spans=_require(
                text_frontend_raw, "text_frontend.speak_dropped_spans", bool
            ),
        ),
```

- [ ] **Step 5: Wire the policy in `server.py`**

Change the import on line 48 to:

```python
from .text_frontend import SpeechPolicy, build_frontend
```

and the frontend construction (currently lines 85-88) to:

```python
        self._frontend = (
            build_frontend(
                normalize_enabled=config.text_frontend.normalize,
                policy=SpeechPolicy(
                    table_max_cells=config.text_frontend.table_max_cells,
                    code_span_max_chars=config.text_frontend.code_span_max_chars,
                    speak_dropped_spans=config.text_frontend.speak_dropped_spans,
                ),
            )
            if config.text_frontend.enabled
            else _PassthroughFrontend()
        )
```

- [ ] **Step 6: Fix the existing frontend-construction call in tests**

`tests/test_synthesis_frontend.py` calls `build_frontend(normalize_enabled=True)`. Update it to:

```python
    fe = build_frontend(
        normalize_enabled=True,
        policy=SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True),
    )
```

adding `from local_tts.text_frontend import SpeechPolicy, build_frontend` at the top. Run `cd capabilityServices/LocalTTSService && grep -rn "build_frontend" tests/ src/` and fix every remaining call site the same way.

- [ ] **Step 7: Run the full service suite**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest -v`
Expected: PASS (all non-`live` tests).

- [ ] **Step 8: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/config.py \
        capabilityServices/LocalTTSService/config/config.example.yaml \
        capabilityServices/LocalTTSService/src/local_tts/server.py \
        capabilityServices/LocalTTSService/tests/
git commit -m "feat(local-tts): add speech-policy config keys and wire them at startup"
```

---

## Task 8: Deploy — recursive additive config reconcile

**Files:**
- Modify: `capabilityServices/../deploy/mac-prod/native/service-config-reconcile.py` (path from repo root: `deploy/mac-prod/native/service-config-reconcile.py`)

**Interfaces:**
- Produces: `reconcile(template_text: str, config_text: str) -> tuple[str, list[str]]` — unchanged signature, new behaviour. `added` now contains **dotted paths** (`text_frontend.table_max_cells`) as well as top-level keys.

**Why this task exists:** the reconciler currently copies **top-level keys only**, by explicit design ("A newly-required NESTED key still needs a bespoke migration — deliberately out of scope"). Task 7 adds three keys *nested* under an existing `text_frontend:` section. On a prod host whose `~/.sentient/...` config already has `text_frontend:`, the reconciler would skip it, local-tts's fail-loud loader would raise `ConfigError: missing required key 'text_frontend.table_max_cells'`, and TTS would not start — the exact outage this script was written to prevent, one level deeper. Recursion stays strictly additive (only keys ABSENT from the target are copied), so operator edits and tuned values are still never touched.

`deploy/setup-prod.py` needs **no change** — it already calls `reconcile_service_config(...)` between local-tts install and start.

- [ ] **Step 1: Make `reconcile` recurse**

Replace the `reconcile` function body with:

```python
def reconcile(template_text: str, config_text: str) -> tuple[str, list[str]]:
    """Return (updated_text, added_paths). Additive-only, comment-preserving.

    Recurses into nested mappings so a newly-required key one or more
    levels down (e.g. ``text_frontend.table_max_cells``) also lands in an
    already-seeded host config. Only keys MISSING from the target are
    added; existing keys, values and ordering are never modified.
    """
    yaml = _yaml()
    template = yaml.load(template_text)
    config = yaml.load(config_text)
    if config is None:  # blank/empty target — treat every template key as missing
        config = yaml.load("{}\n")

    added: list[str] = []
    _merge_missing(template, config, "", added)
    return _dump(yaml, config), added


def _merge_missing(template, config, prefix: str, added: list[str]) -> None:
    """Copy template keys absent from config, recursing into mappings."""
    for key in template:
        path = f"{prefix}{key}"
        if key not in config:
            # Copy value + its INNER comments (per-field comments live inside
            # the value's CommentedMap and travel with it). We deliberately do
            # NOT copy the key's `.ca` entry: ruamel often stores a block
            # comment there that actually belongs to the FOLLOWING key, which
            # would duplicate that header into the target.
            config[key] = template[key]
            added.append(path)
            continue
        # Key exists on both sides: recurse only when BOTH are mappings.
        # A type mismatch (operator turned a section into a scalar) is left
        # alone — this tool never overwrites, it only fills gaps.
        if _is_mapping(template[key]) and _is_mapping(config[key]):
            _merge_missing(template[key], config[key], f"{path}.", added)


def _is_mapping(value) -> bool:
    """True for YAML mappings (ruamel CommentedMap subclasses dict)."""
    return isinstance(value, dict)
```

- [ ] **Step 2: Update the module docstring**

In the same file, replace the paragraph beginning `Scope: top-level keys only.` with:

```
Scope: recurses into nested mappings, so a newly-required key at any
depth (e.g. `text_frontend.table_max_cells`) is filled in too. Recursion
only descends where BOTH sides are mappings; a type mismatch is left
untouched, because this tool fills gaps and never overwrites.
```

- [ ] **Step 3: Verify against a synthetic stale config**

```bash
cd /Users/kevinye/Development/sentient
python3 - <<'PY'
import pathlib, tempfile, textwrap
stale = textwrap.dedent("""
schema_version: 1
text_frontend:
  enabled: true
  normalize: true
""").lstrip()
p = pathlib.Path(tempfile.mkdtemp()) / "config.yaml"
p.write_text(stale)
print(p)
PY
```

Take the printed path and run (substitute `<PATH>`):

```bash
python3 deploy/mac-prod/native/service-config-reconcile.py \
  --template capabilityServices/LocalTTSService/config/config.example.yaml \
  --config <PATH>
```

Expected: a unified diff whose `+` lines include `table_max_cells: 24`, `code_span_max_chars: 32` and `speak_dropped_spans: true` **inside** the existing `text_frontend:` block, and whose summary line names the dotted paths. The pre-existing `enabled: true` / `normalize: true` lines must be unchanged.

If `ruamel.yaml` is missing the script exits 2 with `ruamel.yaml required` — install it into whatever interpreter you use for this check (`python3 -m pip install ruamel.yaml`) and re-run.

- [ ] **Step 4: Verify idempotence**

Re-run the same command with `--apply`, then run it once more without `--apply`.
Expected: the second run prints `no change needed`.

- [ ] **Step 5: Commit**

```bash
git add deploy/mac-prod/native/service-config-reconcile.py
git commit -m "fix(deploy): reconcile nested service-config keys, not just top-level"
```

---

## Task 9: Version bump

**Files:**
- Modify: `capabilityServices/LocalTTSService/pyproject.toml:9`

- [ ] **Step 1: Bump the version**

Change line 9 from `version = "1.1.0"` to:

```toml
version = "1.2.0"
```

- [ ] **Step 2: Confirm no dependency drift**

Run: `cd capabilityServices/LocalTTSService && grep -n "mistune\|emoji\|wetext" pyproject.toml requirements.txt`
Expected: the same three specifiers (`mistune>=3.3,<4`, `emoji>=2.14,<3`, `wetext>=0.1`) present in BOTH files. This plan adds no dependencies; if they differ, fix `requirements.txt` to match `pyproject.toml`.

- [ ] **Step 3: Commit**

```bash
git add capabilityServices/LocalTTSService/pyproject.toml
git commit -m "chore(local-tts): bump version to 1.2.0"
```

---

## Task 10: Quality gate + live chat verification

**Files:** none (verification only).

**No audio e2e.** The agent cannot validate synthesized speech, so this task proves the frontend is *installed, wired and running* and that a real chat reply still completes end to end. Audio quality is the user's to judge.

- [ ] **Step 1: Full service unit suite**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest -v`
Expected: PASS, all non-`live` tests. (The service is managed with `uv`, not pip — do NOT run `pip install -e .`. This plan adds no dependencies, so no `uv sync` is needed either; the existing `.venv` already resolves `local_tts` from `src/`.)

- [ ] **Step 2: Regression probe on the original failing document**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/LocalTTSService
.venv/bin/python - <<'PY'
from local_tts.text_frontend import SpeechPolicy, build_frontend

fe = build_frontend(
    normalize_enabled=True,
    policy=SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True),
)
DOC = """## Setup guide

Install with `npm install --save-dev @types/node@^20.1.0` then run `bun run test:unit`.

Docs at https://example.com/a/b?x=1 or see [the guide](https://docs.example.com/guide).
Also www.example.com and <https://auto.link/x>.

| Service | Port | Status |
|---------|------|--------|
| gateway | 8080 | up     |
| tts     | 8888 | down   |

```python
def foo(x):
    return x ** 2
```

- [ ] task one
- [x] task two

Path: `/Users/kev/dev/sentient/gateway/src/a.ts`
Math: $x^2 + y^2 = z^2$ and 5 - 10 items.
"""
out = fe.process(DOC, "en")
print(out)
for bad in ("vertical bar", "circumflex", "slash Users", "dollar x", "[ ]", "--save-dev"):
    assert bad not in out, f"REGRESSION: {bad!r} still spoken"
print("\nOK: no symbol-soup markers present")
PY
```

Expected: prints readable prose ending with `OK: no symbol-soup markers present`. No assertion fires.

- [ ] **Step 3: Gateway CI (proves nothing gateway-side broke)**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci`
Expected: lint + typecheck + tests all PASS.

- [ ] **Step 4: Restart the local native local-tts and confirm it boots with the new config**

```bash
cd /Users/kevinye/Development/sentient
bash deploy/mac-prod/native/local-tts.sh restart
sleep 5
curl -s localhost:8771/health
```

Expected: health responds OK. If it exits with `ConfigError: missing required key 'text_frontend.table_max_cells'`, the local `~/.sentient` config predates Task 7 — run the Task 8 reconciler against it with `--apply` (do NOT hand-edit or overwrite the host config) and restart.

- [ ] **Step 5: One real chat reply through the local stack**

Boot the local stack per `deploy/macos/`, open the webui, send a message that provokes markdown (e.g. "give me a two-row table of two services and their ports, plus a one-line code example"), and confirm:
- the assistant reply renders in the webui (text path unaffected),
- the local-tts log shows `local_tts.text_frontend.frontend process ... normalize=True` and a `table_linearized` or `table_summarized` debug line,
- no WARN/ERROR in the gateway or local-tts logs for that cycle.

Record the log excerpt in the handover. Audio correctness is explicitly NOT asserted here.

- [ ] **Step 6: Commit any fixups**

```bash
git commit -am "chore: quality-gate fixups for tts text-frontend robustness" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage** (against the six failure classes reproduced on the current code):
1. Table → "vertical bar" spam — Task 4 (`table` plugin + linearizer) + Task 5 (routing). ✓
2. Inline code read raw — Task 3 (`classify_code_span`) + Task 2 (masking kept spans) + Task 5 (routing). ✓
3. Bare `www.` / scheme-less URLs — Task 3 (`replace_bare_spans`). ✓
4. Orphan punctuation after drops — Task 6 (`_fix_orphan_punctuation`) plus the phrase substitution in Task 3 that keeps the sentence grammatical. ✓
5. Math `$x^2$` — Task 5 (`math` plugin; `inline_math`/`block_math` in the drop sets). ✓
6. Task-list `[ ]` markers — Task 5 (`task_lists` plugin + `task_list_item` handling). ✓
Also covered: footnote bodies and raw HTML (Task 5), the user's two policy decisions (size-gated linearize / classify-then-drop, Tasks 4 and 3), the operator config surface (Task 7), the prod-deploy migration gap the nested keys create (Task 8), the requested version bump (Task 9).

**Explicitly out of scope, flagged not solved:** wetext's ID-number reading (`port 8080` → "eight thousand and eighty" rather than "eighty eighty"), `50/50` → "fifty fiftieths", `100m` meters-vs-millions ambiguity, and abbreviations `e.g.` / `vs.` passing through unexpanded. All are TN-engine residuals that need per-token semantic context; deferred deliberately rather than patched with fragile regex. The complementary upstream fix (a persona hint telling Hermes to prefer prose over tables and fenced code when the reply will be spoken) is a Hermes-side change and is not part of this branch.

**Placeholder scan:** every code step contains complete, runnable code. The two "find the call site" steps (Task 7 Step 6, Task 8 Step 3) give the exact grep/command and the exact replacement text.

**Type consistency:** `SpeechPolicy(table_max_cells, code_span_max_chars, speak_dropped_spans)` is constructed identically in Tasks 1, 3, 4, 5, 6, 7 and 10. `MaskTable.add`/`.restore`, `SpanVerdict(keep, phrase_key)`, `phrase(lang, key)`, `render_table(tok, render_cell, policy, lang)`, `render_code_span(raw, policy, lang, masks)`, `replace_bare_spans(text, policy, lang)`, `strip_markdown(doc, policy, lang) -> StrippedDoc(text, masks)` and `build_frontend(normalize_enabled=, policy=)` keep the same names and argument order in every task that references them.

**Known risks flagged in-plan:** sentinel/wetext collision (Task 2 Step 4 fallback), doubled "a link" phrase from the prose-scan + autolink-node overlap (Task 5 Step 3 note + Step 4 guard test), `_BARE_PATH_RE` over-matching ordinary prose (Task 3 Step 4), existing `build_frontend` call sites (Task 7 Step 6), stale local/prod host config missing the nested keys (Task 8 + Task 10 Step 4).
