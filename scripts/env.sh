#!/usr/bin/env bash
# Project environment setup — source this before running bun commands.
# Used by quality-gate.sh, lefthook hooks, CI, and Claude Code.

# esp32-devtool: unified ESP32 dev CLI
_DEVTOOL_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$_DEVTOOL_REPO_ROOT" ]; then
  export PATH="$_DEVTOOL_REPO_ROOT/esp32/devtool/bin:$PATH"
fi
unset _DEVTOOL_REPO_ROOT

# Java: Gradle requires JDK 21. Keep a caller-selected installation, but make
# clean macOS shells independent of the interactive PATH and Java registry.
_java_home_is_runnable() {
  [ -n "$1" ] && [ -x "$1/bin/java" ] && "$1/bin/java" -version >/dev/null 2>&1
}

if _java_home_is_runnable "${JAVA_HOME:-}"; then
  : # An explicit, usable JAVA_HOME is part of the caller's environment contract.
else
  # Do not let an unusable inherited value mask discovery below.
  unset JAVA_HOME
fi

if [ -n "${JAVA_HOME:-}" ]; then
  : # Already selected above.
elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  _java_home_21=""
  if [ -x /usr/libexec/java_home ]; then
    _java_home_21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  fi

  # Homebrew's openjdk@21 is keg-only. Check both supported prefix locations
  # and the layout used by the formula without invoking or modifying brew.
  if ! _java_home_is_runnable "$_java_home_21"; then
    for _java_prefix in /opt/homebrew /usr/local; do
      for _java_candidate in \
        "$_java_prefix/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" \
        "$_java_prefix/opt/openjdk@21" \
        "$_java_prefix/Cellar/openjdk@21"/*/libexec/openjdk.jdk/Contents/Home; do
        if _java_home_is_runnable "$_java_candidate"; then
          _java_home_21="$_java_candidate"
          break 2
        fi
      done
    done
  fi

  if _java_home_is_runnable "$_java_home_21"; then
    export JAVA_HOME="$_java_home_21"
  else
    echo "ERROR: JDK 21 not found; install Homebrew openjdk@21 or set a valid JAVA_HOME." >&2
    return 1 2>/dev/null || exit 1
  fi
else
  # On non-macOS, preserve a runnable Java supplied by PATH. This keeps the
  # environment entry point source-safe for Linux and other development hosts.
  if ! command -v java >/dev/null 2>&1 || ! java -version >/dev/null 2>&1; then
    echo "ERROR: no runnable Java found; set JAVA_HOME to a JDK installation." >&2
    return 1 2>/dev/null || exit 1
  fi
fi

if [ -n "${JAVA_HOME:-}" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
unset _java_home_21 _java_prefix _java_candidate
unset -f _java_home_is_runnable 2>/dev/null || true

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
