# Whisper-STT Native Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native macOS (Metal/MLX) Whisper STT service alongside the existing Docker SenseVoice one, reusing the Silero VAD + Smart-Turn v3 turn pipeline, and make the gateway's STT backend operator-selectable.

**Architecture:** Duplicate `capabilityServices/STTService/` → `capabilityServices/WhisperSTTService/`. Keep the whole pipeline (Silero VAD → Smart-Turn v3 → per-segment decode → `[pause.N]` stitch) verbatim; swap only the STT box (SenseVoice → MLX Whisper `large-v3-turbo-8bit`). Run it in a Python venv under launchd (not Docker). The gateway stays in Docker and dials the native service over `host.docker.internal`; a config selector picks docker-SenseVoice vs native-Whisper.

**Tech Stack:** Python 3.12, `mlx` + `mlx-whisper` (Apple-Silicon Metal), `silero-vad` (torch), `onnxruntime` (Smart-Turn), `websockets`, launchd, ffmpeg (test harness only). Gateway: Bun/TypeScript (config-only changes).

## Global Constraints

- **Model pin:** `mlx-community/whisper-large-v3-turbo-8bit` (config-swappable via `whisper.model`). No benchmark matrix.
- **Whisper-only:** drop SenseVoice emotion/audio-event tags. **Keep** `[pause.N]` (VAD-timing derived). Content gate becomes text-only.
- **Ports:** Whisper-STT WS `8768`, health HTTP `8769`. (SenseVoice keeps `8766`/`8767`.)
- **Native only:** no Dockerfile for this service. Apple-Silicon only; SenseVoice-in-Docker remains the portable fallback.
- **Config rule:** every tunable lives in `config.yaml` with an inline comment + range. No magic numbers in source. Service fails loud on missing keys.
- **Logging rule:** tagged logger already in place (`logging.getLogger("stt-service")` / JsonlLogger). Never log raw audio/transcript beyond the existing truncated previews.
- **Input codec:** the gateway already sends PCM16 LE mono @ 16 kHz — Whisper-native. No runtime resampling in the service. The Phase-2 harness resamples its 48 kHz mp3 to 16 kHz with ffmpeg *before* sending.
- **Prod safety:** all validation runs against the LOCAL stack. Deploying to the prod Mac mini is a separate explicit approval. Never Playwright/Maestro against prod.
- **Git:** feature branch `feature/whisper-stt-native` (already created). Commit after each task. `type(scope): description`.
- **Test doctrine:** keep only defensive tests (config-contract parse, the WS wire gate). Do NOT add unit tests for pure helpers, DI wiring, or constants.
- **Env before shell:** run `source scripts/env.sh` before any repo shell command that needs `bun`.

---

### Task 1: Scaffold WhisperSTTService by duplicating STTService

Duplicate the tree, rename the Python package `stt_service` → `whisper_stt`, strip Docker artifacts, bump identity. No behavior change yet — this commit is a faithful copy that still references SenseVoice (wired to Whisper in Task 3).

**Files:**
- Create: `capabilityServices/WhisperSTTService/**` (copied from `capabilityServices/STTService/`)
- Rename: `src/stt_service/` → `src/whisper_stt/`
- Delete: `capabilityServices/WhisperSTTService/Dockerfile`, `capabilityServices/WhisperSTTService/.dockerignore`
- Modify: `src/whisper_stt/__init__.py`, `pyproject.toml`

**Interfaces:**
- Produces: the `whisper_stt` package importable via `PYTHONPATH=capabilityServices/WhisperSTTService/src`, runnable as `python -m whisper_stt`.

- [ ] **Step 1: Copy the tree and strip Docker**

```bash
cd /Users/kevinye/Development/sentient
cp -R capabilityServices/STTService capabilityServices/WhisperSTTService
cd capabilityServices/WhisperSTTService
rm -f Dockerfile .dockerignore
git mv src/stt_service src/whisper_stt
```

- [ ] **Step 2: Rewrite `src/whisper_stt/__init__.py`**

Replace the whole file with:

```python
"""Whisper-STT — native (Apple Silicon / Metal) speech-to-text.

Silero VAD + Smart-Turn v3 + MLX Whisper (large-v3-turbo-8bit), exposed as a
WebSocket service that consumes streamed PCM16 audio and emits structured turn
events. Same wire CONTRACT as the SenseVoice STTService; text-only (no emotion/
audio-event tags). See CONTRACT.md for the protocol.
"""

__version__ = "1.0.0"
```

- [ ] **Step 3: Update `pyproject.toml` identity**

Change the project name and any `stt_service` package references to `whisper-stt` / `whisper_stt`. Run:

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
sed -i '' 's/stt_service/whisper_stt/g; s/stt-service/whisper-stt/g' pyproject.toml
```

- [ ] **Step 4: Verify the package imports under the new name**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
PYTHONPATH=src python3 -c "import whisper_stt; print(whisper_stt.__version__)"
```
Expected: prints `1.0.0` (it imports `__init__.py` only — no heavy deps yet). If it errors on a submodule import, you imported too much; only `import whisper_stt` is required here.

- [ ] **Step 5: Commit**

```bash
cd /Users/kevinye/Development/sentient
git add -A capabilityServices/WhisperSTTService
git commit -m "chore(whisper-stt): scaffold service by duplicating STTService"
```

---

### Task 2: Whisper MLX backend + config

Add the MLX Whisper backend as a drop-in for SenseVoice (same `transcribe(audio) -> result` shape, emotion/event always `""`), plus the `whisper:` config section and dependency swap. This task does NOT wire it into the server yet (Task 3).

**Files:**
- Create: `src/whisper_stt/whisper_mlx.py`
- Modify: `src/whisper_stt/config.py` (add `WhisperConfig`, swap `sense_voice` → `whisper`)
- Modify: `config/config.example.yaml` (replace `sense_voice:` block with `whisper:`)
- Modify: `requirements.txt` (drop `sherpa-onnx`, add `mlx`, `mlx-whisper`)
- Test: `tests/test_whisper_config.py`

**Interfaces:**
- Produces:
  - `WhisperConfig(model: str, language: str, no_speech_threshold: float, logprob_threshold: float, compression_ratio_threshold: float, initial_prompt: str)`
  - `Config.whisper: WhisperConfig` (replaces `Config.sense_voice`)
  - `WhisperMlx(config: WhisperConfig, language: str = "auto")` with `.transcribe(audio: np.ndarray) -> TranscriptResult`, `.warm() -> None`, properties `.language`, `.model_repo`
  - `TranscriptResult(text, emotion, event, decode_ms, audio_seconds)` — `emotion`/`event` always `""`
  - `VALID_LANGUAGES = ("auto", "en", "zh")`

- [ ] **Step 1: Write the failing config test**

Create `capabilityServices/WhisperSTTService/tests/test_whisper_config.py`:

```python
"""Config-contract test: the whisper: section parses into WhisperConfig."""
from __future__ import annotations

from pathlib import Path

from whisper_stt.config import load_config


def test_whisper_section_parses(tmp_path: Path) -> None:
    cfg_text = """
schema_version: "0.1.0"
server: {host: "0.0.0.0", port: 8768, max_frame_bytes: 16777216}
vad:
  threshold: 0.5
  min_silence_ms: 200
  speech_pad_ms: 100
  pre_speech_chunks: 3
  silent_timeout_ms: 4000
  max_turn_duration_ms: 30000
  min_speech_duration_ms: 200
smart_turn: {decision_threshold: 0.5, intra_op_threads: 4}
whisper:
  model: "mlx-community/whisper-large-v3-turbo-8bit"
  language: "auto"
  no_speech_threshold: 0.6
  logprob_threshold: -1.0
  compression_ratio_threshold: 2.4
  initial_prompt: ""
recordings: {enabled: false}
logging: {level: "info", metrics_interval_ms: 1000, retention_days: 7}
"""
    p = tmp_path / "config.yaml"
    p.write_text(cfg_text)
    cfg = load_config(p, model_dir=tmp_path, log_dir=tmp_path, recording_dir=tmp_path)
    assert cfg.whisper.model == "mlx-community/whisper-large-v3-turbo-8bit"
    assert cfg.whisper.language == "auto"
    assert cfg.whisper.no_speech_threshold == 0.6
    assert cfg.whisper.compression_ratio_threshold == 2.4
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
PYTHONPATH=src python3 -m pytest tests/test_whisper_config.py -q
```
Expected: FAIL — `AttributeError`/`ConfigError` because `config.py` still parses `sense_voice`, not `whisper`.

- [ ] **Step 3: Swap the config dataclass**

In `src/whisper_stt/config.py`, replace the `SenseVoiceConfig` dataclass:

```python
@dataclass(frozen=True)
class SenseVoiceConfig:
    """SenseVoice-Small — the STT model."""

    num_threads: int
    use_itn: bool
```

with:

```python
@dataclass(frozen=True)
class WhisperConfig:
    """MLX Whisper — the STT model. Hallucination guards are decode-time
    thresholds passed straight to mlx_whisper.transcribe."""

    model: str  # HuggingFace repo id for the MLX weights
    language: str  # decode hint: "auto" | "en" | "zh"
    no_speech_threshold: float  # 0.0–1.0; drop segment above this P(no-speech)
    logprob_threshold: float  # drop segment below this avg token logprob
    compression_ratio_threshold: float  # drop segment above this gzip ratio
    initial_prompt: str  # optional domain-vocab bias; "" = none
```

In the root `Config` dataclass, change the field:

```python
    sense_voice: SenseVoiceConfig
```
to
```python
    whisper: WhisperConfig
```

In `_parse`, change the section fetch:

```python
    sense_voice_raw = _require_section(raw, "sense_voice")
```
to
```python
    whisper_raw = _require_section(raw, "whisper")
```

and replace the `sense_voice=SenseVoiceConfig(...)` constructor block:

```python
        sense_voice=SenseVoiceConfig(
            num_threads=_require(sense_voice_raw, "sense_voice.num_threads", int),
            use_itn=_require(sense_voice_raw, "sense_voice.use_itn", bool),
        ),
```
with:
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
        ),
```

- [ ] **Step 4: Run the config test to verify it passes**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
PYTHONPATH=src python3 -m pytest tests/test_whisper_config.py -q
```
Expected: PASS.

- [ ] **Step 5: Write `src/whisper_stt/whisper_mlx.py`**

```python
"""Whisper STT via MLX (Apple Silicon / Metal).

Drop-in replacement for the SenseVoice backend. Same call shape
(``transcribe(audio_f32) -> TranscriptResult``) so the segment decoder and
turn finalizer are unchanged except that ``emotion``/``event`` are always "".

Language: mlx_whisper takes the language as a decode-time kwarg (unlike
SenseVoice, which baked it per-recognizer). We map the service "auto" sentinel
to ``None`` (whisper autodetects); "en"/"zh" pass through.

Hallucination guards: Whisper invents text on short/near-silent clips. We pass
``no_speech_threshold`` / ``logprob_threshold`` / ``compression_ratio_threshold``
to ``transcribe`` (it internally blanks failing segments) and rely on the
finalizer's existing min-duration + text-content gate.

Model loading: ``mlx_whisper.transcribe`` caches the loaded model per repo id
(``functools.lru_cache`` on its internal ``load_models``), so a per-connection
``WhisperMlx`` for the same repo shares one in-memory model. Weights are fetched
from HuggingFace on first use and cached under ~/.cache/huggingface.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import mlx_whisper
import numpy as np

from .config import WhisperConfig

SAMPLE_RATE = 16_000
AUTO_LANGUAGE = "auto"
VALID_LANGUAGES: tuple[str, ...] = ("auto", "en", "zh")


@dataclass
class TranscriptResult:
    """Outcome of one Whisper decode. emotion/event are always "" (Whisper
    produces no acoustic tags) — kept for shape-compatibility with the
    segment decoder that also serves the SenseVoice service."""

    text: str
    emotion: str
    event: str
    decode_ms: float
    audio_seconds: float


def _whisper_language(language: str) -> str | None:
    """Map the service language sentinel to a whisper decode language.

    "auto" -> None (whisper autodetects). "en"/"zh" pass through unchanged.
    """
    if language == AUTO_LANGUAGE:
        return None
    return language


class WhisperMlx:
    """One decode-language view over the MLX Whisper model.

    Constructing several instances for the same ``config.model`` is cheap —
    they share the lru-cached in-memory model; only the per-call ``language``
    kwarg differs. Mirrors the SenseVoice wrapper's constructor arg so the
    server's per-connection language wiring keeps working.
    """

    def __init__(self, *, config: WhisperConfig, language: str = AUTO_LANGUAGE) -> None:
        if language not in VALID_LANGUAGES:
            raise ValueError(
                f"WhisperMlx: unsupported language {language!r}; "
                f"must be one of {VALID_LANGUAGES}"
            )
        self._config = config
        self._language = language
        self._decode_language = _whisper_language(language)

    @property
    def language(self) -> str:
        return self._language

    @property
    def model_repo(self) -> str:
        return self._config.model

    def warm(self) -> None:
        """Force the model to load now by decoding 100 ms of silence."""
        self.transcribe(np.zeros(SAMPLE_RATE // 10, dtype=np.float32))

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        """Decode a finalized utterance. ``audio`` = 1-D float32 @ 16 kHz."""
        if audio.ndim != 1:
            raise ValueError(f"audio must be 1-D, got shape {audio.shape}")
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        audio_seconds = audio.size / SAMPLE_RATE
        t0 = time.monotonic()
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._config.model,
            language=self._decode_language,
            condition_on_previous_text=False,
            no_speech_threshold=self._config.no_speech_threshold,
            logprob_threshold=self._config.logprob_threshold,
            compression_ratio_threshold=self._config.compression_ratio_threshold,
            initial_prompt=(self._config.initial_prompt or None),
            word_timestamps=False,
            verbose=None,
        )
        decode_ms = (time.monotonic() - t0) * 1000.0
        return TranscriptResult(
            text=(result.get("text") or "").strip(),
            emotion="",
            event="",
            decode_ms=decode_ms,
            audio_seconds=audio_seconds,
        )
```

- [ ] **Step 6: Swap dependencies in `requirements.txt`**

Delete the `sherpa-onnx` block:

```
# sherpa-onnx: SenseVoice-Small runtime. Ships aarch64 wheels on PyPI and
# includes its own ONNX Runtime — coexists cleanly with the top-level
# onnxruntime that smart_turn.py uses.
sherpa-onnx>=1.10
```

and add, after the `onnxruntime` block:

```
# MLX Whisper backend (Apple Silicon / Metal). Apple-Silicon only — this
# service does not run on Linux/x86. mlx-whisper pulls mlx transitively but
# we pin both for clarity.
mlx>=0.18
mlx-whisper>=0.4
```

- [ ] **Step 7: Replace the `sense_voice:` block in `config/config.example.yaml`**

Find the block that begins with the `SenseVoice-Small` banner and the `sense_voice:` key (the section documented around "the STT model") and replace it entirely with:

```yaml
# =============================================================================
# Whisper — the STT model (MLX, Apple Silicon / Metal). Runs once per finalized
# turn (or once per speech segment when the turn has mid-turn pauses).
# =============================================================================
whisper:
  # HuggingFace repo id for the MLX Whisper weights. Fetched + cached on first
  # run under ~/.cache/huggingface. Swap to benchmark or trade RAM for quality
  # (e.g. -q4) without a code change.
  model: "mlx-community/whisper-large-v3-turbo-8bit"

  # Decode language hint: "auto" | "en" | "zh". "auto" lets Whisper detect;
  # pin en/zh for higher accuracy on short utterances that confuse autodetect.
  language: "auto"

  # Hallucination guards — passed straight to mlx_whisper.transcribe. Segments
  # failing any of these decode to "" instead of invented text.
  #   no_speech_threshold (0.0-1.0): drop a segment whose P(no-speech) exceeds
  #     this. Raise toward 0.8 if silence produces phantom words.
  no_speech_threshold: 0.6
  #   logprob_threshold: drop a segment whose average token logprob is below
  #     this. Less negative (-0.5) = stricter; more negative (-1.5) = laxer.
  logprob_threshold: -1.0
  #   compression_ratio_threshold: drop a segment whose gzip compression ratio
  #     exceeds this (catches repetition loops). 2.4 is Whisper's default.
  compression_ratio_threshold: 2.4

  # Optional domain-vocabulary bias prompt prepended to decoding. "" = none.
  initial_prompt: ""
```

- [ ] **Step 8: Commit**

```bash
cd /Users/kevinye/Development/sentient
git add -A capabilityServices/WhisperSTTService
git commit -m "feat(whisper-stt): add MLX Whisper backend + whisper config section"
```

---

### Task 3: Wire the Whisper backend into the service

Make the running service actually use Whisper: swap the server's model loading, rename the pipeline's `sense_voice` identifier to the neutral `stt`, make the content gate text-only, drop the SenseVoice model download, and point the ports/handshake at Whisper. After this task, `python -m whisper_stt` boots a working Whisper service.

**Files:**
- Modify: `src/whisper_stt/server.py`
- Modify: `src/whisper_stt/turn_pipeline.py`
- Modify: `src/whisper_stt/turn_finalizer.py`
- Modify: `src/whisper_stt/segment_decoder.py`
- Modify: `src/whisper_stt/__main__.py`
- Modify: `scripts/download_models.py`
- Delete: `src/whisper_stt/sense_voice.py`

**Interfaces:**
- Consumes (from Task 2): `WhisperMlx`, `VALID_LANGUAGES`, `Config.whisper`.
- Produces: a WS service on `server.port` (8768) + health on `8769`; `ready` handshake advertises `"stt": "whisper-large-v3-turbo-8bit"`.

- [ ] **Step 1: Delete the SenseVoice backend**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
git rm src/whisper_stt/sense_voice.py
```

- [ ] **Step 2: Rewrite `scripts/download_models.py` to fetch Smart-Turn only**

Whisper weights are fetched by mlx at runtime; Silero via torch hub. Only Smart-Turn needs a pre-fetch. Replace the whole file with:

```python
"""Download Smart-Turn v3.2 CPU ONNX weights for the native Whisper-STT service.

Whisper weights are fetched by mlx_whisper from HuggingFace at runtime (cached
under ~/.cache/huggingface); Silero VAD is fetched by torch.hub. Only Smart-Turn
needs a pre-fetch into the model dir.

Layout produced under <destination_dir>:
    smart-turn/
        smart-turn-v3.2-cpu.onnx                (~8.7 MB)

Usage:
    python scripts/download_models.py <destination_dir>
"""

import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

SMART_TURN_REPO = "pipecat-ai/smart-turn-v3"
SMART_TURN_FILENAME = "smart-turn-v3.2-cpu.onnx"


def _mib(p: Path) -> str:
    return f"{p.stat().st_size / (1024 * 1024):.2f} MiB"


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: download_models.py <destination_dir>", file=sys.stderr)
        sys.exit(2)

    dest_dir = Path(sys.argv[1]).resolve()
    smart_turn_dir = dest_dir / "smart-turn"
    smart_turn_dir.mkdir(parents=True, exist_ok=True)

    print(f"[download_models] fetching {SMART_TURN_REPO}/{SMART_TURN_FILENAME}")
    smart_turn_path = Path(
        hf_hub_download(
            repo_id=SMART_TURN_REPO,
            filename=SMART_TURN_FILENAME,
            local_dir=str(smart_turn_dir),
        )
    )
    print(f"[download_models]   -> {smart_turn_path} ({_mib(smart_turn_path)})")
    print("[download_models] all models ready")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Update `src/whisper_stt/segment_decoder.py` (rename param, drop SenseVoice import)**

Change the import:
```python
from .sense_voice import SenseVoice
```
to
```python
from .whisper_mlx import WhisperMlx
```

Change the function signature:
```python
def decode_segments_and_stitch(
    sense_voice: SenseVoice,
    segments: list[np.ndarray],
```
to
```python
def decode_segments_and_stitch(
    stt: WhisperMlx,
    segments: list[np.ndarray],
```

Change the decode call inside the loop:
```python
        r = sense_voice.transcribe(audio)
```
to
```python
        r = stt.transcribe(audio)
```

(The rest is unchanged — `emotion`/`event` flow through as `""`.)

- [ ] **Step 4: Update `src/whisper_stt/turn_finalizer.py` (text-only gate, rename param)**

Change the import:
```python
from .sense_voice import SenseVoice
```
to
```python
from .whisper_mlx import WhisperMlx
```

Delete the `_is_meaningful_event` helper entirely:
```python
def _is_meaningful_event(audio_event: str) -> bool:
    """True if the audio event tag is anything other than plain speech.

    Laughter / BGM / applause / etc. turns are kept even when the text
    content is empty, because the non-speech classification itself is
    useful signal for the downstream LLM.
    """
    if not audio_event:
        return False
    code = _TAG_RE.sub("", audio_event).strip().lower()
    return bool(code) and code != "speech"
```

Change the finalizer signature param:
```python
    sense_voice: SenseVoice,
```
to
```python
    stt: WhisperMlx,
```

Change the decode call:
```python
    stitched = decode_segments_and_stitch(
        sense_voice,
        speech_segments,
```
to
```python
    stitched = decode_segments_and_stitch(
        stt,
        speech_segments,
```

Change the content gate (Step 2 block) from:
```python
    if not _has_content(stitched.text) and not _is_meaningful_event(stitched.event):
```
to
```python
    if not _has_content(stitched.text):
```

- [ ] **Step 5: Update `src/whisper_stt/turn_pipeline.py` (rename attribute/param)**

Change the import:
```python
from .sense_voice import SenseVoice
```
to
```python
from .whisper_mlx import WhisperMlx
```

Change the constructor param + assignment (around lines 106 and 113):
```python
        sense_voice: SenseVoice,
```
to
```python
        stt: WhisperMlx,
```
and
```python
        self._sense_voice = sense_voice
```
to
```python
        self._stt = stt
```

Change the finalize call (around line 349):
```python
            sense_voice=self._sense_voice,
```
to
```python
            stt=self._stt,
```

- [ ] **Step 6: Rewrite the model wiring in `src/whisper_stt/server.py`**

(a) Change the imports:
```python
from .sense_voice import VALID_LANGUAGES, SenseVoice
```
to
```python
from .whisper_mlx import VALID_LANGUAGES, WhisperMlx
```

(b) Replace the two SenseVoice cache fields in `__init__`:
```python
        self._sense_voice_cache: dict[str, SenseVoice] = {}
        # Guards lazy-construction of extra language recognizers. Several
        # connections opening simultaneously with the same language must
        # not each build their own instance.
        self._sense_voice_lock = threading.Lock()
```
with:
```python
        # One decode-language view is built per connection (cheap — all views
        # share the lru-cached MLX model for the same repo). No per-language
        # weight reload, so no cache/lock needed.
        self._whisper_default: WhisperMlx | None = None
```

(c) Replace the SenseVoice load block in `load_models` (the `sense_voice_dir = ...` through the `self._service_log.log("models.loaded", ...)` call) with:
```python
        log.info(
            "loading MLX Whisper (%s, language=%s)...",
            self._config.whisper.model,
            DEFAULT_LANGUAGE,
        )
        self._whisper_default = WhisperMlx(
            config=self._config.whisper,
            language=DEFAULT_LANGUAGE,
        )
        self._whisper_default.warm()
        log.info("Whisper ready: %s", self._whisper_default.model_repo)

        self._service_log.log(
            "models.loaded",
            silero_backend="torch_jit",
            smart_turn_path=str(self._smart_turn.model_path),
            whisper_model=self._whisper_default.model_repo,
            whisper_default_language=DEFAULT_LANGUAGE,
        )
```

(d) Replace the entire `_get_or_load_sense_voice` method with:
```python
    def _get_whisper(self, language: str) -> WhisperMlx:
        """Return a Whisper view for ``language``. Cheap — shares the cached
        model; only the per-call decode language differs."""
        if language == DEFAULT_LANGUAGE and self._whisper_default is not None:
            return self._whisper_default
        return WhisperMlx(config=self._config.whisper, language=language)
```

(e) In `handle()`, change the assertion + acquisition:
```python
        assert DEFAULT_LANGUAGE in self._sense_voice_cache, (
            "load_models() must run before serve()"
        )
```
to
```python
        assert self._whisper_default is not None, (
            "load_models() must run before serve()"
        )
```
and
```python
        sense_voice = self._get_or_load_sense_voice(language)
```
to
```python
        stt = self._get_whisper(language)
```

(f) In the `TurnPipeline(...)` construction, change:
```python
            sense_voice=sense_voice,
```
to
```python
            stt=stt,
```

(g) In the `ready` handshake JSON, change:
```python
                    "stt": "sense-voice-small-int8",
```
to
```python
                    "stt": "whisper-large-v3-turbo-8bit",
```

(h) Change the health port constant:
```python
HEALTH_HTTP_PORT = 8767
```
to
```python
HEALTH_HTTP_PORT = 8769
```

- [ ] **Step 7: Update `src/whisper_stt/__main__.py` env-var prefix + native defaults**

Replace the four `os.environ.get(...)` path lines:
```python
    config_path = Path(os.environ.get("STT_CONFIG_PATH", "/app/config/config.yaml"))
    model_dir = Path(os.environ.get("STT_MODEL_DIR", "/app/models"))
    log_dir = Path(os.environ.get("STT_LOG_DIR", "/app/logs"))
    recording_dir = Path(os.environ.get("STT_RECORDING_DIR", "/app/data/recordings"))
```
with:
```python
    home = Path.home()
    data = home / ".sentient" / "whisper-stt"
    config_path = Path(os.environ.get("WHISPER_STT_CONFIG_PATH", str(data / "config" / "config.yaml")))
    model_dir = Path(os.environ.get("WHISPER_STT_MODEL_DIR", str(data / "models")))
    log_dir = Path(os.environ.get("WHISPER_STT_LOG_DIR", str(data / "logs")))
    recording_dir = Path(os.environ.get("WHISPER_STT_RECORDING_DIR", str(data / "recordings")))
```

- [ ] **Step 8: Verify the service imports and config parses (no model download yet)**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
python3 -m venv .venv
./.venv/bin/pip install -q -r requirements.txt
PYTHONPATH=src ./.venv/bin/python -c "import whisper_stt.server, whisper_stt.turn_pipeline, whisper_stt.turn_finalizer, whisper_stt.segment_decoder, whisper_stt.whisper_mlx; print('imports ok')"
PYTHONPATH=src ./.venv/bin/python -m pytest tests/test_whisper_config.py -q
```
Expected: `imports ok` then PASS. (First `pip install` pulls mlx/torch — a few minutes.) If an import errors on a leftover `sense_voice` reference, grep for it: `grep -rn sense_voice src/` and fix the straggler.

- [ ] **Step 9: Commit**

```bash
cd /Users/kevinye/Development/sentient
git add -A capabilityServices/WhisperSTTService
git commit -m "feat(whisper-stt): wire Whisper backend into pipeline, text-only gate, ports 8768/8769"
```

---

### Task 4: Phase-2 early TEST gate — mp3 → WS → transcript

The decisive functional gate. Start the service locally, stream `~/Development/record-weather.mp3` through the WS via a smoke script, and assert the transcript contains "weather". Also eyeball the trailing-silence case (no phantom transcript). This must pass before any deploy work.

**Files:**
- Create: `capabilityServices/WhisperSTTService/scripts/ws_smoke.py`

**Interfaces:**
- Consumes: a running Whisper-STT on `ws://127.0.0.1:8768`.

- [ ] **Step 1: Write `scripts/ws_smoke.py`**

```python
"""Phase-2 test gate: mp3 -> WS -> transcript.

Decodes an audio file to 16 kHz PCM16 mono via ffmpeg, streams it to a locally-
running Whisper-STT over the WebSocket, then asserts the transcript contains the
expected substring. Also streams trailing silence to trigger vad_end ->
Smart-Turn -> transcript_ready.

Usage:
    python scripts/ws_smoke.py \
        --url ws://127.0.0.1:8768 \
        --mp3 ~/Development/record-weather.mp3 \
        --expect weather
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

import websockets

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512  # Silero chunk granularity
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono
TAIL_SILENCE_MS = 2000  # trailing silence to trigger end-of-turn
RECV_TIMEOUT_S = 30.0


def decode_to_pcm16(src: Path) -> bytes:
    """ffmpeg-decode any audio file to raw PCM16 LE mono @ 16 kHz."""
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error",
        "-i", str(src),
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ]
    return subprocess.run(cmd, capture_output=True, check=True).stdout


async def run(url: str, src: Path, expect: str) -> int:
    pcm = decode_to_pcm16(src)
    silence = b"\x00\x00" * (SAMPLE_RATE * TAIL_SILENCE_MS // 1000)
    stream = pcm + silence

    async with websockets.connect(url, max_size=None) as ws:
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            print(f"[smoke] FAIL: expected ready, got {ready}", file=sys.stderr)
            return 1
        print(f"[smoke] ready: stt={ready.get('stt')} sr={ready.get('sampleRate')}")

        async def send_audio() -> None:
            for i in range(0, len(stream), FRAME_BYTES):
                await ws.send(stream[i:i + FRAME_BYTES])
                await asyncio.sleep(0.004)

        sender = asyncio.create_task(send_audio())
        transcript: str | None = None
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT_S)
                if isinstance(msg, (bytes, bytearray)):
                    continue  # WAV binary frame
                evt = json.loads(msg)
                etype = evt.get("type")
                if etype in ("transcript_ready", "turn_rejected", "vad_start", "vad_end"):
                    print(f"[smoke] evt: {etype} text={evt.get('text', '')!r}")
                if etype == "transcript_ready":
                    transcript = evt.get("text", "")
                    break
        finally:
            sender.cancel()

    if transcript is None:
        print("[smoke] FAIL: no transcript_ready received", file=sys.stderr)
        return 1
    ok = expect.lower() in transcript.lower()
    print(f"[smoke] transcript: {transcript!r}")
    print(f"[smoke] {'PASS' if ok else 'FAIL'}: expected substring {expect!r}")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8768")
    ap.add_argument("--mp3", default=str(Path.home() / "Development" / "record-weather.mp3"))
    ap.add_argument("--expect", default="weather")
    args = ap.parse_args()
    sys.exit(asyncio.run(run(args.url, Path(args.mp3), args.expect)))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Prepare local runtime dirs + Smart-Turn weights**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
mkdir -p ~/.sentient/whisper-stt/config ~/.sentient/whisper-stt/logs ~/.sentient/whisper-stt/models ~/.sentient/whisper-stt/recordings
cp config/config.example.yaml ~/.sentient/whisper-stt/config/config.yaml
PYTHONPATH=src ./.venv/bin/python scripts/download_models.py ~/.sentient/whisper-stt/models
```
Expected: Smart-Turn onnx downloaded, "all models ready".

- [ ] **Step 3: Start the service in the background**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
PYTHONPATH=src ./.venv/bin/python -m whisper_stt > /tmp/whisper-stt.log 2>&1 &
echo $! > /tmp/whisper-stt.pid
sleep 25   # first boot downloads the MLX weights (~0.9 GB) and warms the model
grep -E "Whisper ready|listening on ws|health endpoint" /tmp/whisper-stt.log
curl -s http://127.0.0.1:8769/health
```
Expected: `Whisper ready: mlx-community/whisper-large-v3-turbo-8bit`, `listening on ws://0.0.0.0:8768`, and `{"status":"ok","version":"1.0.0"}`.

- [ ] **Step 4: Run the smoke gate**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
PYTHONPATH=src ./.venv/bin/python scripts/ws_smoke.py --mp3 ~/Development/record-weather.mp3 --expect weather
```
Expected: prints the transcript (≈ "tell me what's the weather today") and `[smoke] PASS`. Exit code 0.

If FAIL: check `/tmp/whisper-stt.log` for `whisper.decode` / `turn.rejected`. Common causes — transcript empty (guards too strict → lower `no_speech_threshold` won't help; check the mp3 decoded to non-silent PCM: `ffmpeg -i ~/Development/record-weather.mp3 -ac 1 -ar 16000 -f s16le - | wc -c` should be ~140k bytes) or no `transcript_ready` (turn never closed → confirm trailing silence is being sent; `vad_end` should appear in the log).

- [ ] **Step 5: Verify the silence/no-phantom case**

```bash
cd /Users/kevinye/Development/sentient/capabilityServices/WhisperSTTService
head -c 64000 /dev/zero > /tmp/silence.raw
ffmpeg -nostdin -loglevel error -f s16le -ar 16000 -ac 1 -i /tmp/silence.raw /tmp/silence.wav
PYTHONPATH=src ./.venv/bin/python scripts/ws_smoke.py --mp3 /tmp/silence.wav --expect "" ; echo "exit=$?"
```
Expected: no `transcript_ready` with invented words — either no transcript (exit 1, which is acceptable here) or an empty transcript; the log shows `turn.rejected` / no hallucination. Record the observed behavior in the task notes.

- [ ] **Step 6: Stop the service**

```bash
kill "$(cat /tmp/whisper-stt.pid)" 2>/dev/null || true
```

- [ ] **Step 7: Commit**

```bash
cd /Users/kevinye/Development/sentient
git add -A capabilityServices/WhisperSTTService/scripts/ws_smoke.py
git commit -m "test(whisper-stt): add mp3->WS transcript smoke gate (Phase 2)"
```

---

### Task 5: Native launchd launcher

Package the service to run natively under launchd (survives reboot, logs to `~/.sentient/whisper-stt/logs/`). One script owns venv+deps+weights install, plist generation, and start/stop/status/logs.

**Files:**
- Create: `deploy/mac-prod/native/whisper-stt.sh`

**Interfaces:**
- Produces: `deploy/mac-prod/native/whisper-stt.sh {install|start|stop|status|logs}`; binds host `0.0.0.0:8768` / health `8769`.

- [ ] **Step 1: Write `deploy/mac-prod/native/whisper-stt.sh`**

```bash
#!/usr/bin/env bash
# Native launcher for Whisper-STT (Apple Silicon). Manages a launchd
# LaunchAgent so the service survives reboots and logs under
# ~/.sentient/whisper-stt/logs/. Whisper weights are fetched by mlx at
# runtime; only Smart-Turn is pre-downloaded here.
set -euo pipefail

LABEL="io.dev32.sentient.whisper-stt"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SVC_DIR="$REPO_ROOT/capabilityServices/WhisperSTTService"
VENV="$SVC_DIR/.venv"
DATA="$HOME/.sentient/whisper-stt"

cmd_install() {
  mkdir -p "$DATA/config" "$DATA/logs" "$DATA/recordings" "$DATA/models" "$HOME/Library/LaunchAgents"
  [ -f "$DATA/config/config.yaml" ] || cp "$SVC_DIR/config/config.example.yaml" "$DATA/config/config.yaml"
  [ -d "$VENV" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$SVC_DIR/requirements.txt"
  PYTHONPATH="$SVC_DIR/src" "$VENV/bin/python" "$SVC_DIR/scripts/download_models.py" "$DATA/models"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${VENV}/bin/python</string>
    <string>-m</string>
    <string>whisper_stt</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PYTHONPATH</key><string>${SVC_DIR}/src</string>
    <key>WHISPER_STT_CONFIG_PATH</key><string>${DATA}/config/config.yaml</string>
    <key>WHISPER_STT_MODEL_DIR</key><string>${DATA}/models</string>
    <key>WHISPER_STT_LOG_DIR</key><string>${DATA}/logs</string>
    <key>WHISPER_STT_RECORDING_DIR</key><string>${DATA}/recordings</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${DATA}/logs/launchd.err.log</string>
</dict></plist>
PLIST
  echo "installed ${PLIST}"
}

cmd_start()  { launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; echo "started ${LABEL}"; }
cmd_stop()   { launchctl unload "$PLIST" 2>/dev/null || true; echo "stopped ${LABEL}"; }
cmd_status() {
  launchctl list | grep "$LABEL" || echo "not loaded"
  curl -s http://127.0.0.1:8769/health || echo "(health unreachable)"
  echo
}
cmd_logs()   { tail -n 100 -f "$DATA/logs/launchd.err.log"; }

case "${1:-}" in
  install) cmd_install ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *) echo "usage: $0 {install|start|stop|status|logs}"; exit 2 ;;
esac
```

- [ ] **Step 2: Make it executable and install**

```bash
cd /Users/kevinye/Development/sentient
chmod +x deploy/mac-prod/native/whisper-stt.sh
deploy/mac-prod/native/whisper-stt.sh install
```
Expected: venv reused, deps present, Smart-Turn downloaded, `installed ~/Library/LaunchAgents/io.dev32.sentient.whisper-stt.plist`.

- [ ] **Step 3: Start via launchd and verify**

```bash
cd /Users/kevinye/Development/sentient
deploy/mac-prod/native/whisper-stt.sh start
sleep 25
deploy/mac-prod/native/whisper-stt.sh status
PYTHONPATH=capabilityServices/WhisperSTTService/src \
  capabilityServices/WhisperSTTService/.venv/bin/python \
  capabilityServices/WhisperSTTService/scripts/ws_smoke.py --expect weather
```
Expected: `status` shows the label loaded + `{"status":"ok",...}`; smoke prints `[smoke] PASS`.

- [ ] **Step 4: Stop (leave the box clean for the next task)**

```bash
cd /Users/kevinye/Development/sentient
deploy/mac-prod/native/whisper-stt.sh stop
```

- [ ] **Step 5: Commit**

```bash
cd /Users/kevinye/Development/sentient
git add -A deploy/mac-prod/native/whisper-stt.sh
git commit -m "feat(deploy): launchd launcher for native Whisper-STT"
```

---

### Task 6: Hybrid deploy — STT backend selector (config-only)

Make the gateway's STT backend operator-selectable without any gateway code change. `native-whisper` = omit the `stt-service` container from `managed_services` (the orchestrator only manages what's present), repoint `stt.url` + `companions.stt_health_url` at `host.docker.internal`, and add `extra_hosts` to the gateway container so the hostname resolves across Docker runtimes.

**Files:**
- Create: `deploy/mac-prod/deploy.conf`
- Create: `deploy/mac-prod/native/stt-backend.py`
- Modify: `deploy/mac-prod/docker-compose.yml` (gateway service `extra_hosts`)
- Modify: `deploy/macos/docker-compose.yml` (gateway service `extra_hosts`, local dev stack) — apply only if the file exists; otherwise note the local gateway compose path in task notes.

**Interfaces:**
- Consumes: an active gateway `config.yaml` (host override, default `~/.sentient/gateway/config.yaml`).
- Produces: a comment-preserving patcher `stt-backend.py --backend {native-whisper|docker-sensevoice} --config <path> [--apply]` that prints a diff by default and writes only with `--apply`.

- [ ] **Step 1: Write `deploy/mac-prod/deploy.conf`**

```bash
# Sentient deploy selector (sourced by deploy scripts).
# STT_BACKEND: which STT service the gateway dials.
#   docker-sensevoice — the containerized SenseVoice STTService (default, portable)
#   native-whisper    — the native MLX Whisper-STT (Apple Silicon, launchd)
STT_BACKEND=docker-sensevoice
```

- [ ] **Step 2: Write `deploy/mac-prod/native/stt-backend.py`**

Uses `ruamel.yaml` for round-trip (comment-preserving) edits. Install into the Whisper venv (`./.venv/bin/pip install ruamel.yaml`) or the system python; the script imports it lazily and prints an install hint on ImportError.

```python
"""Switch the gateway's STT backend in a gateway config.yaml (comment-preserving).

native-whisper:
  - remove managed_services.stt-service   (orchestrator won't manage a container)
  - stt.url                    -> ws://host.docker.internal:8768
  - companions.stt_health_url  -> http://host.docker.internal:8769/health
docker-sensevoice:
  - stt.url                    -> ws://sentient-stt-service:8766
  - companions.stt_health_url  -> http://sentient-stt-service:8767/health
  - (does NOT re-add the stt-service block; restore it from git if it was removed)

Dry-run by default (prints a unified diff). Pass --apply to write.

Usage:
  python stt-backend.py --backend native-whisper --config ~/.sentient/gateway/config.yaml
  python stt-backend.py --backend native-whisper --config ~/.sentient/gateway/config.yaml --apply
"""

from __future__ import annotations

import argparse
import difflib
import io
import sys
from pathlib import Path

NATIVE = "native-whisper"
DOCKER = "docker-sensevoice"

URLS = {
    NATIVE: ("ws://host.docker.internal:8768", "http://host.docker.internal:8769/health"),
    DOCKER: ("ws://sentient-stt-service:8766", "http://sentient-stt-service:8767/health"),
}


def _load_yaml():
    # ruamel's default round-trip loader (typ="rt") is SAFE: unlike PyYAML's
    # yaml.load(), it does NOT construct arbitrary Python from !!python/object
    # tags (only ruamel typ="unsafe" would). Input here is the operator's own
    # local gateway config, and round-trip mode is required to preserve comments.
    try:
        from ruamel.yaml import YAML
    except ImportError:
        print("ruamel.yaml required: pip install ruamel.yaml", file=sys.stderr)
        sys.exit(2)
    y = YAML()  # typ="rt" (round-trip) — comment-preserving, no arbitrary-object construction
    y.preserve_quotes = True
    return y


def transform(backend: str, text: str) -> str:
    yaml = _load_yaml()
    doc = yaml.load(text)
    stt_url, health_url = URLS[backend]

    if "stt" in doc and "url" in doc["stt"]:
        doc["stt"]["url"] = stt_url
    if "companions" in doc and "stt_health_url" in doc["companions"]:
        doc["companions"]["stt_health_url"] = health_url

    if backend == NATIVE:
        ms = doc.get("managed_services")
        if ms is not None and "stt-service" in ms:
            del ms["stt-service"]

    buf = io.StringIO()
    yaml.dump(doc, buf)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=[NATIVE, DOCKER])
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    original = args.config.read_text(encoding="utf-8")
    updated = transform(args.backend, original)

    if original == updated:
        print("[stt-backend] no change needed")
        return

    diff = difflib.unified_diff(
        original.splitlines(keepends=True),
        updated.splitlines(keepends=True),
        fromfile=str(args.config),
        tofile=f"{args.config} ({args.backend})",
    )
    sys.stdout.writelines(diff)

    if args.apply:
        args.config.write_text(updated, encoding="utf-8")
        print(f"\n[stt-backend] applied {args.backend} to {args.config}")
    else:
        print(f"\n[stt-backend] dry-run — re-run with --apply to write {args.backend}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Add `extra_hosts` to the gateway container in `deploy/mac-prod/docker-compose.yml`**

Locate the `sentient-gateway` service block. Add (or extend) under it:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```
This makes `host.docker.internal` resolve to the host on Colima/OrbStack as well as Docker Desktop, so the gateway can reach the native service. If the block already has `extra_hosts`, append the line rather than duplicating the key.

- [ ] **Step 4: Mirror `extra_hosts` on the local dev stack gateway (if present)**

```bash
cd /Users/kevinye/Development/sentient
ls deploy/macos/docker-compose.yml 2>/dev/null && echo "edit deploy/macos gateway service extra_hosts too" || echo "no deploy/macos compose — note the local gateway compose path in task notes"
```
If `deploy/macos/docker-compose.yml` exists, add the same `extra_hosts` line to its gateway service.

- [ ] **Step 5: Dry-run the selector against a copy of the gateway config**

```bash
cd /Users/kevinye/Development/sentient
capabilityServices/WhisperSTTService/.venv/bin/pip install -q ruamel.yaml
cp ~/.sentient/gateway/config.yaml /tmp/gw-config-test.yaml
capabilityServices/WhisperSTTService/.venv/bin/python deploy/mac-prod/native/stt-backend.py \
  --backend native-whisper --config /tmp/gw-config-test.yaml
```
Expected: a unified diff showing `stt.url` → `ws://host.docker.internal:8768`, `companions.stt_health_url` → the `:8769/health` URL, and the `stt-service:` block removed from `managed_services`. No file written (dry-run). Confirm the diff touches only those regions.

- [ ] **Step 6: Commit**

```bash
cd /Users/kevinye/Development/sentient
git add -A deploy/mac-prod/deploy.conf deploy/mac-prod/native/stt-backend.py deploy/mac-prod/docker-compose.yml
git add -A deploy/macos/docker-compose.yml 2>/dev/null || true
git commit -m "feat(deploy): STT backend selector (native-whisper vs docker-sensevoice)"
```

---

### Task 7: Phase-4 lean stack-boot verification + handoff

Boot the full LOCAL stack with the gateway pointed at the native Whisper-STT, verify clean startup from the logs (service ready, health green, gateway↔STT WS connected, no unexpected WARN/ERROR), then hand off to the user for the live voice test. No agent-driven browser voice run.

**Files:** none (verification runbook). Record evidence under the QA dir.

**Interfaces:**
- Consumes: Task 5 launcher, Task 6 selector, the running gateway stack.

- [ ] **Step 1: Start the native Whisper-STT**

```bash
cd /Users/kevinye/Development/sentient
deploy/mac-prod/native/whisper-stt.sh start
sleep 25
deploy/mac-prod/native/whisper-stt.sh status
```
Expected: label loaded, `{"status":"ok","version":"1.0.0"}`.

- [ ] **Step 2: Point the LOCAL gateway config at native-whisper (apply)**

```bash
cd /Users/kevinye/Development/sentient
cp ~/.sentient/gateway/config.yaml ~/.sentient/gateway/config.yaml.bak
capabilityServices/WhisperSTTService/.venv/bin/python deploy/mac-prod/native/stt-backend.py \
  --backend native-whisper --config ~/.sentient/gateway/config.yaml --apply
```
Expected: diff printed + "applied native-whisper". (Backup saved to `.bak` in case you need to revert.)

- [ ] **Step 3: Boot the local stack and inspect startup**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
# Bring up the local dev gateway stack (use the project's local compose;
# deploy/macos if present, else the documented local path).
docker compose -f deploy/macos/docker-compose.yml up -d 2>/dev/null || docker compose up -d
sleep 20
docker compose ps
docker logs sentient-gateway 2>&1 | tail -50
```
Expected: gateway container up; **no** attempt to create/manage an `stt-service` container (it was removed from `managed_services`); gateway logs show it resolving/connecting to the STT at `host.docker.internal:8768` and a healthy STT version fetch from `:8769/health`. No unexpected ERROR/WARN.

- [ ] **Step 4: Confirm the gateway↔native-STT connection from both sides**

```bash
cd /Users/kevinye/Development/sentient
# Native side: a conn.open should appear when the gateway dials in.
tail -20 ~/.sentient/whisper-stt/logs/*-service.jsonl 2>/dev/null | grep -i "service.ready\|conn.open" || true
# Gateway side: health/version resolution for stt.
docker logs sentient-gateway 2>&1 | grep -iE "stt|host.docker.internal|8768|8769" | tail -20
```
Expected: native `service.ready`; gateway shows the STT health/version resolved (not "unknown"/unreachable). Capture these lines as evidence under the mobile/QA dir (or `docs/superpowers/` notes).

- [ ] **Step 5: Hand off to the user for the live voice test**

Post a short handoff: "Native Whisper-STT is up and the local gateway is pointed at it; stack booted clean (evidence attached). Go to the webui and use your voice — speak a sentence and confirm the transcript + reply. To revert to SenseVoice: `stt-backend.py --backend docker-sensevoice --config ~/.sentient/gateway/config.yaml --apply` (and restore the `stt-service` managed_services block from git), then restart the stack."

Do NOT drive the webui voice path with Playwright — the live voice test is user-owned (real mic).

- [ ] **Step 6: Commit any captured evidence / notes**

```bash
cd /Users/kevinye/Development/sentient
git add -A docs/superpowers 2>/dev/null || true
git commit -m "docs(whisper-stt): Phase-4 boot verification evidence" || echo "no evidence files to commit"
```

---

## Self-Review

**Spec coverage:**
- §3 service shape (dup, ports 8768/8769, native venv) → Task 1, Task 5. ✓
- §4 backend swap (whisper_mlx, per-segment `[pause.N]`, text-only gate, hallucination guards, empty emotion/event, requirements, no Dockerfile) → Tasks 2–3. ✓
- §5 `whisper:` config block → Task 2 Step 7. ✓
- §6 Phase 1 build → Tasks 1–3; Phase 2 test gate → Task 4; Phase 3 hybrid deploy → Tasks 5–6; Phase 4 lean verify + handoff → Task 7. ✓
- §7 matrix: P2-happy → Task 4 Step 4; P2-silence → Task 4 Step 5; P4-boot → Task 7 Step 3; P4-selector → Task 7 Steps 2–3; Live-voice (user) → Task 7 Step 5. ✓
- §8 risks: emotion/event loss (Task 3 gate change), hallucination guards (Task 2/4), host.docker.internal (Task 6 extra_hosts + Task 7 verify), dup drift (accepted), MLX-only (requirements note), prod safety (Global Constraints + Task 7 local-only). ✓

**Placeholder scan:** No TBD/TODO. Every code step shows full content; every edit shows exact old→new. The silence-case expected behavior (Task 4 Step 5) is intentionally "record what you observe" — that's an observation step, not a placeholder.

**Type consistency:** `WhisperMlx` / `TranscriptResult(text, emotion, event, decode_ms, audio_seconds)` / `WhisperConfig(model, language, no_speech_threshold, logprob_threshold, compression_ratio_threshold, initial_prompt)` / `VALID_LANGUAGES` are defined in Task 2 and consumed consistently in Task 3 (`decode_segments_and_stitch(stt, …)`, `stt=` through pipeline→finalizer, `self._whisper_default`, `_get_whisper`). Ports 8768/8769 consistent across Tasks 3–6. Selector URLs consistent with server ports.

**Contingency (documented, not primary path):** if a future gateway change asserts `stt-service` must exist in `managed_services`, add `optional: true` to that entry as a fallback (registry already supports `optional`); config-omission is the verified zero-code path per `service-registry.ts`.
