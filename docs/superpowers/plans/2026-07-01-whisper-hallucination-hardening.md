# Whisper Hallucination Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Whisper phantom transcripts ("Thank you." on silence/noise) by decoding per **super-segment** (context-rich phrase, split only at ≥2s pauses) and adding a **safety-net gate** (RMS energy floor + Whisper's own no_speech/logprob signals + guarded hallucination-phrase list).

**Architecture:** Replace SenseVoice-era per-micro-segment decode with super-segment decode in `capabilityServices/WhisperSTTService/`. Group Silero VAD micro-segments, split only where the gap ≥ `min_pause_ms`; decode each super-segment; gate each; stitch kept ones with `[pause.N]`. Pauses land between separate decode calls → a `[pause]` boundary can never fall mid-word (edge case designed out); start/end pauses excluded by construction.

**Tech Stack:** Python 3.12, `mlx-whisper`, `numpy`, pytest. Native macOS service (Apple Silicon). Spec: `docs/superpowers/specs/2026-07-01-whisper-hallucination-hardening-design.md`.

## Global Constraints

- Service dir `capabilityServices/WhisperSTTService/`, package `whisper_stt`, venv at `.venv` (full deps installed). Ports WS 8768 / health 8769. Do NOT touch `capabilityServices/STTService/` or `gateway/**`.
- `min_pause_ms` default **2000**. Only gaps ≥ this become `[pause.N]`; shorter gaps merge into one super-segment.
- `rms_energy_floor` default **0.005** (~−46 dBFS, `rms = 10^(dBFS/20)`, float32 [-1,1]) — starting value, tuned from logs in the final task.
- `hallucination_phrases` (normalized: lowercase, punctuation stripped) seed set: `thank you`, `thank you for watching`, `thanks for watching`, `please subscribe`, `thanks for watching please subscribe`, `you`, `the`, `so`, `bye`, `see ya`, `subtitles by the amara.org community`, `谢谢观看`, `谢谢观看 下集再见`, `请订阅`, `字幕`.
- Phrase gate fires ONLY when the super-segment is also short (`duration_ms < hallucination_max_duration_ms`, default **1500**) OR quiet (`rms < rms_energy_floor * phrase_energy_multiplier`, default **2.0**) — so a real, loud "thank you" survives.
- Config rule: every tunable in `config.yaml` with inline comment + range; fail-loud, no silent defaults.
- Whisper-only: `emotion`/`event` stay `""`. `[pause.N]` inline + `pauses[]` durations preserved (only ≥ `min_pause_ms` ones).
- Pure functions (`super_segment`, `hallucination_gate`) carry unit tests (invariant logic). Run tests with the service venv: `PYTHONPATH=src ./.venv/bin/python -m pytest <file> -q`.
- SAMPLE_RATE = 16_000 everywhere.
- Git: feature branch `feature/whisper-stt-native` (already checked out). Commit per task. `type(scope): description`.
- Source `scripts/env.sh` is NOT needed (Python service); work from the service dir.

---

### Task 1: Config fields for the gate

**Files:**
- Modify: `capabilityServices/WhisperSTTService/src/whisper_stt/config.py`
- Modify: `capabilityServices/WhisperSTTService/config/config.example.yaml`
- Modify: `capabilityServices/WhisperSTTService/tests/test_whisper_config.py`
- Modify: `capabilityServices/WhisperSTTService/tests/test_config.py` (fixture needs the new keys)

**Interfaces:**
- Produces: `WhisperConfig` gains `min_pause_ms: int`, `rms_energy_floor: float`, `hallucination_phrases: tuple[str, ...]`, `hallucination_max_duration_ms: int`, `phrase_energy_multiplier: float`.

- [ ] **Step 1: Extend the failing config test**

In `tests/test_whisper_config.py`, add the new keys to the `whisper:` block in the fixture and assert them. Add to the `whisper:` YAML lines:
```
  min_pause_ms: 2000
  rms_energy_floor: 0.005
  hallucination_phrases: ["thank you", "bye"]
  hallucination_max_duration_ms: 1500
  phrase_energy_multiplier: 2.0
```
And add assertions:
```python
    assert cfg.whisper.min_pause_ms == 2000
    assert cfg.whisper.rms_energy_floor == 0.005
    assert cfg.whisper.hallucination_phrases == ("thank you", "bye")
    assert cfg.whisper.hallucination_max_duration_ms == 1500
    assert cfg.whisper.phrase_energy_multiplier == 2.0
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_whisper_config.py -q`
Expected: FAIL — `TypeError`/`ConfigError` (WhisperConfig has no `min_pause_ms`).

- [ ] **Step 3: Add fields to `WhisperConfig` and parse them**

In `config.py`, extend the dataclass:
```python
@dataclass(frozen=True)
class WhisperConfig:
    """MLX Whisper — the STT model. Hallucination guards are decode-time
    thresholds passed straight to mlx_whisper.transcribe."""

    model: str
    language: str
    no_speech_threshold: float
    logprob_threshold: float
    compression_ratio_threshold: float
    initial_prompt: str
    min_pause_ms: int
    rms_energy_floor: float
    hallucination_phrases: tuple[str, ...]
    hallucination_max_duration_ms: int
    phrase_energy_multiplier: float
```

Add a list helper near `_require` in `config.py`:
```python
def _require_str_list(section: dict[str, Any], path: str) -> tuple[str, ...]:
    """Pull a required list-of-strings leaf at ``path`` as a tuple."""
    key = path.rsplit(".", 1)[-1]
    if key not in section:
        raise ConfigError(f"config.yaml: missing required key '{path}'")
    value = section[key]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ConfigError(
            f"config.yaml: '{path}' must be a list of strings, got {type(value).__name__}"
        )
    return tuple(value)
```

Extend the `whisper=WhisperConfig(...)` constructor block in `_parse`:
```python
        whisper=WhisperConfig(
            model=_require(whisper_raw, "whisper.model", str),
            language=_require(whisper_raw, "whisper.language", str),
            no_speech_threshold=_require(whisper_raw, "whisper.no_speech_threshold", float),
            logprob_threshold=_require(whisper_raw, "whisper.logprob_threshold", float),
            compression_ratio_threshold=_require(
                whisper_raw, "whisper.compression_ratio_threshold", float
            ),
            initial_prompt=_require(whisper_raw, "whisper.initial_prompt", str),
            min_pause_ms=_require(whisper_raw, "whisper.min_pause_ms", int),
            rms_energy_floor=_require(whisper_raw, "whisper.rms_energy_floor", float),
            hallucination_phrases=_require_str_list(whisper_raw, "whisper.hallucination_phrases"),
            hallucination_max_duration_ms=_require(
                whisper_raw, "whisper.hallucination_max_duration_ms", int
            ),
            phrase_energy_multiplier=_require(
                whisper_raw, "whisper.phrase_energy_multiplier", float
            ),
        ),
```

- [ ] **Step 4: Run the config test to verify it passes**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_whisper_config.py -q`
Expected: PASS.

- [ ] **Step 5: Add the keys to `config/config.example.yaml`**

In the `whisper:` block, after `initial_prompt: ""`, add the block from the spec §5 (verbatim — `min_pause_ms`, `rms_energy_floor` with the dBFS comment, `hallucination_phrases` full EN+zh list, `hallucination_max_duration_ms`, `phrase_energy_multiplier`, each with its inline comment).

- [ ] **Step 6: Fix the copied `tests/test_config.py` fixture**

`tests/test_config.py` has a `whisper:` fixture block that now lacks the new required keys → it will fail loud. Add the same 5 keys to its `whisper:` fixture (values: `min_pause_ms: 2000`, `rms_energy_floor: 0.005`, `hallucination_phrases: []`, `hallucination_max_duration_ms: 1500`, `phrase_energy_multiplier: 2.0`). Run `PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_config.py tests/test_whisper_config.py -q` → all pass.

- [ ] **Step 7: Commit**

```bash
git add capabilityServices/WhisperSTTService/src/whisper_stt/config.py \
        capabilityServices/WhisperSTTService/config/config.example.yaml \
        capabilityServices/WhisperSTTService/tests/test_whisper_config.py \
        capabilityServices/WhisperSTTService/tests/test_config.py
git commit -m "feat(whisper-stt): add hallucination-gate config fields"
```

---

### Task 2: Surface no_speech_prob + avg_logprob from Whisper

**Files:**
- Modify: `capabilityServices/WhisperSTTService/src/whisper_stt/whisper_mlx.py`
- Test: `capabilityServices/WhisperSTTService/tests/test_whisper_signals.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TranscriptResult` gains `no_speech_prob: float`, `avg_logprob: float`. New pure helper `_extract_signals(result: dict) -> tuple[float, float]`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_whisper_signals.py`:
```python
"""Whisper signal extraction: worst-case no_speech_prob / avg_logprob."""
from __future__ import annotations

from whisper_stt.whisper_mlx import _extract_signals


def test_extract_worst_case_across_segments() -> None:
    result = {"segments": [
        {"no_speech_prob": 0.2, "avg_logprob": -0.3},
        {"no_speech_prob": 0.8, "avg_logprob": -1.5},
    ]}
    no_speech, logprob = _extract_signals(result)
    assert no_speech == 0.8   # max (worst)
    assert logprob == -1.5    # min (worst)


def test_extract_empty_segments_treated_as_no_speech() -> None:
    no_speech, logprob = _extract_signals({"segments": []})
    assert no_speech == 1.0
    assert logprob == -10.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_whisper_signals.py -q`
Expected: FAIL — `ImportError: cannot import name '_extract_signals'`.

- [ ] **Step 3: Add the helper + fields**

In `whisper_mlx.py`, add constants + helper before the class:
```python
_EMPTY_NO_SPEECH_PROB = 1.0   # no segments → treat as certain non-speech
_EMPTY_AVG_LOGPROB = -10.0    # no segments → treat as worst confidence


def _extract_signals(result: dict) -> tuple[float, float]:
    """Worst-case (no_speech_prob, avg_logprob) across Whisper's segments.

    max(no_speech_prob) and min(avg_logprob) are the pessimistic picks used by
    the hallucination gate. Empty/absent segments → treated as non-speech.
    """
    segs = result.get("segments") or []
    if not segs:
        return _EMPTY_NO_SPEECH_PROB, _EMPTY_AVG_LOGPROB
    no_speech = max(float(s.get("no_speech_prob", 0.0)) for s in segs)
    logprob = min(float(s.get("avg_logprob", 0.0)) for s in segs)
    return no_speech, logprob
```

Add the two fields to `TranscriptResult`:
```python
@dataclass
class TranscriptResult:
    text: str
    emotion: str
    event: str
    decode_ms: float
    audio_seconds: float
    no_speech_prob: float
    avg_logprob: float
```

In `transcribe`, after computing `decode_ms`, extract + return them:
```python
        decode_ms = (time.monotonic() - t0) * 1000.0
        no_speech_prob, avg_logprob = _extract_signals(result)
        return TranscriptResult(
            text=(result.get("text") or "").strip(),
            emotion="",
            event="",
            decode_ms=decode_ms,
            audio_seconds=audio_seconds,
            no_speech_prob=no_speech_prob,
            avg_logprob=avg_logprob,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_whisper_signals.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/WhisperSTTService/src/whisper_stt/whisper_mlx.py \
        capabilityServices/WhisperSTTService/tests/test_whisper_signals.py
git commit -m "feat(whisper-stt): surface no_speech_prob + avg_logprob from decode"
```

---

### Task 3: Super-segment grouping (pure)

**Files:**
- Create: `capabilityServices/WhisperSTTService/src/whisper_stt/super_segment.py`
- Test: `capabilityServices/WhisperSTTService/tests/test_super_segment.py`

**Interfaces:**
- Produces: `group_super_segments(segments: list[np.ndarray], gaps_ms: list[int], min_pause_ms: int) -> tuple[list[np.ndarray], list[int]]` — returns (super-segment audios, pause durations ≥ min_pause_ms between them, in order).

- [ ] **Step 1: Write the failing test**

Create `tests/test_super_segment.py`:
```python
"""Super-segment grouping: split only at gaps >= min_pause_ms."""
from __future__ import annotations

import numpy as np

from whisper_stt.super_segment import group_super_segments


def _seg(val: int, n: int = 4) -> np.ndarray:
    return np.full(n, float(val), dtype=np.float32)


def test_merge_short_split_long() -> None:
    segs = [_seg(0), _seg(1), _seg(2), _seg(3)]
    supers, pauses = group_super_segments(segs, [500, 2500, 300], min_pause_ms=2000)
    assert len(supers) == 2
    assert supers[0].tolist() == [0, 0, 0, 0, 1, 1, 1, 1]   # s0+s1
    assert supers[1].tolist() == [2, 2, 2, 2, 3, 3, 3, 3]   # s2+s3
    assert pauses == [2500]


def test_single_segment_no_pause() -> None:
    supers, pauses = group_super_segments([_seg(0)], [], min_pause_ms=2000)
    assert len(supers) == 1
    assert pauses == []


def test_all_short_gaps_merge_to_one() -> None:
    supers, pauses = group_super_segments([_seg(0), _seg(1), _seg(2)], [300, 400], min_pause_ms=2000)
    assert len(supers) == 1
    assert pauses == []


def test_empty() -> None:
    supers, pauses = group_super_segments([], [], min_pause_ms=2000)
    assert supers == []
    assert pauses == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_super_segment.py -q`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `super_segment.py`**

```python
"""Group Silero VAD micro-segments into super-segments.

A super-segment is a run of micro-segments separated only by SHORT gaps
(< min_pause_ms). A gap >= min_pause_ms is a real mid-turn pause: it splits
super-segments and becomes a [pause.N] downstream. Merging short-gap micro-
segments gives Whisper whole-phrase context (and re-joins VAD's mid-word
over-splits), which is what stops short-clip hallucination.
"""

from __future__ import annotations

import numpy as np


def group_super_segments(
    segments: list[np.ndarray],
    gaps_ms: list[int],
    min_pause_ms: int,
) -> tuple[list[np.ndarray], list[int]]:
    """Return (super-segment audios, inter-super-segment pause durations).

    ``gaps_ms[i]`` is the silence between ``segments[i]`` and ``segments[i+1]``.
    A gap >= ``min_pause_ms`` splits; shorter gaps merge. ``pauses`` holds the
    splitting gap durations in order, len == len(super_segments) - 1.
    Defensive: tolerates ``len(gaps_ms) != len(segments) - 1``.
    """
    if not segments:
        return [], []
    groups: list[list[np.ndarray]] = [[segments[0]]]
    pauses: list[int] = []
    for i in range(len(segments) - 1):
        gap = gaps_ms[i] if i < len(gaps_ms) else 0
        if gap >= min_pause_ms:
            groups.append([segments[i + 1]])
            pauses.append(gap)
        else:
            groups[-1].append(segments[i + 1])
    supers = [np.concatenate(g) for g in groups]
    return supers, pauses
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_super_segment.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/WhisperSTTService/src/whisper_stt/super_segment.py \
        capabilityServices/WhisperSTTService/tests/test_super_segment.py
git commit -m "feat(whisper-stt): super-segment grouping (split at >= min_pause_ms)"
```

---

### Task 4: Hallucination gate (pure)

**Files:**
- Create: `capabilityServices/WhisperSTTService/src/whisper_stt/hallucination_gate.py`
- Test: `capabilityServices/WhisperSTTService/tests/test_hallucination_gate.py`

**Interfaces:**
- Consumes: `WhisperConfig` (Task 1).
- Produces: `rms_of(audio: np.ndarray) -> float`; `GateResult(drop: bool, reason: str)`; `evaluate(text: str, *, rms: float, no_speech_prob: float, avg_logprob: float, duration_ms: float, cfg: WhisperConfig) -> GateResult`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_hallucination_gate.py`:
```python
"""Hallucination gate: drop noise/phantom super-segments, keep real speech."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from whisper_stt.hallucination_gate import evaluate, rms_of


@dataclass
class _Cfg:
    no_speech_threshold: float = 0.6
    logprob_threshold: float = -1.0
    rms_energy_floor: float = 0.005
    hallucination_phrases: tuple[str, ...] = ("thank you", "you", "bye")
    hallucination_max_duration_ms: int = 1500
    phrase_energy_multiplier: float = 2.0


def test_rms_of_silence_is_zero() -> None:
    assert rms_of(np.zeros(100, dtype=np.float32)) == 0.0


def test_drop_low_energy() -> None:
    r = evaluate("Yeah", rms=0.001, no_speech_prob=0.1, avg_logprob=-0.2,
                 duration_ms=600, cfg=_Cfg())
    assert r.drop and r.reason == "low_energy"


def test_drop_no_speech() -> None:
    r = evaluate("noise", rms=0.05, no_speech_prob=0.9, avg_logprob=-2.0,
                 duration_ms=1000, cfg=_Cfg())
    assert r.drop and r.reason == "no_speech"


def test_drop_phrase_short() -> None:
    r = evaluate("Thank you.", rms=0.05, no_speech_prob=0.1, avg_logprob=-0.2,
                 duration_ms=800, cfg=_Cfg())
    assert r.drop and r.reason == "hallucination_phrase"


def test_keep_phrase_long_and_loud() -> None:
    r = evaluate("thank you", rms=0.05, no_speech_prob=0.1, avg_logprob=-0.2,
                 duration_ms=1800, cfg=_Cfg())
    assert not r.drop


def test_keep_real_speech() -> None:
    r = evaluate("how about tomorrow", rms=0.05, no_speech_prob=0.1,
                 avg_logprob=-0.2, duration_ms=1400, cfg=_Cfg())
    assert not r.drop
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_hallucination_gate.py -q`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `hallucination_gate.py`**

```python
"""Safety-net gate: drop hallucinated / noise super-segments.

Whisper hallucinates plausible filler on short or near-silent audio. A super-
segment is dropped when it is (1) too quiet (RMS floor — phrase-agnostic), or
(2) Whisper's own signals say non-speech (no_speech_prob AND avg_logprob), or
(3) it exactly matches a known filler-hallucination phrase AND is short or quiet
(so a real, loud phrase survives).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .config import WhisperConfig

# Unicode-aware: strip everything that is not a word char or whitespace.
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


@dataclass
class GateResult:
    drop: bool
    reason: str


def rms_of(audio: np.ndarray) -> float:
    """Root-mean-square amplitude of float32 audio. 0.0 for empty."""
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))


def _normalize(text: str) -> str:
    return _PUNCT_RE.sub("", text).strip().lower()


def evaluate(
    text: str,
    *,
    rms: float,
    no_speech_prob: float,
    avg_logprob: float,
    duration_ms: float,
    cfg: "WhisperConfig",
) -> GateResult:
    """Decide whether to drop this super-segment as a hallucination/noise."""
    if rms < cfg.rms_energy_floor:
        return GateResult(True, "low_energy")
    if no_speech_prob > cfg.no_speech_threshold and avg_logprob < cfg.logprob_threshold:
        return GateResult(True, "no_speech")
    norm = _normalize(text)
    phrases = {_normalize(p) for p in cfg.hallucination_phrases}
    if norm in phrases:
        short = duration_ms < cfg.hallucination_max_duration_ms
        quiet = rms < cfg.rms_energy_floor * cfg.phrase_energy_multiplier
        if short or quiet:
            return GateResult(True, "hallucination_phrase")
    return GateResult(False, "")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_hallucination_gate.py -q`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/WhisperSTTService/src/whisper_stt/hallucination_gate.py \
        capabilityServices/WhisperSTTService/tests/test_hallucination_gate.py
git commit -m "feat(whisper-stt): hallucination safety-net gate (energy/no_speech/phrase)"
```

---

### Task 5: Turn decoder — group, decode, gate, stitch

**Files:**
- Create: `capabilityServices/WhisperSTTService/src/whisper_stt/turn_decoder.py`
- Delete: `capabilityServices/WhisperSTTService/src/whisper_stt/segment_decoder.py`
- Test: `capabilityServices/WhisperSTTService/tests/test_turn_decoder.py`

**Interfaces:**
- Consumes: `group_super_segments` (Task 3), `evaluate`/`rms_of` (Task 4), `WhisperMlx.transcribe -> TranscriptResult` (Task 2), `WhisperConfig` (Task 1).
- Produces: `StitchedResult(text, emotion, event, total_decode_ms, total_audio_seconds, pauses)`; `decode_turn(stt, segments, gaps_ms, *, cfg, logger, turn_idx) -> StitchedResult`. Replaces `decode_segments_and_stitch`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_turn_decoder.py` (uses a fake stt — no model needed):
```python
"""decode_turn: group -> decode -> gate -> stitch with [pause.N]."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from whisper_stt.turn_decoder import decode_turn
from whisper_stt.whisper_mlx import TranscriptResult


@dataclass
class _Cfg:
    no_speech_threshold: float = 0.6
    logprob_threshold: float = -1.0
    rms_energy_floor: float = 0.0          # 0 => energy never drops (isolate stitch)
    hallucination_phrases: tuple[str, ...] = ("thank you",)
    hallucination_max_duration_ms: int = 1500
    phrase_energy_multiplier: float = 2.0


class _FakeStt:
    """Returns canned transcripts in call order."""
    def __init__(self, texts: list[str]) -> None:
        self._texts = texts
        self._i = 0

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        t = self._texts[self._i]
        self._i += 1
        return TranscriptResult(text=t, emotion="", event="",
                                decode_ms=1.0, audio_seconds=audio.size / 16000,
                                no_speech_prob=0.1, avg_logprob=-0.2)


def _seg(n: int = 32000) -> np.ndarray:   # ~2s of non-silent audio
    return np.full(n, 0.1, dtype=np.float32)


def test_two_supersegments_one_pause() -> None:
    stt = _FakeStt(["how about tomorrow", "and the day after"])
    r = decode_turn(stt, [_seg(), _seg()], [2500], cfg=_Cfg(), logger=None, turn_idx=0)
    assert r.text == "how about tomorrow [pause.0] and the day after"
    assert r.pauses == [2500]


def test_single_supersegment_no_pause() -> None:
    stt = _FakeStt(["what's the weather"])
    r = decode_turn(stt, [_seg()], [], cfg=_Cfg(), logger=None, turn_idx=0)
    assert r.text == "what's the weather"
    assert r.pauses == []


def test_dropped_phantom_supersegment_yields_rejected_empty() -> None:
    # single short quiet phantom -> phrase gate drops -> empty
    cfg = _Cfg(rms_energy_floor=0.0)
    stt = _FakeStt(["Thank you."])
    short = np.full(8000, 0.001, dtype=np.float32)  # ~0.5s, quiet
    r = decode_turn(stt, [short], [], cfg=cfg, logger=None, turn_idx=0)
    assert r.text == ""


def test_middle_drop_collapses_pauses() -> None:
    # real, phantom(dropped), real -> one pause between the two kept, summed
    cfg = _Cfg(rms_energy_floor=0.0)
    stt = _FakeStt(["hello there", "thank you", "goodbye now"])
    quiet_short = np.full(8000, 0.001, dtype=np.float32)
    r = decode_turn(stt, [_seg(), quiet_short, _seg()], [2100, 2200],
                    cfg=cfg, logger=None, turn_idx=0)
    assert r.text == "hello there [pause.0] goodbye now"
    assert r.pauses == [4300]   # 2100 + 2200 collapsed
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_turn_decoder.py -q`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `turn_decoder.py`**

```python
"""Whole-turn (super-segment) Whisper decode with hallucination gating.

Replaces the SenseVoice-era per-micro-segment decoder. Groups micro-segments
into super-segments (split only at gaps >= min_pause_ms), decodes each with
Whisper, drops hallucinated/noise super-segments via the safety-net gate, and
stitches survivors with [pause.N]. Pauses land BETWEEN decode calls, so a
boundary can never fall mid-word; leading/trailing pauses drop by construction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from .hallucination_gate import evaluate, rms_of
from .super_segment import group_super_segments

if TYPE_CHECKING:
    from .config import WhisperConfig
    from .event_logger import JsonlLogger
    from .whisper_mlx import WhisperMlx

SAMPLE_RATE = 16_000


@dataclass
class StitchedResult:
    text: str            # "super0 [pause.0] super1 ..."
    emotion: str         # always "" (Whisper has no acoustic tags)
    event: str           # always ""
    total_decode_ms: float
    total_audio_seconds: float
    pauses: list[int] = field(default_factory=list)


def _stitch(kept_texts: list[str], kept: list[bool], pauses: list[int]) -> tuple[str, list[int]]:
    """Join kept super-segment texts with [pause.N].

    A pause is emitted only between two consecutive KEPT super-segments; gaps
    around dropped ones collapse into the next emitted pause; leading/trailing
    gaps are dropped (never emitted).
    """
    parts: list[str] = []
    out_pauses: list[int] = []
    pending_gap = 0
    seen_kept = False
    for i in range(len(kept_texts)):
        if kept[i]:
            if seen_kept:
                out_pauses.append(pending_gap)
                parts.append(f"[pause.{len(out_pauses) - 1}]")
            parts.append(kept_texts[i])
            seen_kept = True
            pending_gap = 0
        if i < len(pauses) and seen_kept:
            pending_gap += pauses[i]
    return " ".join(p for p in parts if p), out_pauses


def decode_turn(
    stt: "WhisperMlx",
    segments: list[np.ndarray],
    gaps_ms: list[int],
    *,
    cfg: "WhisperConfig",
    logger: "JsonlLogger | None" = None,
    turn_idx: int = 0,
) -> StitchedResult:
    """Group -> per-super-segment decode+gate -> stitch survivors."""
    supers, pauses = group_super_segments(segments, gaps_ms, cfg.min_pause_ms)

    kept_texts: list[str] = []
    kept: list[bool] = []
    total_decode_ms = 0.0
    total_audio_seconds = 0.0

    for idx, audio in enumerate(supers):
        r = stt.transcribe(audio)
        rms = rms_of(audio)
        duration_ms = (audio.size / SAMPLE_RATE) * 1000.0
        gate = evaluate(
            r.text, rms=rms, no_speech_prob=r.no_speech_prob,
            avg_logprob=r.avg_logprob, duration_ms=duration_ms, cfg=cfg,
        )
        total_decode_ms += r.decode_ms
        total_audio_seconds += r.audio_seconds
        text = r.text.strip()
        # Kept only if the gate passed AND there is actual content.
        is_kept = (not gate.drop) and bool(text)
        kept.append(is_kept)
        kept_texts.append(text if is_kept else "")
        if logger is not None:
            logger.log(
                "whisper.super_decode",
                turn_idx=turn_idx,
                super_idx=idx,
                text=text,
                rms=round(rms, 5),
                no_speech_prob=round(r.no_speech_prob, 4),
                avg_logprob=round(r.avg_logprob, 4),
                duration_ms=round(duration_ms, 1),
                decode_ms=round(r.decode_ms, 1),
                dropped=(not is_kept),
                reason=gate.reason if gate.drop else ("empty" if not text else ""),
            )

    text, out_pauses = _stitch(kept_texts, kept, pauses)
    return StitchedResult(
        text=text,
        emotion="",
        event="",
        total_decode_ms=total_decode_ms,
        total_audio_seconds=total_audio_seconds,
        pauses=out_pauses,
    )
```

Then `git rm src/whisper_stt/segment_decoder.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd capabilityServices/WhisperSTTService && PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_turn_decoder.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/WhisperSTTService/src/whisper_stt/turn_decoder.py \
        capabilityServices/WhisperSTTService/tests/test_turn_decoder.py
git rm capabilityServices/WhisperSTTService/src/whisper_stt/segment_decoder.py
git commit -m "feat(whisper-stt): super-segment turn decoder replaces per-segment decode"
```

---

### Task 6: Wire the finalizer + pipeline to the turn decoder

**Files:**
- Modify: `capabilityServices/WhisperSTTService/src/whisper_stt/turn_finalizer.py`
- Modify: `capabilityServices/WhisperSTTService/src/whisper_stt/turn_pipeline.py`

**Interfaces:**
- Consumes: `decode_turn`, `StitchedResult` (Task 5).
- Produces: the service emits `transcript_ready` from super-segment decode; `TurnRejected reason="hallucination"` when all drop.

- [ ] **Step 1: Update `turn_finalizer.py` imports + decode call**

Change the import:
```python
from .segment_decoder import decode_segments_and_stitch
```
to
```python
from .turn_decoder import decode_turn
```

Change the finalizer signature: replace the `pauses: PauseTracker` param usage for decode with a `gaps_ms: list[int]` param plus keep `pauses` for durations. Concretely, in `finalize_turn`, replace the Step-1 decode block:
```python
    # --- Step 1: STT decode (we need text before we can gate) ---
    pauses_ms = pauses.durations_ms()
    stitched = decode_segments_and_stitch(
        stt,
        speech_segments,
        pause_count=len(pauses_ms),
        logger=logger,
        turn_idx=turn_idx,
    )
```
with:
```python
    # --- Step 1: STT decode (super-segment group + gate) ---
    gaps_ms = pauses.durations_ms()
    stitched = decode_turn(
        stt,
        speech_segments,
        gaps_ms,
        cfg=config_whisper,
        logger=logger,
        turn_idx=turn_idx,
    )
    pauses_ms = stitched.pauses   # only >= min_pause_ms gaps survive as pauses
```
Add a `config_whisper: WhisperConfig` parameter to `finalize_turn` (import `WhisperConfig`), OR pass the already-available whisper config. (The finalizer currently receives `recordings_config` + `min_speech_duration_ms`; add `config_whisper` alongside.)

- [ ] **Step 2: Update the content-gate reason in `turn_finalizer.py`**

The Step-2 empty-content gate stays (backstop). When it rejects because super-segment gating emptied everything, use a clearer reason. Change:
```python
    if not _has_content(stitched.text):
```
to keep the same condition but set the rejection reason to `"hallucination"` when the input had segments (all dropped) vs `"empty_transcript"` otherwise:
```python
    if not _has_content(stitched.text):
        reason = "hallucination" if speech_segments else "empty_transcript"
```
and use `reason` in the `TurnRejected(...)` + log. (If the code already hardcodes `"empty_transcript"`, replace with the `reason` variable.)

- [ ] **Step 3: Pass whisper config + drop the now-unused `pause_count` plumbing in `turn_pipeline.py`**

In `turn_pipeline.py`'s `_finalize_turn`, the `finalize_turn(...)` call passes `pauses=self._pauses` and `stt=self._stt`. Add `config_whisper=self._config.whisper` to that call. (`self._config` is the full `Config`; `.whisper` is the `WhisperConfig`.) No other pipeline change — `speech_segments` + `pauses` already flow through.

- [ ] **Step 4: Verify the service imports cleanly**

Run:
```bash
cd capabilityServices/WhisperSTTService
PYTHONPATH=src ./.venv/bin/python -c "import whisper_stt.server, whisper_stt.turn_finalizer, whisper_stt.turn_pipeline, whisper_stt.turn_decoder; print('imports ok')"
grep -rn "segment_decoder\|decode_segments_and_stitch" src/ && echo "STRAGGLER" || echo "no stragglers"
PYTHONPATH=src ./.venv/bin/python -m pytest tests/ -q -k "config or signals or super_segment or hallucination or turn_decoder"
```
Expected: `imports ok`, `no stragglers`, all listed tests pass. (Do NOT run `test_opus_decoder` — needs system libopus.)

- [ ] **Step 5: Commit**

```bash
git add capabilityServices/WhisperSTTService/src/whisper_stt/turn_finalizer.py \
        capabilityServices/WhisperSTTService/src/whisper_stt/turn_pipeline.py
git commit -m "feat(whisper-stt): wire finalizer/pipeline to super-segment decoder"
```

---

### Task 7: Live verification + floor tuning

**Files:** none (runtime verification + a possible config tune in the host config).

**Interfaces:** consumes the running native service + `scripts/ws_smoke.py`.

- [ ] **Step 1: Seed the host config with the new keys + restart**

The running service reads `~/.sentient/whisper-stt/config/config.yaml`. Re-seed it from the updated example (preserving any custom model), then restart:
```bash
cd /Users/kevinye/Development/sentient
cp capabilityServices/WhisperSTTService/config/config.example.yaml ~/.sentient/whisper-stt/config/config.yaml
deploy/mac-prod/native/whisper-stt.sh stop; deploy/mac-prod/native/whisper-stt.sh start
for i in $(seq 1 60); do curl -s --max-time 2 http://127.0.0.1:8769/health && break; sleep 2; done
```
Expected: health `{"status":"ok",...}`.

- [ ] **Step 2: Regression — real utterance still transcribes**

```bash
cd capabilityServices/WhisperSTTService
PYTHONPATH=src ./.venv/bin/python scripts/ws_smoke.py --mp3 ~/Development/record-weather.mp3 --expect weather
```
Expected: `[smoke] PASS` (transcript contains "weather"). Confirms the super-segment path didn't break real speech.

- [ ] **Step 3: Silence/noise — no phantom**

```bash
cd capabilityServices/WhisperSTTService
head -c 96000 /dev/zero > /tmp/sil.raw   # ~3s silence @16k s16le
ffmpeg -nostdin -loglevel error -f s16le -ar 16000 -ac 1 -i /tmp/sil.raw /tmp/sil.wav
PYTHONPATH=src ./.venv/bin/python scripts/ws_smoke.py --mp3 /tmp/sil.wav --expect "" ; echo "exit=$?"
```
Expected: no `transcript_ready` with phantom text; the conn log shows `whisper.super_decode … dropped=true` and/or `turn.rejected reason=hallucination`.

- [ ] **Step 4: Measure + tune the floor from logs**

```bash
L=$(ls -t ~/.sentient/whisper-stt/logs/conn_*.jsonl | head -1)
grep "whisper.super_decode" "$L" | python3 -c "import sys,json
for l in sys.stdin:
    e=json.loads(l); print('rms=',e.get('rms'),'no_speech=',e.get('no_speech_prob'),'logprob=',e.get('avg_logprob'),'dur=',e.get('duration_ms'),'drop=',e.get('dropped'),'text=',repr(e.get('text'))[:40])"
```
Compare the `rms` of real speech (from Step 2) vs silence/noise (Step 3). If real speech `rms` is comfortably above `0.005` and noise below, the default holds. If a phantom slipped with `rms` just above 0.005, raise `rms_energy_floor` in `~/.sentient/whisper-stt/config/config.yaml` toward 0.008 (and mirror the final value into `config/config.example.yaml` in the repo, committing it) — restart + re-run Steps 2–3. Record the chosen value + the measured clusters in the task report.

- [ ] **Step 5: Commit any tuned default + hand off**

```bash
cd /Users/kevinye/Development/sentient
git add capabilityServices/WhisperSTTService/config/config.example.yaml 2>/dev/null
git commit -m "chore(whisper-stt): set rms_energy_floor from measured clusters" || echo "no tune needed (default held)"
```
Then post the handoff: real utterance transcribes, silence/noise produces no phantom, floor value + evidence recorded. Ask the user to voice-test the webui — speak normally, then stay silent after a reply, and confirm no phantom "Thank you." (Restart the stack's gateway is NOT required — the STT service is native + independent; only `whisper-stt.sh` restarts matter.)

---

## Self-Review

**Spec coverage:**
- §2 super-segment decode → Task 3 (grouping) + Task 5 (decode/stitch). ✓
- §3 safety-net gate (energy/no_speech+logprob/guarded phrase) → Task 2 (signals) + Task 4 (gate) + Task 5 (applied per super-segment). ✓
- §4 files: whisper_mlx (T2), super_segment (T3), hallucination_gate (T4), turn_decoder replaces segment_decoder (T5), turn_finalizer + turn_pipeline (T6), config (T1). ✓
- §5 config knobs → Task 1 + example in T1 Step 5. ✓
- §6 edge cases: 1-seg/no-pause (T5 test), all-merge (T3 test), one-pause (T5 test), start/end drop (by construction, T5 `_stitch`), middle-drop collapse (T5 test), all-dropped→rejected (T5 test + T6 reason). ✓
- §7 test matrix: unit (T3/T4/T5), smoke-happy/silence (T7), pause-marker (T5 unit covers stitch; live synthetic optional), webui (T7 handoff). ✓
- §8 floor tuning → Task 7 Step 4. ✓

**Placeholder scan:** No TBD/TODO. Every step has concrete code/commands. `rms_energy_floor 0.005` is an explicit measured-start value tuned in T7.

**Type consistency:** `WhisperConfig` fields (T1) consumed by `evaluate` (T4) + `decode_turn` (T5) + `finalize_turn` (T6). `TranscriptResult(+no_speech_prob,+avg_logprob)` (T2) consumed by `decode_turn` (T5) + the T5 fake stt. `StitchedResult(text, emotion, event, total_decode_ms, total_audio_seconds, pauses)` (T5) consumed by `turn_finalizer` (T6) — matches the fields the finalizer already reads (`.text`, `.total_decode_ms`, `.total_audio_seconds`, `.pauses`). `group_super_segments`/`evaluate`/`rms_of` signatures consistent across T3/T4/T5.
