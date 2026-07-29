#!/usr/bin/env bash
# Build vendored wheels for every native Python service, so the installer can
# run fully offline (deploy/mac-prod/native/install-venv.sh --no-index's the
# PyPI install). Wheels are arm64 macOS and MUST be built against each
# service's PINNED interpreter — a wheel built for 3.11 will not install into
# a 3.14 venv, and the failure is confusing (it looks like a missing
# package, not a Python-version mismatch).
#
# THIS SCRIPT RUNS ON THE BUILD HOST, NOT THE MINI. Its output is baked into
# the release tarball and unpacked on the mini, so every wheel it produces must
# be installable on the mini's macOS — see the platform-floor block below.
#
# Pipeline (the lock's own header documents how to regenerate the versions):
#   1. strip --hash from the lock  -> a versions-only requirements file
#   2. pip wheel                   -> dist/wheels/<service>/
#   3. rehash-python-lock.py       -> rewrite the lock's hashes to match (2)
# Step 1 is not optional: the committed lock's hashes describe the VENDORED
# artifacts, and for a package built from source those can never equal the
# upstream sdist hash pip would check here. Feeding the lock to `pip wheel`
# unstripped fails with "THESE PACKAGES DO NOT MATCH THE HASHES".
#
# Interpreter resolution mirrors deploy/mac-prod/native/{local-tts,whisper-stt}.sh
# exactly, so an operator who already set LOCAL_TTS_PYTHON / WHISPER_STT_PYTHON
# for the launchers gets the same interpreter here: explicit env override,
# then a PATH python$PYVER, then the Homebrew keg. Fails loudly (not a network
# fallback) when none resolve — see deploy/mac-prod/native/install-venv.sh for
# the matching offline-install half of this contract.
set -euo pipefail
# Run from the repo root and keep every path relative: these paths are echoed
# into the committed lock's regenerate recipe, and an absolute path there is a
# build-host detail baked into a checked-in artifact.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REQ="deploy/mac-prod/native/requirements"
OUT="dist/wheels"

# Minimum macOS a source-built wheel is tagged for. Without this, a wheel
# compiled here is tagged with the BUILD HOST's SDK version (macosx_26_0 on a
# macOS 26 box) and pip on an older mini rejects it as an unsupported platform
# — an offline-install failure on the one machine this script exists to serve.
# Valid: any released macOS version string; 11.0 is the arm64 floor (the first
# macOS with Apple silicon) and there is no reason to raise it.
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"

# Highest macOS a PUBLISHED wheel in the vendored set may require. This is a
# separate knob from the floor above because we do not control upstream tags:
# mlx/mlx-metal publish macosx_14_0, _15_0 AND _26_0 wheels, and pip picks the
# most specific one the BUILD HOST can run. So the vendored set silently
# inherits the build host's OS. The gate below turns that into a build-time
# failure with a named cause instead of a deploy-time one on the mini.
# Valid: any released macOS version. Raising it asserts the mini is at least
# that new; lowering it requires building on an older host.
WHEEL_MACOS_CEILING="${WHEEL_MACOS_CEILING:-26.0}"

REHASH="scripts/rehash-python-lock.py"

resolve_python() {
  local pyver="$1" override_var="$2"
  local override="${!override_var:-}"
  local py="${override:-$(command -v "python$pyver" 2>/dev/null || true)}"
  # `command -v brew` guard is load-bearing, not defensive noise: under
  # `set -e` a bare assignment from a missing command aborts the whole script
  # with bash's own "brew: command not found" / exit 127, so the named-cause
  # message below would never print on a Homebrew-less host.
  if [ -z "$py" ] && command -v brew >/dev/null 2>&1; then
    py="$(brew --prefix "python@$pyver" 2>/dev/null)/bin/python$pyver"
  fi
  if [ ! -x "$py" ] && ! command -v "$py" >/dev/null 2>&1; then
    echo "FAIL: python$pyver not found (set \$$override_var, put python$pyver on PATH, or 'brew install python@$pyver')" >&2
    return 1
  fi
  echo "$py"
}

# Compare two dotted macOS versions; 0 when $1 <= $2. `sort -V` is the whole
# implementation — bash has no version comparison and string compare gets
# 10.15 vs 9.0 wrong.
version_lte() {
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]
}

assert_platform_floor() {
  local service="$1" offenders=()
  local wheel tag version
  for wheel in "$OUT/$service"/*.whl; do
    for tag in $(grep -oE 'macosx_[0-9]+_[0-9]+' <<<"$(basename "$wheel")" || true); do
      version="${tag#macosx_}"
      version="${version//_/.}"
      version_lte "$version" "$WHEEL_MACOS_CEILING" || offenders+=("$(basename "$wheel")")
    done
  done
  if [ ${#offenders[@]} -gt 0 ]; then
    echo "FAIL: $service vendored wheels require macOS newer than $WHEEL_MACOS_CEILING and will not install on the mini:" >&2
    printf '  %s\n' "${offenders[@]}" >&2
    echo "Build on an older host, or raise WHEEL_MACOS_CEILING once the mini is confirmed that new." >&2
    return 1
  fi
  echo "    platform floor OK: every $service wheel installs on macOS $WHEEL_MACOS_CEILING or newer"
}

build() {
  local service="$1" pyver="$2" override_var="$3" requirements="$4"
  local py
  py="$(resolve_python "$pyver" "$override_var")" || exit 1
  echo "==> $service (python$pyver: $py, MACOSX_DEPLOYMENT_TARGET=$MACOSX_DEPLOYMENT_TARGET)"
  rm -rf "$OUT/$service"; mkdir -p "$OUT/$service"
  local unhashed; unhashed="$(mktemp)"
  grep -v -- '--hash=' "$REQ/$service.lock" | sed 's/[[:space:]]*\\$//' > "$unhashed"
  "$py" -m pip wheel -r "$unhashed" -w "$OUT/$service"
  rm -f "$unhashed"
  assert_platform_floor "$service"
  "$py" "$REHASH" --lock "$REQ/$service.lock" --wheels "$OUT/$service" \
    --service "$service" --requirements "$requirements" --venv "${requirements%/*}/.venv/bin/python"
}

build whisper-stt 3.14 WHISPER_STT_PYTHON capabilityServices/WhisperSTTService/requirements.txt
# 3.11 REQUIRED: mlx-audio ships no 3.14 wheels
build local-tts 3.11 LOCAL_TTS_PYTHON capabilityServices/LocalTTSService/requirements.txt

echo "✓ wheels in $OUT"
