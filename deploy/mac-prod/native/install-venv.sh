#!/usr/bin/env bash
# Create a service venv from VENDORED WHEELS ONLY. --no-index is what
# guarantees no PyPI access; if a wheel is missing this fails loudly rather
# than silently falling back to the network.
#
# Interpreter resolution mirrors scripts/build-python-wheels.sh and the
# deploy/mac-prod/native/{local-tts,whisper-stt}.sh launchers exactly:
# explicit env override, then a PATH python$PYVER, then the Homebrew keg.
# Every path fails LOUD — this script must never silently build a venv on
# the wrong interpreter minor, because pip installing a 3.14-built wheel
# into a 3.11 venv (or vice versa) fails at import time, not install time,
# which is far harder to diagnose than a refusal up front.
set -euo pipefail
SERVICE="${1:?service name required}"
VENV="${2:?venv dir required}"
WHEELS="${3:?wheels dir required}"

case "$SERVICE" in
  whisper-stt) PYVER=3.14; OVERRIDE_VAR=WHISPER_STT_PYTHON ;;
  local-tts)   PYVER=3.11; OVERRIDE_VAR=LOCAL_TTS_PYTHON ;;   # mlx-audio has no 3.14 wheels
  *) echo "FAIL: unknown service $SERVICE" >&2; exit 1 ;;
esac

OVERRIDE="${!OVERRIDE_VAR:-}"
PY="${OVERRIDE:-$(command -v "python$PYVER" 2>/dev/null || true)}"
if [ -z "$PY" ]; then
  PY="$(brew --prefix "python@$PYVER" 2>/dev/null)/bin/python$PYVER"
fi
if [ ! -x "$PY" ] && ! command -v "$PY" >/dev/null 2>&1; then
  echo "FAIL: python$PYVER not found (set \$$OVERRIDE_VAR, put python$PYVER on PATH, or 'brew install python@$PYVER')" >&2
  exit 1
fi

# Verify BEFORE installing: a venv on the wrong minor accepts the command and
# then fails to import at runtime, which is far harder to diagnose.
ACTUAL="$("$PY" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
[ "$ACTUAL" = "$PYVER" ] || { echo "FAIL: expected python $PYVER, got $ACTUAL (resolved: $PY)" >&2; exit 1; }

if [ ! -d "$WHEELS" ] || [ -z "$(ls -A "$WHEELS" 2>/dev/null)" ]; then
  echo "FAIL: wheels dir $WHEELS missing or empty — run scripts/build-python-wheels.sh first" >&2
  exit 1
fi

"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --no-index --find-links="$WHEELS" \
  -r "$(dirname "$0")/requirements/$SERVICE.lock"
echo "✓ $SERVICE venv ready at $VENV"
