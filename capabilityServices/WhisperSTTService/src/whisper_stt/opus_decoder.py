"""Opus packet → PCM16 LE mono streaming decoder for the STT pipeline.

Wraps opuslib.Decoder with the specific frame size + sample rate the
downstream Silero VAD + Smart-Turn + SenseVoice stack expects (16 kHz mono).
One instance per WebSocket connection — the decoder maintains internal state
(prediction, codebook context) across packets within a stream.

Caller responsibility: feed complete opus packets one at a time. This decoder
does NOT handle OGG containerization — the cube ships raw opus packets per
WS message (xiaozhi protocol convention). For OGG-Opus uplink (not currently
used), wrap the OGG demuxer outside this class.
"""
import logging
from typing import Final

import opuslib

_LOG = logging.getLogger(__name__)

# Opus supports {8, 12, 16, 24, 48} kHz. STT requires 16 kHz mono.
_REQUIRED_SAMPLE_RATE: Final = 16000
_REQUIRED_CHANNELS: Final = 1

# Largest opus frame size at 16 kHz = 60 ms = 960 samples. Pass this as the
# max samples-per-call so a single decode() handles any valid framing.
_MAX_FRAME_SAMPLES_16K: Final = 960


class OpusStreamDecoder:
    """Stateful opus stream decoder. Reuse one instance for the lifetime of a
    single WS connection so libopus retains predictor / codebook state."""

    def __init__(self, sample_rate: int = _REQUIRED_SAMPLE_RATE, channels: int = _REQUIRED_CHANNELS):
        if sample_rate != _REQUIRED_SAMPLE_RATE:
            raise ValueError(f"STT requires {_REQUIRED_SAMPLE_RATE} Hz; got {sample_rate}")
        if channels != _REQUIRED_CHANNELS:
            raise ValueError(f"STT requires mono; got {channels} channels")
        self._decoder = opuslib.Decoder(fs=sample_rate, channels=channels)
        self._frames_decoded = 0
        _LOG.info("opus.stream_decoder.created sample_rate=%d channels=%d", sample_rate, channels)

    def decode_packet(self, opus_packet: bytes) -> bytes:
        """Decode one opus packet. Returns PCM16 LE mono bytes. opus packet
        sizes are typically 60-200 B for speech at 16-32 kbps."""
        if not opus_packet:
            raise ValueError("empty opus packet")
        pcm = self._decoder.decode(opus_packet, frame_size=_MAX_FRAME_SAMPLES_16K)
        self._frames_decoded += 1
        return pcm

    def reset(self) -> None:
        """Reset decoder state. Call between separate utterances/streams."""
        self._decoder.reset_state()
