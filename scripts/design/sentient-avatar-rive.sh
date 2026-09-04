#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSET_DIR="$ROOT/design/prototype/foundation-components/assets/avatars"
SCENE="$ASSET_DIR/sentient-avatar.rive.json"
RIV="$ASSET_DIR/sentient-avatar.riv"
MANIFEST="$ASSET_DIR/sentient-avatar.rive-manifest.json"
RENDER_DIR="${SENTIENT_RIVE_RENDER_DIR:-/tmp/sentient-rive-render}"
CLI="$($ROOT/scripts/design/bootstrap-rive-cli.sh)"
SOURCES=(sentient-mark.svg sentient-avatar-thinking.svg sentient-avatar-responding.svg sentient-avatar.js)

if ! python3 -c 'import PIL' >/dev/null 2>&1; then
  echo "Python Pillow is required for deterministic avatar image verification" >&2
  exit 1
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "sha256sum, shasum, or openssl is required" >&2
    exit 1
  fi
}

generate_to() {
  local output="$1"
  "$CLI" generate "$SCENE" -o "$output"
  "$CLI" validate "$output"
}

update_manifest_hashes() {
  python3 - "$ASSET_DIR" "$MANIFEST" <<'PY'
import hashlib, json, pathlib, sys

assets, manifest_path = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
for name in manifest["source_sha256"]:
    manifest["source_sha256"][name] = hashlib.sha256((assets / name).read_bytes()).hexdigest()
for path_key, hash_key in (("scene", "scene_sha256"), ("riv", "riv_sha256")):
    name = manifest["generated_asset"][path_key]
    manifest["generated_asset"][hash_key] = hashlib.sha256((assets / name).read_bytes()).hexdigest()
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY
}

generate() {
  local temporary
  temporary="$(mktemp "/tmp/sentient-avatar.riv.XXXXXX")"
  generate_to "$temporary"
  mv "$temporary" "$RIV"
  update_manifest_hashes
  echo "generated $RIV ($(sha256 "$RIV")) and refreshed manifest hashes"
}

validate() {
  "$CLI" validate "$RIV"
  python3 - "$ASSET_DIR" "$MANIFEST" <<'PY'
import hashlib, json, pathlib, sys
assets, manifest_path = map(pathlib.Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
checks = {
    manifest["generated_asset"]["scene"]: manifest["generated_asset"]["scene_sha256"],
    manifest["generated_asset"]["riv"]: manifest["generated_asset"]["riv_sha256"],
    **manifest["source_sha256"],
}
for name, expected in checks.items():
    path = assets / name
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"{path}: expected {expected}, got {actual}")
print("manifest hashes match all four canonical sources, SceneSpec, and generated output")
PY
}

render() {
  rm -rf "$RENDER_DIR"
  mkdir -p "$RENDER_DIR"
  local common=(--width 256 --height 256 --scale 2 --background '#2B2621' --preview --contact-sheet)

  "$CLI" render "$RIV" --state-machine Avatar --frames 0,30,60 "${common[@]}" -o "$RENDER_DIR/state-idle"
  "$CLI" render "$RIV" --state-machine Avatar --input toThinking=trigger --frames 0,8,15,60,243,471 "${common[@]}" -o "$RENDER_DIR/state-thinking"
  "$CLI" render "$RIV" --state-machine Avatar --input toResponding=trigger --frames 0,8,15,108,120,201 "${common[@]}" -o "$RENDER_DIR/state-responding"

  local state trigger
  for state in idle thinking responding; do
    case "$state" in
      idle) trigger=toIdle ;;
      thinking) trigger=toThinking ;;
      responding) trigger=toResponding ;;
    esac
    "$CLI" render "$RIV" --state-machine Avatar --input reducedMotion=true --input "$trigger=trigger" \
      --frames 0,1,60,120 "${common[@]}" -o "$RENDER_DIR/reduced-$state"
  done

  "$CLI" render "$RIV" --state-machine Avatar \
    --input toThinking=trigger@10 --input toResponding=trigger@20 --input toIdle=trigger@30 \
    --frames 0,9,15,25,35,60,90 "${common[@]}" -o "$RENDER_DIR/rapid"

  "$CLI" render "$RIV" --state-machine Avatar --frames 60 \
    --width 256 --height 256 --scale 2 --preview -o "$RENDER_DIR/transparent-idle"

  node "$ROOT/scripts/design/capture-sentient-avatar-svg.mjs" "$ASSET_DIR" "$RENDER_DIR/svg-reference"
  node "$ROOT/scripts/design/capture-sentient-avatar-svg.mjs" "$ASSET_DIR" "$RENDER_DIR/svg-reference-repeat"
  python3 - "$RENDER_DIR/svg-reference" "$RENDER_DIR/svg-reference-repeat" <<'PY'
from pathlib import Path
import sys
from PIL import Image, ImageChops, ImageStat

first, second = map(Path, sys.argv[1:])
for name in ("idle.png", "thinking-1.0s.png", "responding-2.0s.png"):
    left = Image.open(first / name).convert("RGBA")
    right = Image.open(second / name).convert("RGBA")
    if left.size != right.size:
        raise SystemExit(f"SVG reference size drift: {name}: {left.size} != {right.size}")
    normalized_mae = sum(ImageStat.Stat(ImageChops.difference(left, right)).mean) / (4 * 255)
    if normalized_mae > 0.0001:
        raise SystemExit(f"nondeterministic SVG reference pixels: {name}: mae={normalized_mae:.6f}")
print("deterministic SVG reference pixels remain within raster tolerance")
PY
  python3 "$ROOT/scripts/design/verify-sentient-avatar-renders.py" "$RENDER_DIR" "$RENDER_DIR/svg-reference"
  echo "render proof and contact sheets: $RENDER_DIR"
}

verify_determinism() {
  local first second
  first="$(mktemp "/tmp/sentient-avatar-first.riv.XXXXXX")"
  second="$(mktemp "/tmp/sentient-avatar-second.riv.XXXXXX")"
  generate_to "$first"
  generate_to "$second"
  local first_hash second_hash canonical_hash
  first_hash="$(sha256 "$first")"
  second_hash="$(sha256 "$second")"
  canonical_hash="$(sha256 "$RIV")"
  if [[ "$first_hash" != "$second_hash" || "$first_hash" != "$canonical_hash" ]]; then
    echo "nondeterministic generation: first=$first_hash second=$second_hash canonical=$canonical_hash" >&2
    exit 1
  fi
  echo "deterministic .riv sha256: $first_hash"
  rm -f "$first" "$second"
}

usage() {
  echo "usage: $0 {generate|validate|render|verify}" >&2
  exit 2
}

case "${1:-}" in
  generate) generate ;;
  validate) validate ;;
  render) validate; render ;;
  verify) validate; verify_determinism; render ;;
  *) usage ;;
esac
