"""Shared voice-pack metadata reader for ``VoiceStore`` and ``BuiltinLibrary``.

A "voice pack" is a directory containing a raw reference wav (used by
Qwen3-TTS's speaker encoder to clone a voice at synth time — no
precomputed conditioning) plus a small JSON metadata record
(``meta.json``):

    <pack_dir>/ref.wav    # mono float32 reference clip (soundfile.write/.read)
    <pack_dir>/meta.json  # {name, description, tags, language, createdAt, refDurationMs}

Both ``VoiceStore`` (user-created packs under ``voice_dir``) and
``BuiltinLibrary`` (read-only shipped packs under ``builtin_dir``) read
that metadata through the same normalized shape. This module is the one
place that mapping lives, so the two collaborators never drift.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

log = logging.getLogger("local_tts.pack_meta")

REF_FILENAME = "ref.wav"
META_FILENAME = "meta.json"


def read_pack_meta(entry: Path) -> dict | None:
    """Load one pack's ``meta.json``, tagged with its ``voiceId``; ``None`` if unreadable."""
    meta_path = entry / META_FILENAME
    if not meta_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("pack_meta.read bad_meta voice_id=%s error=%s", entry.name, exc)
        return None
    return {
        "voiceId": entry.name,
        "name": meta.get("name", ""),
        "description": meta.get("description", ""),
        "tags": meta.get("tags", []),
        "language": meta.get("language", ""),
        "createdAt": meta.get("createdAt", 0.0),
        "refDurationMs": meta.get("refDurationMs", 0),
    }
