#!/usr/bin/env bash
# Native launcher for local-tts (Qwen3-TTS, Apple Silicon). Manages a launchd
# LaunchAgent so the service survives reboots and logs under
# ~/.sentient/local-tts/logs/. Qwen3-TTS weights are fetched by mlx-audio
# from HuggingFace at runtime (cached under ~/.cache/huggingface); this
# script pre-warms that cache at install time via download_models.py so the
# first real synthesis request isn't the one paying for the download.
# Native-only — local-tts has no docker fallback (Apple-silicon MLX/Metal
# only), unlike STT's native-vs-docker choice; see deploy.conf.
set -euo pipefail

LABEL="io.dev32.sentient.local-tts"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SVC_DIR="$REPO_ROOT/capabilityServices/LocalTTSService"
VENV="$SVC_DIR/.venv"
DATA="$HOME/.sentient/local-tts"
# Deployed default model. Kept as one shell variable so the config.yaml seed
# and the download_models.py warm-fetch can never drift apart.
# config/config.example.yaml already ships this same qwen id — the seed
# below isn't papering over a divergence, it's drift-safety: without it, an
# operator's later edit to config.example.yaml (e.g. bumping to a newer
# quant) would silently change the deployed model on the next fresh install.
MODEL_ID="mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"

cmd_install() {
  mkdir -p "$DATA/config" "$DATA/logs" "$DATA/voices" "$DATA/models" "$HOME/Library/LaunchAgents"
  if [ ! -f "$DATA/config/config.yaml" ]; then
    cp "$SVC_DIR/config/config.example.yaml" "$DATA/config/config.yaml"
    # Pin the deployed config to the qwen model. `#` delimiter because
    # MODEL_ID contains `/`. Only runs on first seed, so operator edits
    # survive re-running install.
    sed -i '' "s#^model: .*#model: ${MODEL_ID}#" "$DATA/config/config.yaml"
  fi
  # Homebrew preflight — `opuslib` is a declared-but-unused fallback dep
  # (OpusEncoder actually writes OGG-Opus via soundfile/libsndfile, not
  # opuslib's ctypes bindings); libopus is still required because
  # libsndfile's OGG container writer needs it to support the OPUS
  # subtype — without it, `soundfile.SoundFile(..., format="OGG",
  # subtype="OPUS")` raises at synthesis time, not at import time.
  # ffmpeg backs soundfile's broader format support. Idempotent: no-op
  # when already installed, and a soft warning (not a hard fail) when
  # Homebrew is missing so the operator can install the libs by hand.
  if command -v brew >/dev/null 2>&1; then
    brew list opus        >/dev/null 2>&1 || brew install opus
    brew list ffmpeg      >/dev/null 2>&1 || brew install ffmpeg
    # Python 3.11 is the validated interpreter for local-tts (pyproject
    # requires-python >=3.11; the mlx-audio / soxr / soundfile / opuslib deps
    # are pinned + tested there). The host's system python3 may be newer — the
    # sibling whisper-stt service runs on 3.14 — and newer Pythons lack working
    # wheels for these native deps, breaking synthesis at import/runtime. Each
    # service owns its own .venv, so a dedicated 3.11 here coexists with
    # whatever interpreter the other native services use.
    brew list python@3.11 >/dev/null 2>&1 || brew install python@3.11
  else
    echo "WARN: Homebrew not found — install libopus + ffmpeg + python@3.11 manually (libsndfile's OGG/Opus writer needs libopus; local-tts is validated on Python 3.11)." >&2
  fi
  # Resolve the pinned 3.11 interpreter: explicit override first, then a PATH
  # python3.11, then the brew keg's versioned binary. Fail loudly rather than
  # silently building the venv on a newer system python that breaks later.
  PYTHON_BIN="${LOCAL_TTS_PYTHON:-$(command -v python3.11 2>/dev/null || true)}"
  [ -n "$PYTHON_BIN" ] || PYTHON_BIN="$(brew --prefix python@3.11 2>/dev/null)/bin/python3.11"
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1 && [ ! -x "$PYTHON_BIN" ]; then
    echo "ERROR: python3.11 not found — local-tts needs it for its venv (set LOCAL_TTS_PYTHON or run 'brew install python@3.11')." >&2
    exit 1
  fi
  [ -d "$VENV" ] || "$PYTHON_BIN" -m venv "$VENV"
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
    <string>local_tts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PYTHONPATH</key><string>${SVC_DIR}/src</string>
    <key>LOCAL_TTS_CONFIG_PATH</key><string>${DATA}/config/config.yaml</string>
    <key>LOCAL_TTS_MODEL_DIR</key><string>${DATA}/models</string>
    <key>LOCAL_TTS_LOG_DIR</key><string>${DATA}/logs</string>
    <key>LOCAL_TTS_VOICE_DIR</key><string>${DATA}/voices</string>
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
