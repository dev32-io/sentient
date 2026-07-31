#!/usr/bin/env bash
# Project environment setup — source this before running bun commands.
# Used by quality-gate.sh, lefthook hooks, CI, and Claude Code.

# esp32-devtool: unified ESP32 dev CLI
_DEVTOOL_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$_DEVTOOL_REPO_ROOT" ]; then
  export PATH="$_DEVTOOL_REPO_ROOT/esp32/devtool/bin:$PATH"
fi
unset _DEVTOOL_REPO_ROOT

# Bun: installed via bun.sh, lives in ~/.bun/bin
if [ -d "$HOME/.bun/bin" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Verify bun is available
if ! command -v bun &>/dev/null; then
  echo "ERROR: bun not found. Install with: curl -fsSL https://bun.sh/install | bash" >&2
  return 1 2>/dev/null || exit 1
fi

# ---------------------------------------------------------------------------
# Dev mirrors PROD. The launchd plist sets these two on the mini; unset in dev,
# the gateway silently degrades in ways that hide real defects:
#
#   HOST_CONFIG_DIR  — host side of the bind mounts in the addon templates.
#     Unset, egress-proxy and searxng never start, so every internal-only
#     container loses DNS and web search/fetch fail with "Temporary failure in
#     name resolution" that looks like a broken MCP rather than a missing mount.
#
#   SENTIENT_CODE    — root of the native addons' code. Unset, argv[0] resolves
#     to a nonexistent path, prepare() refuses to spawn, and the gateway runs
#     WITHOUT supervising its own native addons — the orchestrator's whole
#     native path goes unexercised while the stack looks healthy.
#
# Only the build flavour should differ between dev and prod (debug vs release),
# never the layout. scripts/dev-stage-code.sh builds the prod-shaped tree.
# ---------------------------------------------------------------------------
export HOST_CONFIG_DIR="${HOST_CONFIG_DIR:-$HOME/.sentient/gateway/config}"
export SENTIENT_CODE="${SENTIENT_CODE:-$HOME/.sentient/dev-code}"

if [ ! -x "$SENTIENT_CODE/whisper-stt/venv/bin/python" ]; then
  echo "WARN: $SENTIENT_CODE is not staged — run scripts/dev-stage-code.sh" >&2
fi
