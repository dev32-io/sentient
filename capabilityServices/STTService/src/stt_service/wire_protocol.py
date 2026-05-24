"""Translate ``PipelineEvent`` objects into WebSocket wire format.

Contract: every event becomes one JSON dict (sent as a text frame) and,
for ``TurnComplete``, a follow-up binary frame carrying the WAV bytes.
``TranscriptReady`` and ``TurnRejected`` are text-only.

Python note — ``isinstance()`` dispatch:
  In Kotlin you'd write ``when (event) { is VadStart -> ... }``. Python
  doesn't have a built-in sealed-class ``when`` expression, so we use
  chained ``isinstance()`` checks. Python 3.10+ has structural
  ``match``/``case`` that's closer to Kotlin's ``when``, but
  ``isinstance`` is more universally understood and produces identical
  bytecode. Pick whichever your team finds clearer.
"""

from __future__ import annotations

from typing import Any

from .pipeline_events import (
    PipelineEvent,
    SmartTurnEval,
    TranscriptReady,
    TurnComplete,
    TurnContinuing,
    TurnRejected,
    VadEnd,
    VadStart,
)


def event_to_wire(event: PipelineEvent) -> tuple[dict[str, Any], bytes | None]:
    """Return ``(json_dict, binary_payload)`` for the given pipeline event.

    The caller sends the JSON dict as a text WebSocket frame. If the
    second element is not ``None``, it sends that as a follow-up binary
    frame immediately after.
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

    if isinstance(event, TurnRejected):
        return (
            {
                "type": "turn_rejected",
                "turnIdx": event.turn_idx,
                "reason": event.reason,
                "text": event.text,
                "audioEvent": event.audio_event,
                "decodeMs": round(event.decode_ms, 3),
                "audioSeconds": round(event.audio_seconds, 3),
            },
            None,
        )

    if isinstance(event, TranscriptReady):
        return (
            {
                "type": "transcript_ready",
                "turnIdx": event.turn_idx,
                "text": event.text,
                "emotion": event.emotion,
                "event": event.event,
                "decodeMs": round(event.decode_ms, 3),
                "audioSeconds": round(event.audio_seconds, 3),
                "pauses": event.pauses,
            },
            None,
        )

    # Python note: this ``raise`` is the "else" branch. If someone adds
    # a new event type to ``pipeline_events.py`` but forgets to handle
    # it here, this line fires immediately rather than silently dropping
    # the event. Fail loud.
    raise ValueError(f"unknown pipeline event type: {type(event).__name__}")
