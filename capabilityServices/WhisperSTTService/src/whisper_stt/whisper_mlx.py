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

import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import mlx_whisper
import numpy as np
from huggingface_hub import snapshot_download

from .config import WhisperConfig

log = logging.getLogger("stt-service.whisper")

SAMPLE_RATE = 16_000
AUTO_LANGUAGE = "auto"
VALID_LANGUAGES: tuple[str, ...] = ("auto", "en", "zh")

# mlx_whisper 0.4.x's model loader (mlx_whisper.load_models.load_model) resolves
# the quantized weights by the legacy filenames below and crashes with
# "[load_npz] Input must be a zip file" if neither is present. Several current
# mlx-community repos (e.g. whisper-large-v3-turbo-8bit) ship the weights as
# ``model.safetensors`` instead, which the loader does not recognize. We bridge
# the gap by aliasing the modern name to the legacy one in the snapshot dir
# before load. Internal loader detail — code constant, not user config.
_LEGACY_WEIGHT_NAMES: tuple[str, ...] = ("weights.safetensors", "weights.npz")
_MODERN_WEIGHT_NAME = "model.safetensors"


@lru_cache(maxsize=None)
def _ensure_mlx_weight_alias(model_repo: str) -> None:
    """Make an mlx-community ``model.safetensors`` repo loadable by mlx_whisper.

    Idempotent and cached (runs once per repo id). No-op when the repo already
    ships a legacy-named weights file, or when neither layout is present (let
    mlx_whisper raise its own clear error in that case).
    """
    snapshot = Path(snapshot_download(model_repo))
    if any((snapshot / name).exists() for name in _LEGACY_WEIGHT_NAMES):
        return
    modern = snapshot / _MODERN_WEIGHT_NAME
    if not modern.exists():
        return
    alias = snapshot / _LEGACY_WEIGHT_NAMES[0]
    try:
        alias.symlink_to(modern.name)  # relative link within the snapshot dir
    except FileExistsError:
        return
    log.info(
        "whisper.weights_alias created %s -> %s in %s",
        alias.name, modern.name, snapshot,
    )


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
    no_speech_prob: float
    avg_logprob: float


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

        _ensure_mlx_weight_alias(self._config.model)
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
