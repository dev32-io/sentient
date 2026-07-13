"""Pluggable audio encoders — terminal stage of the TTS streaming pipeline.

Re-exports the public surface: ``AudioEncoder`` (the Protocol every
encoder satisfies) and ``make_encoder`` (the format -> encoder factory).
Concrete implementations (``OpusEncoder``, ``PcmEncoder``) live in their
own modules and are constructed via ``make_encoder``, not imported
directly by callers outside this package.
"""

from __future__ import annotations

from chatterbox_tts.encoders.base import AudioEncoder, make_encoder

__all__ = ["AudioEncoder", "make_encoder"]
