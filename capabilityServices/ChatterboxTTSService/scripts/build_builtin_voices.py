"""Offline built-in voice-pack generator (run on-host; needs Metal/MLX).

Produces the packaged, read-only voice packs that ``VoiceStore``'s
``BuiltinLibrary`` collaborator discovers under
``src/chatterbox_tts/voices_library/<slug>/`` (see that module's
``_scan_slugs`` — any subdir matching ``^[a-z0-9-]{1,32}$`` holding a
``conds.safetensors`` is a valid built-in pack).

Two entry kinds:

- ``model-default``: persists the model's own built-in voice
  (``ChatterboxEngine.default_conditionals()``, read from the weights'
  own ``conds.safetensors`` at load time) — no external clip, no
  licensing question, always available. This is the guaranteed
  baseline pack (``nova``).
- ``clip``: builds conditioning from a reference wav under
  ``scripts/clips/`` (git-ignored — raw audio is never committed, only
  the derived conds + meta) via ``ChatterboxEngine.prepare_conditionals``.
  Every clip entry MUST have its exact source/license/reader recorded in
  ``voices_library/LICENSES.md`` — see that file's per-slug entries.

Idempotent: re-running overwrites every configured pack. Built-in conds
are tied to the exact model id below — a model bump needs a regenerate
(see ``voices_library/LICENSES.md``).

Usage: ``uv run python scripts/build_builtin_voices.py`` (run from the
``ChatterboxTTSService`` project root, e.g.
``capabilityServices/ChatterboxTTSService``).
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf

from chatterbox_tts.chatterbox_mlx import ChatterboxEngine
from chatterbox_tts.pack_meta import CONDS_FILENAME, META_FILENAME

log = logging.getLogger("chatterbox_tts.scripts.build_builtin_voices")

# Matches the deployed default in ~/.sentient/chatterbox-tts/config/config.yaml
# and scripts/download_models.py's DEFAULT_MODEL_ID. Built-in conds are
# model-version-tied (see voices_library/LICENSES.md) — bumping this
# constant means every existing pack needs regenerating.
_MODEL_ID = "mlx-community/Chatterbox-Turbo-TTS-8bit"

# Neutral operating point — matches config.example.yaml's exaggeration/
# cfg_weight (both 0.5). ChatterboxEngine's constructor requires them, but
# neither affects prepare_conditionals()/default_conditionals() (they only
# apply at synthesis time), so any valid value would produce identical
# conds; kept in sync with the shipped config for consistency.
_EXAGGERATION = 0.5
_CFG_WEIGHT = 0.5

# prepare_conditionals() hard-asserts the reference clip is >5s (see
# voice_store.py's _MIN_REF_SECONDS docstring). Require a full extra
# second of margin so a borderline-length source clip never trips that
# assertion.
_MIN_CLIP_SECONDS = 6.0

_SCRIPT_DIR = Path(__file__).resolve().parent
_CLIPS_DIR = _SCRIPT_DIR / "clips"
_LIBRARY_DIR = _SCRIPT_DIR.parent / "src" / "chatterbox_tts" / "voices_library"

EntryKind = Literal["model-default", "clip"]


@dataclass(frozen=True)
class VoiceEntry:
    """One built-in pack to (re)generate."""

    slug: str
    name: str
    description: str
    tags: list[str]
    kind: EntryKind
    clip_filename: str | None = None  # relative to _CLIPS_DIR; required when kind == "clip"


_ENTRIES: list[VoiceEntry] = [
    VoiceEntry(
        slug="nova",
        name="Nova",
        description="Sentient's default voice — warm and clear.",
        tags=["warm", "default"],
        kind="model-default",
    ),
    # Best-effort diversity packs (verifiably CC0/public-domain clips) are
    # appended here when sourced — each MUST have a matching entry in
    # voices_library/LICENSES.md recording source URL, license basis,
    # reader/author, and duration. Nova alone satisfies the built-in
    # discovery contract, so an empty tail here is a valid, complete run.
    #
    # All four below are LibriVox solo-chapter readings (public domain in
    # the US per https://librivox.org/pages/public-domain/ — "all our
    # recordings are public domain ... anyone can use all our recordings
    # however they wish"). Exact source/reader/duration per slug recorded
    # in voices_library/LICENSES.md. Character/tone NOT listen-tested by
    # this generator — see LICENSES.md's top note.
    VoiceEntry(
        slug="wren",
        name="Wren",
        description=(
            'Public-domain LibriVox reading voice (source: "The Bells" by Edgar Allan '
            "Poe, read by Helen Taylor). Character not listen-tested."
        ),
        tags=["public-domain"],
        kind="clip",
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
        kind="clip",
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
        kind="clip",
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
        kind="clip",
        clip_filename="roseanne_hoffman_the_raven.wav",
    ),
]


def _decode_clip(path: Path) -> tuple[np.ndarray, int]:
    """Decode a wav to mono float32 PCM, matching prepare_conditionals()'s expected shape."""
    array, sr = sf.read(str(path), dtype="float32")
    if array.ndim > 1:
        array = array.mean(axis=1).astype(np.float32)
    return array, sr


def _build_conds(engine: ChatterboxEngine, entry: VoiceEntry) -> tuple[object, float]:
    """Produce the Conditionals object for one entry, per its kind.

    Returns ``(conds, duration_s)`` — ``duration_s`` is 0.0 for
    ``model-default`` entries (no external clip to measure).
    """
    if entry.kind == "model-default":
        conds = engine.default_conditionals()
        if conds is None:
            raise RuntimeError(
                f"{entry.slug}: engine.default_conditionals() returned None — "
                "the loaded model has no built-in conds.safetensors"
            )
        return conds, 0.0

    if entry.clip_filename is None:
        raise ValueError(f"{entry.slug}: kind='clip' requires clip_filename")
    clip_path = _CLIPS_DIR / entry.clip_filename
    ref, sr = _decode_clip(clip_path)
    duration_s = ref.size / sr if sr > 0 else 0.0
    if duration_s < _MIN_CLIP_SECONDS:
        raise ValueError(
            f"{entry.slug}: clip {clip_path} is {duration_s:.1f}s, need >= {_MIN_CLIP_SECONDS:.0f}s"
        )
    return engine.prepare_conditionals(ref, sr), duration_s


def _write_pack(entry: VoiceEntry, conds: object) -> Path:
    """Persist one pack: conds.safetensors + meta.json. Idempotent (overwrites)."""
    pack_dir = _LIBRARY_DIR / entry.slug
    pack_dir.mkdir(parents=True, exist_ok=True)
    conds.save(pack_dir / CONDS_FILENAME)
    meta = {"name": entry.name, "description": entry.description, "tags": list(entry.tags)}
    (pack_dir / META_FILENAME).write_text(json.dumps(meta), encoding="utf-8")
    return pack_dir


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr
    )
    log.info(
        "build_builtin_voices.start model_id=%s entries=%d library_dir=%s",
        _MODEL_ID, len(_ENTRIES), _LIBRARY_DIR,
    )
    engine = ChatterboxEngine(_MODEL_ID, _EXAGGERATION, _CFG_WEIGHT)
    for entry in _ENTRIES:
        log.info("build_builtin_voices.entry start slug=%s kind=%s", entry.slug, entry.kind)
        conds, duration_s = _build_conds(engine, entry)
        pack_dir = _write_pack(entry, conds)
        log.info(
            "build_builtin_voices.entry done slug=%s kind=%s duration_s=%.1f pack_dir=%s",
            entry.slug, entry.kind, duration_s, pack_dir,
        )
    log.info("build_builtin_voices.done count=%d", len(_ENTRIES))


if __name__ == "__main__":
    main()
