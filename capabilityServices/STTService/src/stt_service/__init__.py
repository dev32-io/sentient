"""STT Service — local speech-to-text on Raspberry Pi 5.

Silero VAD + Smart-Turn v3 + SenseVoice-Small, exposed as a WebSocket
service that consumes streamed PCM16 audio and emits structured turn
events. See CONTRACT.md for the wire protocol.

Python note — ``__init__.py``:
  This file marks the ``stt_service`` directory as a Python package
  (importable module). In Kotlin, creating a directory under
  ``src/main/kotlin/`` is enough to make it a package — Python requires
  this explicit marker file. It can be empty, or it can export symbols
  (like we do here with ``__version__``) that become available when
  someone writes ``from stt_service import __version__``.
"""

__version__ = "1.0.0"
