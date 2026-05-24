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
