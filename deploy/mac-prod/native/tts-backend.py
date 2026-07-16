"""Point the gateway's TTS backend at the native local-tts (Qwen3-TTS)
service in a gateway config.yaml (comment-preserving).

local-tts is native-only (Apple-silicon MLX/Metal) — unlike STT there
is no docker-fallback backend to select between, so unlike its
stt-backend.py sibling this script takes no --backend flag; it always
points the gateway at the native LaunchAgent's WebSocket + health
endpoints:

  tts.url                    -> ws://host.docker.internal:8770
  companions.tts_health_url  -> http://host.docker.internal:8771/health

Both keys are missing-key-guarded: if a target key isn't present in the
config (e.g. a legacy gateway/config.yaml written before the local-tts
cutover, with no tts.url/companions.tts_health_url at all), that
replacement is silently skipped rather than inventing new keys — this
script only ever rewrites values, never adds config shape. The gateway
config schema ships these keys with correct defaults, so a freshly-seeded
config already has the right values and this is a no-op.

Dry-run by default (prints a unified diff). Pass --apply to write.

Usage:
  python tts-backend.py --config ~/.sentient/gateway/config.yaml
  python tts-backend.py --config ~/.sentient/gateway/config.yaml --apply
"""

from __future__ import annotations

import argparse
import difflib
import io
import sys
from pathlib import Path

TTS_URL = "ws://host.docker.internal:8770"
TTS_HEALTH_URL = "http://host.docker.internal:8771/health"


def _load_yaml():
    # ruamel's default round-trip loader (typ="rt") is SAFE: unlike PyYAML's
    # yaml.load(), it does NOT construct arbitrary Python from !!python/object
    # tags (only ruamel typ="unsafe" would). Input here is the operator's own
    # local gateway config, and round-trip mode is required to preserve comments.
    try:
        from ruamel.yaml import YAML
    except ImportError:
        print("ruamel.yaml required: pip install ruamel.yaml", file=sys.stderr)
        sys.exit(2)
    y = YAML()  # typ="rt" (round-trip) — comment-preserving, no arbitrary-object construction
    y.preserve_quotes = True
    # Match the gateway config's block style so the diff stays surgical: dashes
    # sit at parent+2, sequence content at parent+4 (ruamel's default of
    # sequence=2/offset=0 would re-indent every unrelated list). A wide line
    # limit stops ruamel from re-wrapping long inline (flow) lists.
    y.indent(mapping=2, sequence=4, offset=2)
    y.width = 4096
    return y


def transform(text: str) -> str:
    yaml = _load_yaml()
    doc = yaml.load(text)

    # null-safe: a present-but-empty `tts:`/`companions:` (a plausible transient
    # state while an operator edits the config) yields None, not a dict.
    if "url" in (doc.get("tts") or {}):
        doc["tts"]["url"] = TTS_URL
    if "tts_health_url" in (doc.get("companions") or {}):
        doc["companions"]["tts_health_url"] = TTS_HEALTH_URL

    buf = io.StringIO()
    yaml.dump(doc, buf)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    original = args.config.read_text(encoding="utf-8")
    updated = transform(original)

    if original == updated:
        print("[tts-backend] no change needed")
        return

    diff = difflib.unified_diff(
        original.splitlines(keepends=True),
        updated.splitlines(keepends=True),
        fromfile=str(args.config),
        tofile=f"{args.config} (native-local-tts)",
    )
    sys.stdout.writelines(diff)

    if args.apply:
        args.config.write_text(updated, encoding="utf-8")
        print(f"\n[tts-backend] applied native-local-tts to {args.config}")
    else:
        print("\n[tts-backend] dry-run — re-run with --apply to write")


if __name__ == "__main__":
    main()
