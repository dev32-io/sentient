#!/usr/bin/env bash
# Native launcher for Whisper-STT (Apple Silicon). Manages a launchd
# LaunchAgent so the service survives reboots and logs under
# ~/.sentient/whisper-stt/logs/. Whisper weights are fetched by mlx at
# runtime; only Smart-Turn is pre-downloaded here.
set -euo pipefail

LABEL="io.dev32.sentient.whisper-stt"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SVC_DIR="$REPO_ROOT/capabilityServices/WhisperSTTService"
VENV="$SVC_DIR/.venv"
DATA="$HOME/.sentient/whisper-stt"

cmd_install() {
  mkdir -p "$DATA/config" "$DATA/logs" "$DATA/recordings" "$DATA/models" "$HOME/Library/LaunchAgents"
  [ -f "$DATA/config/config.yaml" ] || cp "$SVC_DIR/config/config.example.yaml" "$DATA/config/config.yaml"
  # Homebrew preflight — opuslib loads native libopus via ctypes at import
  # time, so `python -m whisper_stt` crashes at import if libopus is absent
  # (even for PCM16-only use). ffmpeg is used by the Phase-2 smoke. Idempotent:
  # no-op when already installed, and a soft warning (not a hard fail) when
  # Homebrew is missing so the operator can install the libs by hand.
  if command -v brew >/dev/null 2>&1; then
    brew list opus        >/dev/null 2>&1 || brew install opus
    brew list ffmpeg      >/dev/null 2>&1 || brew install ffmpeg
    # Python 3.14 is the validated interpreter for whisper-stt (its
    # mlx-whisper / silero-vad / onnxruntime deps ship working wheels there and
    # the service is developed + run on it). Pin it explicitly so a future bump
    # of the host's unversioned `python3` can't silently rebuild this venv on an
    # untested interpreter. The sibling local-tts pins 3.11 (mlx-audio lacks
    # 3.14 wheels) — each service owns its own .venv, so the two coexist.
    brew list python@3.14 >/dev/null 2>&1 || brew install python@3.14
  else
    echo "WARN: Homebrew not found — install libopus + ffmpeg + python@3.14 manually (opuslib needs libopus at import; whisper-stt is validated on Python 3.14)." >&2
  fi
  # Resolve the pinned 3.14 interpreter: explicit override first, then a PATH
  # python3.14, then the brew keg's versioned binary. Fail loudly rather than
  # silently building the venv on a different system python.
  PYTHON_BIN="${WHISPER_STT_PYTHON:-$(command -v python3.14 2>/dev/null || true)}"
  [ -n "$PYTHON_BIN" ] || PYTHON_BIN="$(brew --prefix python@3.14 2>/dev/null)/bin/python3.14"
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [ ! -x "$PYTHON_BIN" ]; then
    echo "ERROR: python3.14 not found — whisper-stt needs it for its venv (set WHISPER_STT_PYTHON or run 'brew install python@3.14')." >&2
    exit 1
  fi
  [ -d "$VENV" ] || "$PYTHON_BIN" -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$SVC_DIR/requirements.txt"
  PYTHONPATH="$SVC_DIR/src" "$VENV/bin/python" "$SVC_DIR/scripts/download_models.py" "$DATA/models"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${VENV}/bin/python</string>
    <string>-m</string>
    <string>whisper_stt</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PYTHONPATH</key><string>${SVC_DIR}/src</string>
    <key>WHISPER_STT_CONFIG_PATH</key><string>${DATA}/config/config.yaml</string>
    <key>WHISPER_STT_MODEL_DIR</key><string>${DATA}/models</string>
    <key>WHISPER_STT_LOG_DIR</key><string>${DATA}/logs</string>
    <key>WHISPER_STT_RECORDING_DIR</key><string>${DATA}/recordings</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${DATA}/logs/launchd.err.log</string>
</dict></plist>
PLIST
  echo "installed ${PLIST}"
}

cmd_start()  { launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"; echo "started ${LABEL}"; }
cmd_stop()   { launchctl unload "$PLIST" 2>/dev/null || true; echo "stopped ${LABEL}"; }
cmd_status() {
  launchctl list | grep "$LABEL" || echo "not loaded"
  curl -s http://127.0.0.1:8769/health || echo "(health unreachable)"
  echo
}
cmd_logs()   { tail -n 100 -f "$DATA/logs/launchd.err.log"; }

case "${1:-}" in
  install) cmd_install ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *) echo "usage: $0 {install|start|stop|status|logs}"; exit 2 ;;
esac
