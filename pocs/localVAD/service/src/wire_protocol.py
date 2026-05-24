"""Translate ``PipelineEvent`` objects into WebSocket wire format.

Contract: every event becomes one JSON dict (sent as a text frame) and,
for ``TurnComplete``, a follow-up binary frame carrying the WAV bytes.

Kept in its own module so ``server.py`` stays focused on connection
lifecycle.
"""

from __future__ import annotations

from typing import Any

from .pipeline_events import (
    PipelineEvent,
    SmartTurnEval,
    TurnComplete,
    TurnContinuing,
    VadEnd,
    VadStart,
)


def event_to_wire(event: PipelineEvent) -> tuple[dict[str, Any], bytes | None]:
    """Return ``(json_dict, binary_payload)`` for the given pipeline event.

    The binary payload is ``None`` for every event except ``TurnComplete``,
    where it carries the finalized turn audio as a WAV file.
    """
    if isinstance(event, VadStart):
        return {"type": "vad_start", "turnIdx": event.turn_idx}, None

    if isinstance(event, VadEnd):
        return {"type": "vad_end", "turnIdx": event.turn_idx}, None

    if isinstance(event, SmartTurnEval):
        return (
            {
                "type": "smart_turn_eval",
                "turnIdx": event.turn_idx,
                "probability": round(event.probability, 4),
                "prediction": event.prediction,
                "evalMs": round(event.eval_ms, 3),
                "audioSeconds": round(event.audio_seconds, 3),
            },
            None,
        )

    if isinstance(event, TurnContinuing):
        return (
            {
                "type": "turn_continuing",
                "turnIdx": event.turn_idx,
                "probability": round(event.probability, 4),
                "evalMs": round(event.eval_ms, 3),
            },
            None,
        )

    if isinstance(event, TurnComplete):
        return (
            {
                "type": "turn_complete",
                "turnIdx": event.turn_idx,
                "durationMs": round(event.duration_ms, 2),
                "smartTurnProbability": round(event.smart_turn_probability, 4),
                "smartTurnEvalMs": round(event.smart_turn_eval_ms, 3),
                "wavBytesLen": len(event.wav_bytes),
                "wavPath": str(event.wav_path),
            },
            event.wav_bytes,
        )

    raise ValueError(f"unknown pipeline event type: {type(event).__name__}")
