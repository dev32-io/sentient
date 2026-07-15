"""Offline built-in voice-pack generator (run on-host; no model needed).

Produces the packaged, read-only voice packs that ``VoiceStore``'s
``BuiltinLibrary`` collaborator discovers under
``src/chatterbox_tts/voices_library/<slug>/`` (see that module's
``_scan_slugs`` — any subdir matching ``^[a-z0-9-]{1,32}$`` holding a
``ref.wav`` is a valid built-in pack).

Qwen3-TTS clones a voice directly from a reference wav path at synth
time (``QwenEngine.synthesize``'s ``ref_audio_path`` — see that
module's docstring) — there is no precomputed conditioning object to
build or persist, so this generator does nothing model- or MLX-related.
Every entry below names a source clip under ``scripts/clips/``
(git-ignored raw audio, never committed) that gets downmixed to mono,
resampled to 24 kHz if needed, optionally windowed to a clean solo
stretch, and written out as ``voices_library/<slug>/ref.wav`` (the
actual committed artifact — a small public-domain clip, see that
directory's ``LICENSES.md``) plus ``meta.json``.

Every entry MUST have its exact source/license/reader recorded in
``voices_library/LICENSES.md`` — see that file's per-slug entries.

Idempotent: re-running overwrites every configured pack.

Usage: ``uv run python scripts/build_builtin_voices.py`` (run from the
``ChatterboxTTSService`` project root, e.g.
``capabilityServices/ChatterboxTTSService``). Needs only ``soundfile``
+ ``soxr`` on the path — no MLX/Metal, no model weights.
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

from chatterbox_tts.pack_meta import META_FILENAME, REF_FILENAME

log = logging.getLogger("chatterbox_tts.scripts.build_builtin_voices")

# Qwen3-TTS's reference-clip sample rate — matches qwen_engine.py's
# SAMPLE_RATE (the model's own vocoder rate) so no resample happens at
# synth time.
_TARGET_SAMPLE_RATE = 24_000

# voice_store.py's _MIN_REF_SECONDS is 3.0s (hard assertion at synth
# time); require a full extra second of margin so a borderline-length
# clip never trips that assertion.
_MIN_CLIP_SECONDS = 4.0

# Upper bound on a shipped reference clip's length — a longer ref buys
# no cloning-quality benefit here and only costs clone-time latency.
_MAX_CLIP_SECONDS = 20.0

_SCRIPT_DIR = Path(__file__).resolve().parent
_CLIPS_DIR = _SCRIPT_DIR / "clips"
_LIBRARY_DIR = _SCRIPT_DIR.parent / "src" / "chatterbox_tts" / "voices_library"


@dataclass(frozen=True)
class VoiceEntry:
    """One built-in pack to (re)generate.

    ``clip_filename`` is relative to ``_CLIPS_DIR``. ``offset_s`` /
    ``window_s`` cut a window out of the source clip; ``None`` for both
    means "use the whole source file" — the four pre-cut LibriVox clips
    are already trimmed to the right length, so only ``nova``'s
    raw-track source needs an explicit window.
    """

    slug: str
    name: str
    description: str
    tags: list[str]
    clip_filename: str
    offset_s: float | None = None
    window_s: float | None = None


# All five packs are LibriVox solo-chapter readings, public domain in
# the US per https://librivox.org/pages/public-domain/ ("all our
# recordings are public domain ... anyone can use all our recordings
# however they wish"). Exact source/reader/window per slug recorded in
# voices_library/LICENSES.md. Character/tone NOT listen-tested by this
# generator — see LICENSES.md's top note.
_ENTRIES: list[VoiceEntry] = [
    VoiceEntry(
        slug="nova",
        name="Nova",
        description="Sentient's default voice — warm and clear.",
        tags=["warm", "default"],
        clip_filename="miscellaneouspoe_06_poe_128kb.mp3",
        offset_s=40.5,
        window_s=18.0,
    ),
    VoiceEntry(
        slug="wren",
        name="Wren",
        description=(
            'Public-domain LibriVox reading voice (source: "The Bells" by Edgar Allan '
            "Poe, read by Helen Taylor). Character not listen-tested."
        ),
        tags=["public-domain"],
        clip_filename="helen_taylor_the_bells.wav",
    ),
    VoiceEntry(
        slug="flint",
        name="Flint",
        description=(
            'Public-domain LibriVox reading voice (source: "Alone" by Edgar Allan Poe, '
            'read by LibriVox volunteer "Olivereading"). Character not listen-tested.'
        ),
        tags=["public-domain"],
        clip_filename="olivereading_alone.wav",
    ),
    VoiceEntry(
        slug="briar",
        name="Briar",
        description=(
            'Public-domain LibriVox reading voice (source: "The Pit and the Pendulum" '
            "by Edgar Allan Poe, read by Bryony Ford). Character not listen-tested."
        ),
        tags=["public-domain"],
        clip_filename="bryony_ford_pit_and_pendulum.wav",
    ),
    VoiceEntry(
        slug="ember",
        name="Ember",
        description=(
            'Public-domain LibriVox reading voice (source: "The Raven" by Edgar Allan '
            "Poe, read by Roseanne Hoffman). Character not listen-tested."
        ),
        tags=["public-domain"],
        clip_filename="roseanne_hoffman_the_raven.wav",
    ),
]


def _load_window(entry: VoiceEntry) -> tuple[np.ndarray, int]:
    """Decode ``entry``'s source clip (optionally windowed) to mono float32 PCM."""
    path = _CLIPS_DIR / entry.clip_filename
    if entry.offset_s is None:
        array, sample_rate = sf.read(str(path), dtype="float32")
    else:
        info = sf.info(str(path))
        start = int(round(entry.offset_s * info.samplerate))
        frames = int(round((entry.window_s or 0.0) * info.samplerate))
        array, sample_rate = sf.read(str(path), start=start, frames=frames, dtype="float32")
    if array.ndim > 1:
        array = array.mean(axis=1).astype(np.float32)
    return array, sample_rate


def _resample(array: np.ndarray, sample_rate: int) -> np.ndarray:
    """Resample to ``_TARGET_SAMPLE_RATE`` if the source isn't already there."""
    if sample_rate == _TARGET_SAMPLE_RATE:
        return array
    return soxr.resample(array, sample_rate, _TARGET_SAMPLE_RATE).astype(np.float32)


def _trim(array: np.ndarray) -> np.ndarray:
    """Cap the ref clip at ``_MAX_CLIP_SECONDS`` (from the start)."""
    max_samples = int(_MAX_CLIP_SECONDS * _TARGET_SAMPLE_RATE)
    return array[:max_samples] if array.size > max_samples else array


def _build_ref(entry: VoiceEntry) -> tuple[np.ndarray, float]:
    """Produce the mono 24kHz PCM ref clip for one entry. Returns ``(pcm, duration_s)``."""
    array, sample_rate = _load_window(entry)
    array = _trim(_resample(array, sample_rate))
    duration_s = array.size / _TARGET_SAMPLE_RATE
    if duration_s < _MIN_CLIP_SECONDS:
        raise ValueError(
            f"{entry.slug}: ref clip is {duration_s:.1f}s, need >= {_MIN_CLIP_SECONDS:.0f}s"
        )
    return array, duration_s


def _write_pack(entry: VoiceEntry, pcm: np.ndarray, duration_s: float) -> Path:
    """Persist one pack: ref.wav + meta.json. Idempotent (overwrites)."""
    pack_dir = _LIBRARY_DIR / entry.slug
    pack_dir.mkdir(parents=True, exist_ok=True)
    sf.write(str(pack_dir / REF_FILENAME), pcm, _TARGET_SAMPLE_RATE, subtype="PCM_16")
    meta = {
        "name": entry.name,
        "description": entry.description,
        "tags": list(entry.tags),
        "refDurationMs": int(duration_s * 1000),
    }
    (pack_dir / META_FILENAME).write_text(json.dumps(meta), encoding="utf-8")
    return pack_dir


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr
    )
    log.info(
        "build_builtin_voices.start entries=%d library_dir=%s", len(_ENTRIES), _LIBRARY_DIR,
    )
    for entry in _ENTRIES:
        log.info("build_builtin_voices.entry start slug=%s clip=%s", entry.slug, entry.clip_filename)
        pcm, duration_s = _build_ref(entry)
        pack_dir = _write_pack(entry, pcm, duration_s)
        log.info(
            "build_builtin_voices.entry done slug=%s duration_s=%.1f pack_dir=%s",
            entry.slug, duration_s, pack_dir,
        )
    log.info("build_builtin_voices.done count=%d", len(_ENTRIES))


if __name__ == "__main__":
    main()
