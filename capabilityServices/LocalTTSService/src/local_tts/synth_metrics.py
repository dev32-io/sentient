"""Pure per-request synthesis metrics: timing math + wire/log record shape.

Split out of ``synthesis.py`` (which owns the lock/queue/worker-thread
concurrency logic described in that module's docstring) purely to keep
that file under the project's line cap. Nothing here touches a lock, a
queue, or a thread — it's arithmetic over already-collected counters,
plus building the ``Done`` event fields and the ``local_tts.synthesize``
JSONL record from the result. Safe to read, test, and change in
isolation from the concurrency-critical drain/worker logic.
"""

from __future__ import annotations

from typing import Any

from .synth_worker import Metrics

# Rounding precision (decimal places) for each metric field, shared by
# both the `Done` WS event and the `local_tts.synthesize` JSONL record.
_TTFA_MS_PRECISION = 2
_RTF_PRECISION = 4
_AUDIO_SECONDS_PRECISION = 3
_DECODE_MS_PRECISION = 2


def compute_metrics(
    *,
    request_id: str,
    ttfa_ms: float | None,
    decode_ms: float,
    total_samples: int,
    source_sample_rate: int,
    bytes_sent: int,
) -> Metrics:
    """Derive ``audio_seconds``/``rtf`` from raw counters.

    ``ttfa_ms`` falls back to ``decode_ms`` when no chunk was ever sent
    (empty synthesis or immediate cancel) so downstream consumers always
    see a numeric time-to-first-audio.
    """
    audio_seconds = total_samples / source_sample_rate
    rtf = (decode_ms / 1000.0) / audio_seconds if audio_seconds > 0 else 0.0
    return Metrics(request_id, ttfa_ms or decode_ms, rtf, audio_seconds, decode_ms, bytes_sent)


def build_done_fields(metrics: Metrics) -> dict[str, Any]:
    """Rounded fields for the ``Done`` WS event."""
    return {
        "request_id": metrics.request_id,
        "ttfa_ms": round(metrics.ttfa_ms, _TTFA_MS_PRECISION),
        "rtf": round(metrics.rtf, _RTF_PRECISION),
        "audio_seconds": round(metrics.audio_seconds, _AUDIO_SECONDS_PRECISION),
    }


def build_synth_record(
    *, metrics: Metrics, voice_id: str | None, format: str, sample_rate: int,
) -> dict[str, Any]:
    """Full ``local_tts.synthesize`` JSONL record: the ``Done`` fields plus
    ``decode_ms``/voice/format/sample_rate/``bytes_sent`` for offline analysis.
    """
    return {
        **build_done_fields(metrics),
        "decode_ms": round(metrics.decode_ms, _DECODE_MS_PRECISION),
        "voice_id": voice_id,
        "format": format,
        "sample_rate": sample_rate,
        "bytes_sent": metrics.bytes_sent,
    }
