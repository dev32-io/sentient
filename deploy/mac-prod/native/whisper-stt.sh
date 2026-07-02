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
    brew list opus   >/dev/null 2>&1 || brew install opus
    brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
  else
    echo "WARN: Homebrew not found — install libopus + ffmpeg manually (opuslib needs libopus at import)." >&2
  fi
  [ -d "$VENV" ] || python3 -m venv "$VENV"
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
