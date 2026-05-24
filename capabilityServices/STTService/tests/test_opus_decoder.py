"""Opus → PCM16 decoder unit tests.

Pins the protocol contract: caller pushes opus packets; decoder emits PCM16
LE mono samples at 16 kHz (STT's required input format). 1 frame of opus at
the typical 20 ms frame size produces 320 samples (640 bytes PCM16) at 16 kHz.
"""
import struct

import pytest

from stt_service.opus_decoder import OpusStreamDecoder


def _encode_test_frame_silence_16k() -> bytes:
    """Build a single 20 ms opus silence frame at 16 kHz mono. Used so tests
    don't depend on an external opus-encoded fixture file."""
    import opuslib

    encoder = opuslib.Encoder(fs=16000, channels=1, application=opuslib.APPLICATION_VOIP)
    pcm_silence = b"\x00\x00" * 320  # 320 samples × 2 bytes = 640 B = 20 ms @ 16 kHz
    return encoder.encode(pcm_silence, frame_size=320)


def test_decoder_emits_pcm16_at_16khz():
    opus_pkt = _encode_test_frame_silence_16k()
    dec = OpusStreamDecoder(sample_rate=16000, channels=1)
    pcm = dec.decode_packet(opus_pkt)
    assert isinstance(pcm, bytes)
    assert len(pcm) == 320 * 2  # 320 samples × 2 bytes/sample
    # All samples should be near-zero (silence input).
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm)
    assert max(abs(s) for s in samples) < 100  # near-silence, allow tiny coding noise


def test_decoder_rejects_empty_packet():
    dec = OpusStreamDecoder(sample_rate=16000, channels=1)
    with pytest.raises(ValueError, match="empty opus packet"):
        dec.decode_packet(b"")


def test_decoder_handles_multiple_frames():
    pkt = _encode_test_frame_silence_16k()
    dec = OpusStreamDecoder(sample_rate=16000, channels=1)
    out1 = dec.decode_packet(pkt)
    out2 = dec.decode_packet(pkt)
    assert len(out1) == len(out2)
