"""Chatterbox-TTS — native (Apple Silicon / Metal) text-to-speech.

MLX Chatterbox-Turbo TTS, exposed as a WebSocket service that accepts
text and streams back synthesized audio. Sibling service to
whisper-stt; same host, same conventions (config.py fail-loud loader,
JSONL event/metrics logging), independent process and dependency set.
The wire protocol lands in a later task.
"""

__version__ = "0.1.0"
