"""Whisper STT via MLX (Apple Silicon / Metal).

Drop-in replacement for the SenseVoice backend. Same call shape
(``transcribe(audio_f32) -> TranscriptResult``) so the segment decoder and
turn finalizer are unchanged except that ``emotion``/``event`` are always "".

Language: "en"/"zh" force the decode language (no detection). "auto" runs
constrained detection — argmax over ONLY en/zh (full 99-language autodetect
mislabels short clips, e.g. "Halo?" -> Indonesian). Short/low-confidence clips
fall back to a per-connection sticky prior (last confident detection).

Speed: short clips are padded to the smallest configured bucket (e.g. 5s), not
30s, and the encoder's sinusoidal positional embedding is cropped to match (via
a one-time monkeypatch, _install_flexible_encoder). The encoder cost scales
super-linearly with context, so a 5s bucket is a large win over the 30s default.

Hallucination guards: the near-silence RMS gate now lives BEFORE decode
(turn_decoder skips Whisper on quiet super-segments), so this backend just
surfaces raw ``no_speech_prob`` / ``avg_logprob`` for the downstream gate.

Model loading: ``ModelHolder`` caches the loaded model per repo id, so fresh
per-connection ``WhisperMlx`` instances share one warm in-memory model. Weights
are fetched from HuggingFace on first use and cached under ~/.cache/huggingface.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx_whisper
import numpy as np
from huggingface_hub import snapshot_download
from mlx_whisper.audio import (
    FRAMES_PER_SECOND,
    HOP_LENGTH,
    N_FRAMES,
    N_SAMPLES,
    log_mel_spectrogram,
    pad_or_trim,
)
from mlx_whisper.decoding import DecodingOptions, decode, detect_language
from mlx_whisper.transcribe import ModelHolder

from .config import WhisperConfig

log = logging.getLogger("stt-service.whisper")

SAMPLE_RATE = 16_000
# MLX compute dtype for the encoder + decode. large-v3-turbo's encoder is the
# full large-v3 encoder (expensive); its decoder is tiny (4 layers). Running the
# encoder ONCE and reusing the features for both language detection and decode
# is what keeps turbo fast — see WhisperMlx._single_pass.
_DTYPE = mx.float16
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


def _pick_bucket_frames(n_samples: int, buckets: tuple[int, ...]) -> int:
    """Smallest bucket (in mel frames) that fits ``n_samples`` of audio.

    Whisper pads every clip to 30s (N_FRAMES) — wasteful for short turns, since
    the encoder's cost is ~O(ctx^2). We instead pad to the smallest configured
    bucket that still holds the real audio (see _install_flexible_encoder for the
    matching pos-embedding crop). ``buckets`` is ascending, each <= N_FRAMES.
    Falls back to N_FRAMES if the audio exceeds every bucket.
    """
    content_frames = -(-n_samples // HOP_LENGTH)  # ceil: real mel frames needed
    for frames in buckets:
        if frames >= content_frames:
            return frames
    return N_FRAMES


_ENCODER_PATCHED = False


def _install_flexible_encoder() -> None:
    """Monkeypatch AudioEncoder.__call__ to crop the positional embedding to the
    input length. Idempotent; safe to call per-decode.

    mlx's ``AudioEncoder.__call__`` hard-asserts the full 30s ctx. Whisper's
    encoder uses SINUSOIDAL (fixed, not learned) positional embeddings — row k is
    position k regardless of total length — so a K-row slice is exactly the
    embedding for a K-length sequence, and convolutions are length-agnostic. This
    lets detect_language / decode encode a sub-30s (bucketed) mel for a large
    speedup. No-op for full 30s inputs (crop [:1500] == the whole thing).
    """
    global _ENCODER_PATCHED
    if _ENCODER_PATCHED:
        return
    from mlx_whisper.whisper import AudioEncoder

    def _flexible_call(self, x: mx.array) -> mx.array:
        x = nn.gelu(self.conv1(x))
        x = nn.gelu(self.conv2(x))
        x = x + self._positional_embedding[: x.shape[1]]
        for block in self.blocks:
            x, _, _ = block(x)
        return self.ln_post(x)

    AudioEncoder.__call__ = _flexible_call
    _ENCODER_PATCHED = True


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
        # Ascending, even (s*100), capped at N_FRAMES. Even → conv2 (stride 2)
        # yields an integer ctx that the sinusoidal pos-embedding crop matches.
        self._encode_buckets: tuple[int, ...] = tuple(
            sorted({min(s * FRAMES_PER_SECOND, N_FRAMES) for s in config.encode_buckets_s})
        )
        # Per-connection sticky prior: last confidently-detected language. Used
        # as the fallback for short / low-confidence auto-detect clips. Must NOT
        # be shared across connections (server hands each connection its own
        # WhisperMlx) — otherwise one speaker's language leaks into another's.
        self._sticky_lang: str | None = None

    @property
    def language(self) -> str:
        return self._language

    @property
    def model_repo(self) -> str:
        return self._config.model

    def warm(self) -> None:
        """Force the model to load now by decoding 100 ms of silence."""
        self.transcribe(np.zeros(SAMPLE_RATE // 10, dtype=np.float32))

    def _bucketed_mel(self, model, audio: np.ndarray) -> mx.array:
        """Log-mel padded to the smallest bucket that holds the audio (not 30s).

        Fed to detect_language / decode; the flexible encoder crops the
        positional embedding to match (see _install_flexible_encoder). For >30s
        audio the bucket falls back to N_FRAMES (first 30s window).
        """
        mel = log_mel_spectrogram(audio, n_mels=model.dims.n_mels, padding=N_SAMPLES)
        n_frames = _pick_bucket_frames(int(audio.size), self._encode_buckets)
        return pad_or_trim(mel, n_frames, axis=-2).astype(_DTYPE)

    def _detect_constrained(self, model, mel: mx.array) -> str:
        """Detect language (constrained to en/zh) from a bucketed mel.

        Below ``language_min_confidence`` the winner prob is untrustworthy
        (short clip) — fall back to the sticky prior. On a confident pick,
        update the prior.
        """
        _, probs = detect_language(model, mel)
        winner = _pick_constrained_language(probs, AUTO_CANDIDATE_LANGUAGES)
        confidence = float(probs.get(winner, 0.0))
        if confidence < self._config.language_min_confidence and self._sticky_lang:
            log.debug(
                "whisper.lang_detect low_conf winner=%s conf=%.3f sticky=%s",
                winner, confidence, self._sticky_lang,
            )
            return self._sticky_lang
        self._sticky_lang = winner
        log.debug("whisper.lang_detect winner=%s conf=%.3f", winner, confidence)
        return winner

    def _single_pass(self, model, audio: np.ndarray) -> tuple[str, float, float]:
        """≤30s decode on a bucketed mel: (auto) detect + decode.

        detect_language and decode each re-encode the bucketed mel via the
        flexible encoder — two SHORT passes, still far cheaper than one full 30s
        pass because the encoder cost scales super-linearly with context length.
        """
        _install_flexible_encoder()
        mel = log_mel_spectrogram(audio, n_mels=model.dims.n_mels, padding=N_SAMPLES)
        n_frames = _pick_bucket_frames(int(audio.size), self._encode_buckets)
        bucket_mel = pad_or_trim(mel, n_frames, axis=-2).astype(_DTYPE)
        language = self._decode_language
        if language is None:
            language = self._detect_constrained(model, bucket_mel)
        options = DecodingOptions(
            task="transcribe",
            language=language,
            temperature=0.0,
            without_timestamps=True,
            fp16=True,
            prompt=(self._config.initial_prompt or None),
        )
        result = decode(model, bucket_mel, options)
        # Short-context (bucketed) decode can repeat on out-of-distribution
        # lengths. Whisper's own degeneracy signal is a high gzip
        # compression_ratio — fall back to the full 30s window for correctness on
        # the rare degenerate case (no-op when already at N_FRAMES; nan-safe).
        if n_frames < N_FRAMES and result.compression_ratio > self._config.compression_ratio_threshold:
            log.debug(
                "whisper.bucket_fallback ratio=%.2f n_frames=%d -> 30s",
                result.compression_ratio, n_frames,
            )
            full_mel = pad_or_trim(mel, N_FRAMES, axis=-2).astype(_DTYPE)
            result = decode(model, full_mel, options)
        return result.text.strip(), float(result.no_speech_prob), float(result.avg_logprob)

    def _windowed(self, audio: np.ndarray) -> tuple[str, float, float]:
        """>30s fallback: high-level transcribe with multi-window seek.

        Rare (a super-segment with no >=min_pause_ms gap for 30s+). Correctness
        over speed. Auto detection is constrained to en/zh via the first window.
        """
        _install_flexible_encoder()
        language = self._decode_language
        if language is None:
            model = ModelHolder.get_model(self._config.model, _DTYPE)
            language = self._detect_constrained(model, self._bucketed_mel(model, audio))
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._config.model,
            language=language,
            condition_on_previous_text=False,
            no_speech_threshold=self._config.no_speech_threshold,
            logprob_threshold=self._config.logprob_threshold,
            compression_ratio_threshold=self._config.compression_ratio_threshold,
            initial_prompt=(self._config.initial_prompt or None),
            word_timestamps=False,
            verbose=None,
        )
        no_speech_prob, avg_logprob = _extract_signals(result)
        return (result.get("text") or "").strip(), no_speech_prob, avg_logprob

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        """Decode a finalized utterance. ``audio`` = 1-D float32 @ 16 kHz."""
        if audio.ndim != 1:
            raise ValueError(f"audio must be 1-D, got shape {audio.shape}")
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        _ensure_mlx_weight_alias(self._config.model)
        audio_seconds = audio.size / SAMPLE_RATE
        t0 = time.monotonic()
        if audio.size > N_SAMPLES:
            text, no_speech_prob, avg_logprob = self._windowed(audio)
        else:
            model = ModelHolder.get_model(self._config.model, _DTYPE)
            text, no_speech_prob, avg_logprob = self._single_pass(model, audio)
        decode_ms = (time.monotonic() - t0) * 1000.0
        return TranscriptResult(
            text=text,
            emotion="",
            event="",
            decode_ms=decode_ms,
            audio_seconds=audio_seconds,
            no_speech_prob=no_speech_prob,
            avg_logprob=avg_logprob,
        )
