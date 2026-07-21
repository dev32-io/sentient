"""Additively reconcile a native service config against its shipped template.

The native launchers (local-tts.sh / whisper-stt.sh) seed the mounted service
config from config.example.yaml ONLY on first install ("cp if absent"), then
never touch it again — so operator edits and the model pin survive re-deploys.

The gap this closes: when a NEW REQUIRED top-level key is added to a service's
config schema (e.g. local-tts `text_frontend`), an already-seeded host config
never gains it, and the service's fail-loud loader then crashes on startup
(`ConfigError: missing required section '...'`). That took prod's TTS down once
already — the seed-only-if-absent step cannot migrate an existing config.

This reconciler fills that gap WITHOUT clobbering. It copies any top-level key
present in the template but ABSENT from the target — value AND its leading
comment — into the target, and touches nothing that already exists. Existing
values (model pin, tuned constants, operator edits) are preserved; only
genuinely-missing top-level sections are added, so the service's fail-loud
loader always finds every required key after a deploy.

Scope: top-level keys only. A newly-required NESTED key (e.g. `server.foo`)
still needs a bespoke migration — deliberately out of scope, to keep this
strictly additive and safe.

Comment-preserving round-trip via ruamel.yaml (same dependency + style as the
sibling tts-backend.py / stt-backend.py value-rewriters).

Dry-run by default (prints a unified diff). Pass --apply to write.

Usage:
  python service-config-reconcile.py --template <example.yaml> --config <host.yaml>
  python service-config-reconcile.py --template <example.yaml> --config <host.yaml> --apply
"""

from __future__ import annotations

import argparse
import difflib
import io
import sys
from pathlib import Path

NO_CHANGE = "no change needed"


def _yaml():
    try:
        from ruamel.yaml import YAML
    except ImportError:
        print("ruamel.yaml required: pip install ruamel.yaml", file=sys.stderr)
        raise SystemExit(2)
    y = YAML()
    y.preserve_quotes = True
    # Match the service configs' block style (2-space mapping indent).
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def _dump(yaml, data) -> str:
    buf = io.StringIO()
    yaml.dump(data, buf)
    return buf.getvalue()


def reconcile(template_text: str, config_text: str) -> tuple[str, list[str]]:
    """Return (updated_text, added_keys). Additive-only, comment-preserving.

    Only top-level keys missing from the target are added; existing keys and
    their values are never modified or reordered.
    """
    yaml = _yaml()
    template = yaml.load(template_text)
    config = yaml.load(config_text)
    if config is None:  # blank/empty target — treat every template key as missing
        config = yaml.load("{}\n")

    added: list[str] = []
    for key in template:
        if key in config:
            continue
        # Copy value + its INNER comments (per-field comments live inside the
        # value's CommentedMap and travel with it). We deliberately do NOT copy
        # the key's `.ca` entry: ruamel often stores a block comment there that
        # actually belongs to the FOLLOWING key, which would duplicate that
        # header into the target. Losing a section-header comment is a fair
        # trade for not corrupting surrounding comments.
        config[key] = template[key]
        added.append(key)

    return _dump(yaml, config), added


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--template", required=True, type=Path, help="shipped config.example.yaml")
    ap.add_argument("--config", required=True, type=Path, help="host service config.yaml to reconcile")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run diff)")
    args = ap.parse_args()

    if not args.template.is_file():
        print(f"template not found: {args.template}", file=sys.stderr)
        return 2
    if not args.config.is_file():
        # First-install seeding is the launcher's job; a missing target is not
        # this tool's concern — report a clean no-op.
        print(f"{NO_CHANGE} (target config absent: {args.config})")
        return 0

    template_text = args.template.read_text(encoding="utf-8")
    original = args.config.read_text(encoding="utf-8")
    updated, added = reconcile(template_text, original)

    if not added:
        print(NO_CHANGE)
        return 0

    diff = difflib.unified_diff(
        original.splitlines(keepends=True),
        updated.splitlines(keepends=True),
        fromfile=str(args.config),
        tofile=f"{args.config} (reconciled: +{', '.join(added)})",
    )
    sys.stdout.writelines(diff)

    if args.apply:
        args.config.write_text(updated, encoding="utf-8")
        print(f"\n[reconcile] added missing section(s): {', '.join(added)} → {args.config}")
    else:
        print("\n[reconcile] dry-run — re-run with --apply to write")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
