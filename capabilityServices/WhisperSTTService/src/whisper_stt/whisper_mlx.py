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
