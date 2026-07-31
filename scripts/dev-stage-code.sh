#!/usr/bin/env bash
# Stage a dev SENTIENT_CODE root that mirrors the PROD layout.
#
# WHY THIS EXISTS. gateway/config.yaml addresses the native addons by their
# production shape — ${SENTIENT_CODE}/whisper-stt/venv/bin/python and
# ${SENTIENT_CODE}/local-tts/src — because that is what the installer lays down
# under /opt/sentient/current. The repo does not have that shape: the services
# live at capabilityServices/WhisperSTTService and .../LocalTTSService, and
# their virtualenvs are `.venv`, not `venv`.
#
# Pointing SENTIENT_CODE straight at the checkout therefore fails — argv[0]
# resolves to a path that does not exist, prepare() refuses to spawn, and the
# gateway comes up NOT supervising its own native addons. That divergence is
# what let a whole class of orchestrator behaviour go unexercised in dev while
# looking fine, so dev mirrors prod by construction here: same layout, same
# paths, only the build flavour differs (debug vs release).
#
# Symlinks, not copies — a code edit must take effect without re-staging.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${SENTIENT_DEV_CODE:-$HOME/.sentient/dev-code}"

# service-dir-under-stage : source dir in the checkout
SERVICES=(
  "whisper-stt:capabilityServices/WhisperSTTService"
  "local-tts:capabilityServices/LocalTTSService"
)

mkdir -p "$STAGE"

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  src="$REPO_ROOT/${entry#*:}"

  if [ ! -d "$src" ]; then
    echo "ERROR: $src does not exist — cannot stage $name" >&2
    exit 1
  fi

  mkdir -p "$STAGE/$name"

  # venv: prod calls it `venv`, the repo calls it `.venv`. This rename is the
  # entire reason the stage cannot just be a symlink to the checkout.
  if [ ! -d "$src/.venv" ]; then
    echo "ERROR: $src/.venv missing — create it first (see the service's README)" >&2
    exit 1
  fi
  ln -sfn "$src/.venv" "$STAGE/$name/venv"
  ln -sfn "$src/src" "$STAGE/$name/src"
done

echo "staged SENTIENT_CODE at $STAGE"
for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  py="$STAGE/$name/venv/bin/python"
  if [ -x "$py" ]; then
    echo "  $name  $("$py" --version 2>&1)"
  else
    echo "  $name  MISSING INTERPRETER at $py" >&2
  fi
done
