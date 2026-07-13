"""Single source of truth for the TTS engine's native output sample rate.

Duplicated as separate literals across ``chatterbox_mlx.py``,
``encoders/opus_encoder.py``, ``encoders/pcm_encoder.py``, and
``synthesis.py`` used to mean nothing cross-checked them — pointing
``config.model`` at a variant with a different vocoder rate would have
silently produced wrong-pitch audio. Every one of those modules now
imports ``SOURCE_SAMPLE_RATE`` from here instead, and
``ChatterboxEngine.warm()`` asserts the loaded model's real rate
matches it at boot (see ``chatterbox_mlx.py``), so drift fails loud
instead of silently.

Plain int, NO mlx/torch import — this module must stay importable by
the MLX-free encoders (``encoders/opus_encoder.py``, ``pcm_encoder.py``).
"""

from __future__ import annotations

# Chatterbox/S3Gen's vocoder native output rate (Hz) — a property of the
# model architecture, not a service tunable.
SOURCE_SAMPLE_RATE = 24_000
