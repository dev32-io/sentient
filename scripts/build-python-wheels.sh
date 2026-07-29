#!/usr/bin/env bash
# Build vendored wheels for every native Python service, so the installer can
# run fully offline (deploy/mac-prod/native/install-venv.sh --no-index's the
# PyPI install). Wheels are arm64 macOS and MUST be built against each
# service's PINNED interpreter — a wheel built for 3.11 will not install into
# a 3.14 venv, and the failure is confusing (it looks like a missing
# package, not a Python-version mismatch).
#
# Interpreter resolution mirrors deploy/mac-prod/native/{local-tts,whisper-stt}.sh
# exactly, so an operator who already set LOCAL_TTS_PYTHON / WHISPER_STT_PYTHON
# for the launchers gets the same interpreter here: explicit env override,
# then a PATH python$PYVER, then the Homebrew keg. Fails loudly (not a network
# fallback) when none resolve — see deploy/mac-prod/native/install-venv.sh for
# the matching offline-install half of this contract.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQ="$REPO/deploy/mac-prod/native/requirements"
OUT="$REPO/dist/wheels"

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

build() {
  local service="$1" pyver="$2" override_var="$3"
  local py
  py="$(resolve_python "$pyver" "$override_var")" || exit 1
  echo "==> $service (python$pyver: $py)"
  rm -rf "$OUT/$service"; mkdir -p "$OUT/$service"
  "$py" -m pip wheel -r "$REQ/$service.lock" -w "$OUT/$service"
}

build whisper-stt 3.14 WHISPER_STT_PYTHON
build local-tts   3.11 LOCAL_TTS_PYTHON   # 3.11 REQUIRED: mlx-audio ships no 3.14 wheels

echo "✓ wheels in $OUT"
