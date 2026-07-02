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

import mlx.core as mx
import mlx_whisper
import numpy as np
from huggingface_hub import snapshot_download
from mlx_whisper.audio import N_FRAMES, N_SAMPLES, log_mel_spectrogram, pad_or_trim
from mlx_whisper.transcribe import ModelHolder

from .config import WhisperConfig

log = logging.getLogger("stt-service.whisper")

SAMPLE_RATE = 16_000
AUTO_LANGUAGE = "auto"
VALID_LANGUAGES: tuple[str, ...] = ("auto", "en", "zh")
# When language is "auto", constrain detection to the concrete supported set
# (not Whisper's full ~99 languages). Full autodetect mislabels short clips —
# e.g. "Halo?" (English "Hello?") → Indonesian. Derived from VALID_LANGUAGES.
AUTO_CANDIDATE_LANGUAGES: tuple[str, ...] = tuple(
    lang for lang in VALID_LANGUAGES if lang != AUTO_LANGUAGE
)

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

    "auto" -> None (constrained detection resolves it per decode). "en"/"zh"
    pass through unchanged (forced, no detection pass — faster).
    """
    if language == AUTO_LANGUAGE:
        return None
    return language


def _pick_constrained_language(probs: dict, candidates: tuple[str, ...]) -> str:
    """Argmax the Whisper language-probability dict over ONLY ``candidates``.

    Whisper's ``probs`` keys are language codes ("en", "zh", ...). Restricting
    the argmax to the household's supported set keeps short-clip detection
    honest (full autodetect ranges over ~99 languages and mislabels).
    """
    return max(candidates, key=lambda code: float(probs.get(code, 0.0)))


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

    def _resolve_language(self, audio: np.ndarray) -> str:
        """Detect the language constrained to AUTO_CANDIDATE_LANGUAGES (en/zh).

        Reuses the same cached model instance ``mlx_whisper.transcribe`` uses
        (ModelHolder), so no extra model load — one detection encoder pass,
        then the caller forces the resolved language (skipping mlx_whisper's
        own unconstrained full-99 autodetect).
        """
        _ensure_mlx_weight_alias(self._config.model)
        model = ModelHolder.get_model(self._config.model, mx.float16)
        mel = log_mel_spectrogram(audio, n_mels=model.dims.n_mels, padding=N_SAMPLES)
        mel_segment = pad_or_trim(mel, N_FRAMES, axis=-2).astype(mx.float16)
        _, probs = model.detect_language(mel_segment)
        chosen = _pick_constrained_language(probs, AUTO_CANDIDATE_LANGUAGES)
        log.debug("whisper.lang_detect resolved=%s", chosen)
        return chosen

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        """Decode a finalized utterance. ``audio`` = 1-D float32 @ 16 kHz."""
        if audio.ndim != 1:
            raise ValueError(f"audio must be 1-D, got shape {audio.shape}")
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        _ensure_mlx_weight_alias(self._config.model)
        audio_seconds = audio.size / SAMPLE_RATE
        t0 = time.monotonic()
        # Resolve "auto" (self._decode_language is None) to a concrete language
        # constrained to en/zh; forced languages pass straight through.
        decode_language = self._decode_language
        if decode_language is None:
            decode_language = self._resolve_language(audio)
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._config.model,
            language=decode_language,
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
