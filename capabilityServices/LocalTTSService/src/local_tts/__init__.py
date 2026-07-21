"""local-tts — native (Apple Silicon / Metal) text-to-speech.

MLX Qwen3-TTS, exposed as a WebSocket service that accepts
text and streams back synthesized audio. Sibling service to
whisper-stt; same host, same conventions (config.py fail-loud loader,
JSONL event/metrics logging), independent process and dependency set.
The wire protocol is specified in CONTRACT.md.
"""

__version__ = "1.2.0"
