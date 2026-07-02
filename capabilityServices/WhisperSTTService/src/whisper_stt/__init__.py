"""Whisper-STT — native (Apple Silicon / Metal) speech-to-text.

Silero VAD + Smart-Turn v3 + MLX Whisper (large-v3-turbo-8bit), exposed as a
WebSocket service that consumes streamed PCM16 audio and emits structured turn
events. Same wire CONTRACT as the SenseVoice STTService; text-only (no emotion/
audio-event tags). See CONTRACT.md for the protocol.
"""

__version__ = "1.0.0"
