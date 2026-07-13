#!/usr/bin/env bash
# Native launcher for Chatterbox-TTS (Apple Silicon). Manages a launchd
# LaunchAgent so the service survives reboots and logs under
# ~/.sentient/chatterbox-tts/logs/. Chatterbox weights are fetched by
# mlx-audio from HuggingFace at runtime (cached under
# ~/.cache/huggingface); this script pre-warms that cache at install time
# via download_models.py so the first real synthesis request isn't the one
# paying for the download. Native-only — Chatterbox-TTS has no docker
# fallback (Apple-silicon MLX/Metal only), unlike STT's native-vs-docker
# choice; see deploy.conf.
set -euo pipefail

LABEL="io.dev32.sentient.chatterbox-tts"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SVC_DIR="$REPO_ROOT/capabilityServices/ChatterboxTTSService"
VENV="$SVC_DIR/.venv"
DATA="$HOME/.sentient/chatterbox-tts"
# Deployed default model — the Turbo variant. Kept as one shell variable so
# the config.yaml seed and the download_models.py warm-fetch can never drift
# apart. config/config.example.yaml intentionally ships a non-Turbo id
# instead (see that file's comment) so config-parsing tests never need
# network access; this script overrides it at seed time.
MODEL_ID="mlx-community/Chatterbox-Turbo-TTS-8bit"

cmd_install() {
  mkdir -p "$DATA/config" "$DATA/logs" "$DATA/voices" "$DATA/models" "$HOME/Library/LaunchAgents"
  if [ ! -f "$DATA/config/config.yaml" ]; then
    cp "$SVC_DIR/config/config.example.yaml" "$DATA/config/config.yaml"
    # Pin the deployed config to the Turbo model. `#` delimiter because
    # MODEL_ID contains `/`. Only runs on first seed, so operator edits
    # survive re-running install.
    sed -i '' "s#^model: .*#model: ${MODEL_ID}#" "$DATA/config/config.yaml"
  fi
  # Homebrew preflight — opuslib loads native libopus via ctypes at import
  # time, so `python -m chatterbox_tts` crashes at import if libopus is
  # absent. ffmpeg backs soundfile's broader format support. Idempotent:
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
  PYTHONPATH="$SVC_DIR/src" "$VENV/bin/python" "$SVC_DIR/scripts/download_models.py" "$DATA/models" "$MODEL_ID"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${VENV}/bin/python</string>
    <string>-m</string>
    <string>chatterbox_tts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PYTHONPATH</key><string>${SVC_DIR}/src</string>
    <key>CHATTERBOX_TTS_CONFIG_PATH</key><string>${DATA}/config/config.yaml</string>
    <key>CHATTERBOX_TTS_MODEL_DIR</key><string>${DATA}/models</string>
    <key>CHATTERBOX_TTS_LOG_DIR</key><string>${DATA}/logs</string>
    <key>CHATTERBOX_TTS_VOICE_DIR</key><string>${DATA}/voices</string>
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
  curl -s --max-time 3 http://127.0.0.1:8771/health || echo "(health unreachable)"
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
