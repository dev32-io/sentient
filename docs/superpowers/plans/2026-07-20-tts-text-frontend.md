# TTS Text Frontend (Python) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all TTS text preprocessing (markdown stripping, emoji removal, text normalization) out of the TypeScript gateway and into the Python `LocalTTSService`, replacing the unreliable `streaming-markdown` stripper with a robust complete-document frontend: mistune AST → speakable plaintext → wetext WFST text normalization.

**Architecture:** The gateway stops cleaning text — it forwards raw markdown deltas over the existing `text`/`end` WS messages (no wire-protocol change). The service buffers deltas and, at `flush`/`end`, runs the buffered document through a new `text_frontend` package (markdown strip → emoji strip → normalize) before handing the speakable text to the MLX synthesizer. Synthesis granularity is unchanged: one Qwen `generate()` per cycle, same as today.

**Tech Stack:** Python 3.11 (service), `mistune>=3.3` (markdown AST), `emoji>=2.14` (emoji strip), `wetext>=0.1` (WFST text normalization, pure-Python, zh+en+ja, Apache-2.0). Gateway: Bun/TypeScript (deletions only).

## Global Constraints

- Service files MUST stay under 300 lines; functions under 40 lines; max nesting depth 3 (matches gateway `clean-code.md`; the service already follows this).
- Service config: every tunable lives in `config.yaml`, parsed by `config.py` into a frozen dataclass, every key REQUIRED (fail-loud, no silent defaults) — mirror the existing `config.py` pattern exactly.
- Logging: use the service's existing tagged logger (`logging.getLogger("local_tts.<module>")` / `conn_log`). Log lengths/ids/counts only — NEVER log text/transcript content (follow the service convention: `text_len=`, not `text=`).
- Synthesis granularity is UNCHANGED: text is buffered and synthesized once per `end` (per cycle). This plan relocates text processing only; it does NOT introduce per-block/per-sentence synthesis.
- wetext ships its FST `.far` data inside the wheel — no runtime network download. Import MUST succeed offline (verified in spike).
- New Python deps go in BOTH `pyproject.toml` AND `requirements.txt` (the service maintains both; see `requirements.txt` header).
- Language for normalization = the connection's `default_lang` (from the voice pack). Mixed zh/en content uses that single normalizer — a known, accepted limitation (matches the existing `lang_code=self._default_lang` model call).
- Ambiguity ("100m" = meters vs millions) is NOT solved — rules-only, accept residual. The ONE corruption bug (`N-N <word>` → duplicated tail) IS fixed by a pre-normalization range rule.

---

## File Structure

**New (service — `capabilityServices/LocalTTSService/src/local_tts/text_frontend/`):**
- `__init__.py` — exports `TextFrontend`, `build_frontend`.
- `markdown.py` — `strip_markdown(doc: str) -> str`. mistune AST walk → speakable plaintext, paragraph breaks as `\n\n`. Policy: drop code blocks / images / raw URLs / math; read link text (drop URL); read inline-code text; read bold/italic/strikethrough.
- `emoji_clean.py` — `strip_emoji(text: str) -> str` + `strip_pause_tags(text: str) -> str` (defensive `[pause]`-tag removal ported from gateway `stripEdgePauses`).
- `normalize.py` — `Normalizer` wrapper: `normalize(text: str, lang: str) -> str`. Range/negative regex pre-shim + cached per-lang `wetext.Normalizer`.
- `frontend.py` — `TextFrontend.process(doc: str, lang: str) -> str` composing strip → emoji → normalize; `build_frontend(cfg, default_lang)` factory.

**New (service tests — `capabilityServices/LocalTTSService/tests/`):**
- `test_markdown_strip.py`, `test_emoji_clean.py`, `test_normalize.py`, `test_frontend.py`, `test_synthesis_frontend.py`.

**Modified (service):**
- `pyproject.toml`, `requirements.txt` — add deps.
- `config.py` — add `TextFrontendConfig` + `text_frontend` field.
- `config/config.example.yaml` — add `text_frontend:` section.
- `synthesis.py` — `SynthesisRunner` takes `frontend`, `flush()` runs it.
- `connection_session.py` — `ConnectionSession` takes `frontend`, passes to runner.
- `server.py` — build `TextFrontend` at startup, inject into sessions.

**Modified/deleted (gateway — `gateway/`):**
- Modify `src/tts/streaming-tts-synthesizer.ts` — forward raw deltas, drop aggregation + `stripEdgePauses`.
- Modify `src/session-handlers/ws-session-configure.ts:498,607` — drop `stripChain`.
- Delete `src/tts/stages/markdown-stripper.ts` (+ `.test.ts`), `src/tts/stages/emoji-stripper.ts` (+ `.test.ts`), `src/tts/stages/utterance-aggregator.ts` (+ `.test.ts`).
- Modify `src/tts/stages/stage-types.ts` — drop `composeTextStages` if unused; keep `FLUSH_SIGNAL`, `TtsChunk`.
- Modify `package.json` — remove `streaming-markdown`, `emoji-regex` if unused elsewhere.
- Modify `gateway/config.yaml` — remove the aggregator `maxBlockChars` knob from `tts:`.

---

## Task 1: Markdown strip module (mistune AST → speakable plaintext)

**Files:**
- Modify: `capabilityServices/LocalTTSService/pyproject.toml`
- Modify: `capabilityServices/LocalTTSService/requirements.txt`
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/__init__.py`
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/markdown.py`
- Test: `capabilityServices/LocalTTSService/tests/test_markdown_strip.py`

**Interfaces:**
- Produces: `strip_markdown(doc: str) -> str` — complete markdown document → speakable plaintext; block-level elements separated by `\n\n`; code blocks / images / raw URLs / math dropped; link text kept (URL dropped); inline code text kept; emphasis text kept.

- [ ] **Step 1: Add dependencies** (all three, used across Tasks 1–3)

In `pyproject.toml` `dependencies` list add:
```toml
    # Text frontend (see docs/superpowers/plans/2026-07-20-tts-text-frontend.md):
    "mistune>=3.3,<4",        # markdown -> AST for the speech stripper
    "emoji>=2.14,<3",         # emoji removal
    "wetext>=0.1",            # WFST text normalization (zh+en+ja, pure-Python, ships FST data)
```
Add the same three (with matching version specifiers) to `requirements.txt`.

- [ ] **Step 2: Write the failing test**

```python
# tests/test_markdown_strip.py
from local_tts.text_frontend.markdown import strip_markdown


def test_drops_code_block_keeps_prose():
    doc = "Here is code:\n\n```py\nprint(1)\n```\n\nDone."
    out = strip_markdown(doc)
    assert "print" not in out
    assert "Here is code:" in out
    assert "Done." in out


def test_keeps_link_text_drops_url():
    out = strip_markdown("See [the docs](https://example.com/x) now.")
    assert "the docs" in out
    assert "example.com" not in out
    assert "https" not in out


def test_keeps_inline_code_and_emphasis_text():
    out = strip_markdown("Run `npm test` for **bold** and *italic* words.")
    assert "npm test" in out
    assert "bold" in out
    assert "italic" in out


def test_heading_and_list_become_separated_blocks():
    doc = "# Title\n\n- one\n- two"
    out = strip_markdown(doc)
    assert "Title" in out
    assert "one" in out and "two" in out
    # block elements separated by a blank line for the synth's prosodic gap
    assert "\n\n" in out


def test_drops_images_and_bare_urls():
    out = strip_markdown("Look ![alt](a.png) at https://raw.example.com here.")
    assert "a.png" not in out
    assert "raw.example.com" not in out
    assert "Look" in out and "here" in out


def test_empty_document_returns_empty():
    assert strip_markdown("") == ""
    assert strip_markdown("```\nonly code\n```").strip() == ""
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_markdown_strip.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'local_tts.text_frontend'`

- [ ] **Step 4: Create the package init**

```python
# src/local_tts/text_frontend/__init__.py
"""Text frontend: markdown/emoji strip + normalization before synthesis."""
```

- [ ] **Step 5: Implement `strip_markdown`**

```python
# src/local_tts/text_frontend/markdown.py
"""Markdown document -> speakable plaintext via mistune's AST.

Runs on a COMPLETE document (buffered at flush/end), not a stream — so
mistune parses reliably (unclosed fences/bold across delta boundaries,
which broke the old TS streaming stripper, can't happen here).

Policy (mirrors the retired gateway markdown-stripper renderer):
  drop   : code blocks, images, raw/autolink URLs, math
  keep   : link TEXT (url dropped), inline-code text, bold/italic/strike text
  layout : block-level elements separated by a blank line so the synth
           gets a prosodic gap between paragraphs/headings/list items.
"""

from __future__ import annotations

import logging

import mistune

log = logging.getLogger("local_tts.text_frontend.markdown")

# mistune 3 AST: renderer=None yields a list of block-token dicts.
_PARSE = mistune.create_markdown(renderer=None)

# Inline token types whose visible text we READ (recurse into children).
_INLINE_READ = frozenset({"strong", "emphasis", "del", "link", "block_text", "paragraph"})
# Inline token types dropped entirely (no speakable content).
_INLINE_DROP = frozenset({"image", "linebreak", "softbreak", "inline_math"})


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
    if ttype == "heading":
        return _render_children(tok.get("children", []))
    if ttype == "paragraph":
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
    parts: list[str] = []
    for child in children:
        ctype = child.get("type")
        if ctype == "text":
            parts.append(child.get("raw", ""))
        elif ctype == "codespan":
            parts.append(child.get("raw", ""))
        elif ctype in _INLINE_DROP:
            continue
        elif ctype in _INLINE_READ or "children" in child:
            parts.append(_render_children(child.get("children", [])))
    return "".join(parts)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/pip install -e . && .venv/bin/python -m pytest tests/test_markdown_strip.py -v`
Expected: PASS (6 tests). If mistune AST field names differ from the spike (`type`, `raw`, `children`, `attrs`), adjust `_render_*` to match the installed mistune 3.3.x shape — verify with `.venv/bin/python -c "import mistune,json;print(json.dumps(mistune.create_markdown(renderer=None)('# h\n\ntext'),indent=1))"`.

- [ ] **Step 7: Commit**

```bash
git add capabilityServices/LocalTTSService/pyproject.toml capabilityServices/LocalTTSService/requirements.txt capabilityServices/LocalTTSService/src/local_tts/text_frontend/ capabilityServices/LocalTTSService/tests/test_markdown_strip.py
git commit -m "feat(local-tts): add mistune-based markdown-to-speech stripper"
```

---

## Task 2: Emoji + pause-tag cleanup module

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/emoji_clean.py`
- Test: `capabilityServices/LocalTTSService/tests/test_emoji_clean.py`

**Interfaces:**
- Produces: `strip_emoji(text: str) -> str`; `strip_pause_tags(text: str) -> str` (removes literal `[pause]`/`[short pause]`/`[长停顿]` etc. — defensive net; emotion tagging was removed upstream).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_emoji_clean.py
from local_tts.text_frontend.emoji_clean import strip_emoji, strip_pause_tags


def test_strip_emoji_removes_emoji_keeps_words():
    assert strip_emoji("great job 🎉👏 today") == "great job  today"


def test_strip_emoji_noop_on_plain_text():
    assert strip_emoji("no emoji here") == "no emoji here"


def test_strip_pause_tags_removes_bracket_tags():
    assert strip_pause_tags("[pause] hello [short pause] world").strip() == "hello  world".strip()


def test_strip_pause_tags_removes_cjk_pause_tags():
    assert "停顿" not in strip_pause_tags("你好[长停顿]世界")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_emoji_clean.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# src/local_tts/text_frontend/emoji_clean.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_emoji_clean.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/emoji_clean.py capabilityServices/LocalTTSService/tests/test_emoji_clean.py
git commit -m "feat(local-tts): add emoji + pause-tag cleanup"
```

---

## Task 3: Text normalizer (range/negative shim + wetext WFST)

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/normalize.py`
- Test: `capabilityServices/LocalTTSService/tests/test_normalize.py`

**Interfaces:**
- Produces: `Normalizer` class with `normalize(text: str, lang: str) -> str`. Caches one `wetext.Normalizer` per lang. Applies the range pre-rule `(\d)\s*-\s*(\d)` → `\1 to \2` BEFORE wetext (fixes the `5-10 minutes`→"minutes inutes" corruption AND resolves range hyphens) and a leading-negative rule.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_normalize.py
import pytest

from local_tts.text_frontend.normalize import Normalizer


@pytest.fixture(scope="module")
def norm():
    return Normalizer()


def test_currency_expands(norm):
    assert "dollars" in norm.normalize("$12.50", "en").lower()


def test_percent_and_units(norm):
    out = norm.normalize("90% done at 100km/h", "en").lower()
    assert "percent" in out
    assert "kilometers per hour" in out


def test_range_does_not_corrupt_following_word(norm):
    # Regression: bare wetext turns "5-10 minutes" into "... minutes inutes".
    out = norm.normalize("Wait 5-10 minutes.", "en").lower()
    assert "inutes" not in out
    assert "minutes" in out
    assert "to" in out  # "five to ten minutes"


def test_plain_prose_untouched(norm):
    s = "The weather is nice today and I feel great."
    assert norm.normalize(s, "en") == s


def test_zh_currency_and_negative(norm):
    out = norm.normalize("价格是$50，温度是-5度。", "zh")
    assert "美元" in out
    assert "负" in out


def test_normalizer_cached_per_lang(norm):
    a = norm._for("en")
    b = norm._for("en")
    assert a is b
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_normalize.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

```python
# src/local_tts/text_frontend/normalize.py
"""Text normalization: written form -> spoken form.

Core engine is wetext (WFST, zh+en+ja). A thin regex pre-shim runs
BEFORE wetext to (a) fix wetext's EN numeric-range bug — `5-10 word`
corrupts the following word — by rewriting `N-N` to `N to N`, and
(b) speak a leading negative sign in EN (wetext EN leaves "-5" as
"-five"; zh already says 负).

Ambiguous cases (e.g. "100m" = meters vs millions) are NOT resolved —
wetext picks one reading; that residual is accepted by design.
"""

from __future__ import annotations

import logging
import re

from wetext import Normalizer as WeNormalizer

log = logging.getLogger("local_tts.text_frontend.normalize")

# Digit-hyphen-digit range -> "N to N". Also kills the wetext EN corruption
# where a range immediately followed by a word duplicates the word's tail.
_RANGE_RE = re.compile(r"(\d)\s*-\s*(\d)")
# Leading negative number (EN): "-5" -> "negative 5", when not part of a
# word/range (range already rewritten above).
_NEG_RE = re.compile(r"(?<![\w\d])-(\d)")


class Normalizer:
    def __init__(self) -> None:
        self._cache: dict[str, WeNormalizer] = {}

    def _for(self, lang: str) -> WeNormalizer:
        key = lang if lang in ("en", "zh", "ja") else "en"
        if key not in self._cache:
            log.info("build_normalizer lang=%s", key)
            self._cache[key] = WeNormalizer(lang=key, operator="tn")
        return self._cache[key]

    def normalize(self, text: str, lang: str) -> str:
        pre = _RANGE_RE.sub(r"\1 to \2", text)
        if lang == "en":
            pre = _NEG_RE.sub(r"negative \1", pre)
        out = self._for(lang).normalize(pre)
        log.debug("normalize lang=%s in_len=%d out_len=%d", lang, len(text), len(out))
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_normalize.py -v`
Expected: PASS (6 tests). If `_NEG_RE` misfires on a range edge, confirm `_RANGE_RE` runs first (it does).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/normalize.py capabilityServices/LocalTTSService/tests/test_normalize.py
git commit -m "feat(local-tts): add wetext normalizer with range/negative pre-shim"
```

---

## Task 4: Frontend composer

**Files:**
- Modify: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/__init__.py`
- Create: `capabilityServices/LocalTTSService/src/local_tts/text_frontend/frontend.py`
- Test: `capabilityServices/LocalTTSService/tests/test_frontend.py`

**Interfaces:**
- Consumes: `strip_markdown` (Task 1), `strip_emoji`/`strip_pause_tags` (Task 2), `Normalizer` (Task 3).
- Produces: `TextFrontend` with `process(doc: str, lang: str) -> str` (strip → emoji → pause-tags → optional normalize) and `build_frontend(*, normalize_enabled: bool) -> TextFrontend`. Exported from `text_frontend.__init__`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_frontend.py
from local_tts.text_frontend import TextFrontend, build_frontend


def test_end_to_end_markdown_currency_emoji():
    fe = build_frontend(normalize_enabled=True)
    doc = "## Weather 🎉\n\nIt costs **$50** for `2` items.\n\n```py\nx=1\n```"
    out = fe.process(doc, "en").lower()
    assert "dollars" in out
    assert "🎉" not in out and "weather" in out
    assert "x=1" not in out  # code block dropped
    assert "$" not in out


def test_normalize_disabled_keeps_symbols_but_strips_markdown():
    fe = build_frontend(normalize_enabled=False)
    out = fe.process("Cost is **$50** 🎉", "en")
    assert "$50" in out  # not normalized
    assert "🎉" not in out  # still stripped


def test_empty_after_strip_returns_empty():
    fe = build_frontend(normalize_enabled=True)
    assert fe.process("```\njust code\n```", "en").strip() == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_frontend.py -v`
Expected: FAIL with `ImportError: cannot import name 'TextFrontend'`.

- [ ] **Step 3: Implement**

```python
# src/local_tts/text_frontend/frontend.py
"""Composes the text-frontend stages into one process() call."""

from __future__ import annotations

import logging

from .emoji_clean import strip_emoji, strip_pause_tags
from .markdown import strip_markdown
from .normalize import Normalizer

log = logging.getLogger("local_tts.text_frontend.frontend")


class TextFrontend:
    def __init__(self, *, normalizer: Normalizer | None) -> None:
        self._normalizer = normalizer

    def process(self, doc: str, lang: str) -> str:
        text = strip_markdown(doc)
        text = strip_pause_tags(strip_emoji(text))
        if self._normalizer is not None and text.strip():
            text = self._normalizer.normalize(text, lang)
        out = text.strip()
        log.debug("process in_len=%d out_len=%d lang=%s normalize=%s",
                  len(doc), len(out), lang, self._normalizer is not None)
        return out


def build_frontend(*, normalize_enabled: bool) -> TextFrontend:
    return TextFrontend(normalizer=Normalizer() if normalize_enabled else None)
```

Update `__init__.py`:
```python
# src/local_tts/text_frontend/__init__.py
"""Text frontend: markdown/emoji strip + normalization before synthesis."""

from .frontend import TextFrontend, build_frontend

__all__ = ["TextFrontend", "build_frontend"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_frontend.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/text_frontend/frontend.py capabilityServices/LocalTTSService/src/local_tts/text_frontend/__init__.py capabilityServices/LocalTTSService/tests/test_frontend.py
git commit -m "feat(local-tts): compose text-frontend stages"
```

---

## Task 5: Config wiring (`text_frontend` section)

**Files:**
- Modify: `capabilityServices/LocalTTSService/src/local_tts/config.py`
- Modify: `capabilityServices/LocalTTSService/config/config.example.yaml`
- Test: `capabilityServices/LocalTTSService/tests/test_config.py` (create if absent)

**Interfaces:**
- Produces: `Config.text_frontend: TextFrontendConfig` with `enabled: bool` (master: run the frontend at all) and `normalize: bool` (run wetext TN). Both REQUIRED keys under a `text_frontend:` section.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config.py (add this test; create file if it doesn't exist)
import pytest

from local_tts.config import ConfigError, load_config


def test_text_frontend_section_parsed(tmp_path):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(_MINIMAL_YAML)
    cfg = load_config(str(cfg_file))
    assert cfg.text_frontend.enabled is True
    assert cfg.text_frontend.normalize is True


def test_missing_text_frontend_raises(tmp_path):
    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(_MINIMAL_YAML.replace("text_frontend:\n  enabled: true\n  normalize: true\n", ""))
    with pytest.raises(ConfigError):
        load_config(str(cfg_file))
```

Include a `_MINIMAL_YAML` constant in the test file: copy `config/config.example.yaml` content verbatim after Step 3 so it stays a valid, complete config (every key required). Keep it as a module-level triple-quoted string.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_config.py -v`
Expected: FAIL — `Config` has no `text_frontend` field / `ConfigError` for the minimal yaml.

- [ ] **Step 3: Implement config**

In `config.py`, add the dataclass (after `HealthConfig`):
```python
@dataclass(frozen=True)
class TextFrontendConfig:
    """Text preprocessing before synthesis (markdown/emoji strip + TN)."""

    enabled: bool
    normalize: bool
```
Add to `Config`:
```python
    text_frontend: TextFrontendConfig
```
In `_parse`, add a section pull and field:
```python
    text_frontend_raw = _require_section(raw, "text_frontend")
```
and inside the `Config(...)` constructor:
```python
        text_frontend=TextFrontendConfig(
            enabled=_require(text_frontend_raw, "text_frontend.enabled", bool),
            normalize=_require(text_frontend_raw, "text_frontend.normalize", bool),
        ),
```

In `config/config.example.yaml`, add:
```yaml
# Text frontend — preprocessing applied to buffered text before synthesis.
text_frontend:
  enabled: true    # master switch: run markdown/emoji strip + normalization
  normalize: true  # run wetext WFST text normalization ($/%/numbers/dates/units)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/config.py capabilityServices/LocalTTSService/config/config.example.yaml capabilityServices/LocalTTSService/tests/test_config.py
git commit -m "feat(local-tts): add text_frontend config section"
```

---

## Task 6: Wire frontend into the synthesis path

**Files:**
- Modify: `capabilityServices/LocalTTSService/src/local_tts/synthesis.py:130-139` (`add_text`/`flush`) and constructor
- Modify: `capabilityServices/LocalTTSService/src/local_tts/connection_session.py:65-94` (constructor + runner build)
- Modify: `capabilityServices/LocalTTSService/src/local_tts/server.py` (build + inject frontend)
- Test: `capabilityServices/LocalTTSService/tests/test_synthesis_frontend.py`

**Interfaces:**
- Consumes: `TextFrontend` (Task 4), `Config.text_frontend` + `Config.default_lang` (Task 5).
- Produces: `SynthesisRunner.__init__` gains `frontend: TextFrontend`; `flush()` runs `frontend.process(joined, default_lang)` and enqueues the result (skips enqueue if empty). `ConnectionSession.__init__` gains `frontend`. Server builds one process-wide `TextFrontend`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_synthesis_frontend.py
import asyncio

from local_tts.text_frontend import build_frontend


class _FakeFrontend:
    def __init__(self):
        self.calls = []

    def process(self, doc, lang):
        self.calls.append((doc, lang))
        return f"NORM::{doc}"


def _make_runner(frontend):
    # Import here so the test file loads even if heavy deps shift.
    from local_tts.synthesis import SynthesisRunner
    return SynthesisRunner(
        executor=None, voice_store=None, synth_lock=asyncio.Lock(), ws=None,
        conn_id="t", format_="opus", sample_rate=48000, voice=None,
        streaming_interval=0.5, default_lang="en", conn_log=_NullLog(),
        metrics_log=_NullLog(), frontend=frontend,
    )


class _NullLog:
    def log(self, *a, **k): ...


def test_flush_runs_frontend_before_enqueue():
    fe = _FakeFrontend()

    async def run():
        runner = _make_runner(fe)
        runner._worker_task.cancel()  # don't actually synthesize
        runner.add_text("It costs $50")
        runner.flush()
        assert fe.calls == [("It costs $50", "en")]
        assert runner._queue.get_nowait() == "NORM::It costs $50"

    asyncio.run(run())


def test_flush_skips_enqueue_when_frontend_returns_empty():
    fe = build_frontend(normalize_enabled=True)

    async def run():
        runner = _make_runner(fe)
        runner._worker_task.cancel()
        runner.add_text("```\njust code\n```")
        runner.flush()
        assert runner._queue.empty()

    asyncio.run(run())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_synthesis_frontend.py -v`
Expected: FAIL — `SynthesisRunner.__init__() got an unexpected keyword argument 'frontend'`.

- [ ] **Step 3: Modify `SynthesisRunner`**

In `synthesis.py`, add `frontend` to `__init__` params and store it:
```python
        frontend: Any,
```
(add near `metrics_log`), then in the body:
```python
        self._frontend = frontend
```
Rewrite `flush()`:
```python
    def flush(self) -> None:
        """Run the buffered text through the frontend, then enqueue it."""
        if not self._text_buffer:
            return
        raw = "".join(self._text_buffer)
        self._text_buffer = []
        speakable = self._frontend.process(raw, self._default_lang)
        if not speakable.strip():
            self._conn_log.log("synth.flush_empty_after_frontend", raw_len=len(raw))
            return
        self._queue.put_nowait(speakable)
```

- [ ] **Step 4: Thread `frontend` through `ConnectionSession`**

In `connection_session.py` `__init__`, add `frontend: Any` param, and pass it into the `SynthesisRunner(...)` construction:
```python
            frontend=frontend,
```

- [ ] **Step 5: Build + inject in `server.py`**

Read `server.py` to find where `Config` is loaded and where `ConnectionSession(...)` is constructed. Build the frontend once at startup:
```python
from .text_frontend import build_frontend
# ... after config load:
frontend = (
    build_frontend(normalize_enabled=config.text_frontend.normalize)
    if config.text_frontend.enabled
    else _PassthroughFrontend()
)
```
Add a tiny `_PassthroughFrontend` (in `server.py` or a small helper) whose `process(doc, lang)` returns `doc` unchanged, so `enabled: false` fully bypasses the frontend. Pass `frontend=frontend` into every `ConnectionSession(...)` construction.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_synthesis_frontend.py -v`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full service unit suite**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest -v`
Expected: PASS (all non-`live` tests). Fix any constructor-signature fallout in existing tests that build `SynthesisRunner`/`ConnectionSession` (add `frontend=build_frontend(normalize_enabled=False)` or a fake).

- [ ] **Step 8: Commit**

```bash
git add capabilityServices/LocalTTSService/src/local_tts/synthesis.py capabilityServices/LocalTTSService/src/local_tts/connection_session.py capabilityServices/LocalTTSService/src/local_tts/server.py capabilityServices/LocalTTSService/tests/test_synthesis_frontend.py
git commit -m "feat(local-tts): run text frontend at flush before synthesis"
```

---

## Task 7: Gateway — forward raw deltas (drop aggregation + strip)

**Files:**
- Modify: `gateway/src/tts/streaming-tts-synthesizer.ts`
- Test: `gateway/src/tts/streaming-tts-synthesizer.test.ts` (if present; else skip test edits)

**Interfaces:**
- Consumes: `TtsChunk` (`string | FLUSH_SIGNAL`) stream, `TTSProvider` (`pushText`/`endInput`/`audioFrames`/`ready`/`dispose`/`warmup`).
- Produces: `synthesizeImpl` forwards each string chunk via `session.pushText(chunk)` with NO aggregation and NO `stripEdgePauses`; `FLUSH_SIGNAL` is ignored on the wire (buffered-doc processing now happens service-side); `endInput()` in `finally` remains the single synth trigger.

- [ ] **Step 1: Rewrite the producer loop**

In `streaming-tts-synthesizer.ts`, replace the producer body (lines ~60-106) so it forwards raw chunks:
```typescript
  const producer = (async () => {
    let firstPush = true;
    try {
      for await (const chunk of textStream) {
        if (signal.aborted) break;
        if (chunk === FLUSH_SIGNAL) continue; // service buffers + splits now
        if (chunk.length === 0) continue;

        if (firstPush) {
          try {
            await session.ready(signal);
          } catch (err: unknown) {
            log.error("session-ready-failed", {
              message: err instanceof Error ? err.message : String(err),
            });
            session.dispose();
            return;
          }
          firstPush = false;
        }
        log.debug("delta-push", { chars: chunk.length });
        session.pushText(chunk);
      }
    } catch (err: unknown) {
      log.error("producer-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.endInput();
      log.debug("producer-end-input");
    }
  })();
```
Add the import: `import { FLUSH_SIGNAL, type TtsChunk } from "./stages/stage-types.ts";` (drop the `aggregateUtterances`/`UtteranceAggregatorOptions` imports and the `deps.aggregator` field). Delete `stripEdgePauses` + its regexes (lines 140-153) and the `blocksFed` counter. Update `StreamingTtsSynthesizerDeps` to drop `aggregator`.

- [ ] **Step 2: Update callers of `createStreamingTtsSynthesizer`**

Run: `cd gateway && grep -rn "createStreamingTtsSynthesizer\|aggregator:" src/` — remove the now-defunct `aggregator: () => ({ maxBlockChars: ... })` from every construction site (likely `ws-session-configure.ts` or a factory).

- [ ] **Step 3: Typecheck**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run typecheck`
Expected: PASS (or only the known errors from Task 8's not-yet-done deletions — resolve fully by end of Task 8).

- [ ] **Step 4: Commit**

```bash
git add gateway/src/tts/streaming-tts-synthesizer.ts
git commit -m "refactor(gateway): forward raw text deltas to local-tts (frontend moved service-side)"
```

---

## Task 8: Gateway — delete strip stages, aggregator, deps, config knob

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts:498,607-608`
- Delete: `gateway/src/tts/stages/markdown-stripper.ts` (+ `.test.ts`)
- Delete: `gateway/src/tts/stages/emoji-stripper.ts` (+ `.test.ts`)
- Delete: `gateway/src/tts/stages/utterance-aggregator.ts` (+ `.test.ts`)
- Modify: `gateway/src/tts/stages/stage-types.ts`
- Modify: `gateway/package.json`
- Modify: `gateway/config.yaml`

**Interfaces:**
- Produces: `ws-session-configure.ts` feeds `gateByChannel(deltas)` directly to `synthesizer.synthesize(...)` — no `stripChain`. `stage-types.ts` keeps `FLUSH_SIGNAL` + `TtsChunk`; `composeTextStages`/`TextStage` removed if unused.

- [ ] **Step 1: Remove the strip chain wiring**

In `ws-session-configure.ts`, delete line 498 (`const stripChain = composeTextStages(...)`) and its imports of `createMarkdownStripper`/`createEmojiStripper`/`composeTextStages`. Change line 607-608:
```typescript
      const stripped = stripChain(gateByChannel(deltas), ttsController.signal);
      synthesizer.synthesize(stripped, ...)
```
to feed the gated deltas directly:
```typescript
      const gated = gateByChannel(deltas);
      synthesizer.synthesize(gated, ttsController.signal /* ...same remaining args... */);
```
(Preserve the exact remaining `synthesize(...)` arguments; only the first arg source changes.)

- [ ] **Step 2: Delete the dead stage files + tests**

```bash
cd /Users/kevinye/Development/sentient/gateway
git rm src/tts/stages/markdown-stripper.ts src/tts/stages/markdown-stripper.test.ts \
       src/tts/stages/emoji-stripper.ts src/tts/stages/emoji-stripper.test.ts \
       src/tts/stages/utterance-aggregator.ts src/tts/stages/utterance-aggregator.test.ts
```
(If any `.test.ts` path doesn't exist, drop it from the command.)

- [ ] **Step 3: Trim `stage-types.ts`**

Run `cd gateway && grep -rn "composeTextStages\|TextStage" src/` — if only `stage-types.ts` and the deleted files referenced them, remove `composeTextStages` and the `TextStage` type. Keep `FLUSH_SIGNAL`, `FlushSignal`, and `TtsChunk` (still used by the delta broadcaster + synthesizer).

- [ ] **Step 4: Remove unused npm deps**

Run `cd gateway && grep -rn "streaming-markdown\|emoji-regex" src/` — if no hits remain, remove both from `package.json` `dependencies`, then `bun install`.

- [ ] **Step 5: Remove the aggregator config knob**

In `gateway/config.yaml` `tts:` block, delete the aggregator `maxBlockChars` key and its comment (the aggregator no longer exists gateway-side). Run `cd gateway && grep -rn "maxBlockChars" src/` to confirm no reader remains.

- [ ] **Step 6: Typecheck + lint + unit**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run typecheck && bun run lint && bun run test:unit`
Expected: PASS. Resolve any dangling references the deletions surfaced (per `feedback_dont_preserve_stale_refs`).

- [ ] **Step 7: Commit**

```bash
git add -A gateway/
git commit -m "refactor(gateway): remove markdown/emoji strip + aggregator (moved to local-tts)"
```

---

## Task 9: Full quality gate (both sides)

**Files:** none (verification only).

- [ ] **Step 1: Service unit suite (no live)**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest -v`
Expected: PASS, all non-`live` tests.

- [ ] **Step 2: Service import-offline check**

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -c "from local_tts.text_frontend import build_frontend; fe=build_frontend(normalize_enabled=True); print(fe.process('It costs \$50 🎉','en'))"`
Expected: prints a normalized, emoji-free line containing "dollars"; no network access.

- [ ] **Step 3: Gateway CI**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci`
Expected: lint + typecheck + tests all PASS.

- [ ] **Step 4: Commit (if any fixups)**

```bash
git commit -am "chore: quality-gate fixups for tts text frontend" || echo "nothing to commit"
```

---

## Task 10: E2E smoke against the local stack

**Files:** none (agent-driven smoke per `.claude/rules/e2e-testing.md`).

Boot the local Docker stack (`deploy/macos/`) with the rebuilt local-tts service, drive the webui via Playwright MCP, use the free Ollama LLM provider, and prompt the model to emit target text verbatim ("Please reply with exactly: …") so the frontend's behavior is observable. Capture screenshots + the gateway/service log trail.

**Web only — no native mobile, no viewport matrix.** This is a gateway↔TTS audio-pipeline change; behavior is identical regardless of client surface or browser width (TTS output is audio, not layout). So all rows run web desktop (1280×900). No Maestro, no `browser_resize` mobile pass.

**E2E matrix (INLINE, per e2e rule):**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| tts-currency | desktop 1280×900 | logged in, mic ready | Ask model to say exactly "It costs $50 for 2 items" | Hear "fifty dollars … two items" (no "dollar sign") | service `text_frontend.frontend process normalize=true`; `local_tts.synthesize` one record |
| tts-markdown | desktop | logged in | Ask for a reply with a heading, **bold**, a bullet list, and a fenced code block | Heading + bold + list items spoken with paragraph pauses; code block NOT spoken | service `strip … blocks=N`; no code text in synth `text_len` growth pattern |
| tts-range | desktop | logged in | Ask model to say exactly "Wait 5-10 minutes" | Hear "five to ten minutes" — NO garbled "inutes" | service `normalize` applied; no WARN |
| tts-emoji | desktop 1280×900 | logged in | Ask for a reply containing emoji | Emoji not vocalized; surrounding words spoken | `process` out_len < in_len; no emoji artifacts |
| tts-zh | desktop 1280×900 | zh voice pack active | Ask (zh) with "$50" and "-5度" | Hear "五十美元 … 负五度" | `normalize lang=zh` |
| barge-in | desktop 1280×900 | mid-TTS playback | Start speaking (mic onset) | TTS aborts immediately (regression check) | `synthesize-aborted`; provider `cancel` |
| short-reply | desktop 1280×900 | logged in | Trigger a one-word reply ("Sure.") | "Sure." is spoken (tail flush works) | `end` → one synth record |

- [ ] **Step 1:** Rebuild local-tts in the local stack and boot: follow `deploy/macos/` boot procedure; confirm the service venv reinstalled with `wetext`/`mistune`/`emoji`.
- [ ] **Step 2:** Run each matrix row via Playwright MCP at the listed viewport; capture screenshots + console/network under the Playwright output dir.
- [ ] **Step 3:** Tail `gateway/logs/YYYY-MM-DD.log` + the local-tts logs; confirm each row's log trail, no unexpected WARN/ERROR.
- [ ] **Step 4:** Record evidence + a one-line pass/fail per row in the handover. A row is green only when user-visible behavior AND log trail match.

---

## Self-Review

**Spec coverage** (against the user's four pains + the "move to service" directive):
- Unreliable markdown stripper → replaced by mistune complete-document AST strip (Task 1). ✓
- `$` not spoken as "dollars" → wetext TN (Task 3), verified in spike + e2e `tts-currency`. ✓
- Abbreviations / units (`km/h`, `250g`, `3pm`, `Dr.`) → wetext TN (Task 3). ✓ "100m" ambiguity explicitly accepted (rules-only). ✓
- Missed paragraph breaks/punctuation → mistune emits `\n\n` between block elements (Task 1), preserved into synth. ✓
- Move preprocessing into the service → Tasks 4–6 (frontend + wiring); gateway stripped down in Tasks 7–8. ✓
- Keep text-delta streaming an option later → gateway still streams deltas; service buffers at flush/end. No change to delta transport. ✓

**Placeholder scan:** every code step shows concrete code; the two "read to find the construction site" steps (Task 6 Step 5, Task 8 Step 1) are grep-guided edits with the exact insertion code given.

**Type consistency:** `strip_markdown`/`strip_emoji`/`strip_pause_tags`/`Normalizer.normalize`/`TextFrontend.process`/`build_frontend` names are used identically across Tasks 1–6. `frontend` kwarg name is consistent across `SynthesisRunner`, `ConnectionSession`, `server.py`.

**Known risks flagged in-plan:** mistune AST field-name drift (Task 1 Step 6 verify), existing-test constructor fallout (Task 6 Step 7), gateway dangling refs after deletion (Task 8 Step 6), prod deploy must rebuild the service venv with new deps (Task 10 Step 1).

## Deployment note (post-merge, NOT part of this branch)

Prod (Mac mini) deploy rebuilds the local-tts venv via `setup-prod.py`. The three new deps install cleanly on Python 3.11 (verified). Prod deploy is a separate explicit approval per `feedback_never_pi_without_approval` — do NOT deploy as part of this work.
