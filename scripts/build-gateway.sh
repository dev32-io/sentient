#!/usr/bin/env bash
# Build the gateway as a standalone native executable plus its runtime assets.
#
#   ./scripts/build-gateway.sh              debug   (sourcemaps, no minify)
#   ./scripts/build-gateway.sh --release    release (minified + bytecode)
#
# Output: dist/gateway/<version>/{bin/sentient-gateway, share/..., wheels/,
# native-sources/...} plus a tarball and a sha256 the installer verifies.
#
# The archive is deliberately self-contained.  `setup-prod.py install` must
# never depend on a second rsync/scp of dist/wheels or on mutable source files
# in the checkout: it stages the native services and builds their venvs from
# this payload with `pip --no-index`.
#
# Both dev Mac and mini are arm64 macOS, so there is no cross-compilation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

case "${1:-}" in
  --release) PROFILE="release" ;;
  "")        PROFILE="debug" ;;
  *) echo "ERROR: unknown argument: $1 (usage: build-gateway.sh [--release])"; exit 1 ;;
esac

command -v bun &>/dev/null || { echo "ERROR: bun not found — run 'source scripts/env.sh' first."; exit 1; }

VERSION="$(bun -e 'console.log(require("./gateway/package.json").version)')"
[ -n "$VERSION" ] || { echo "ERROR: could not read version from gateway/package.json"; exit 1; }
OUT="$REPO/dist/gateway/$VERSION"
rm -rf "$OUT"; mkdir -p "$OUT/bin" "$OUT/share"

echo "==> building webui"
( cd gateway/webui && bun run build )

echo "==> compiling gateway ($PROFILE)"
if [ "$PROFILE" = "release" ]; then
  # NOTE: --bytecode is deliberately NOT used, despite spec §5 pinning it.
  # `bun build --bytecode` implies --format=cjs, and CJS cannot host the
  # top-level `await`s in gateway/src/main.ts — it fails the build outright
  # with `"await" can only be used inside an "async" function`. Re-add
  # --bytecode only once the entrypoint no longer uses top-level await.
  ( cd gateway && bun build src/main.ts --compile --minify \
      --outfile "$OUT/bin/sentient-gateway" )
else
  ( cd gateway && bun build src/main.ts --compile --sourcemap=inline \
      --outfile "$OUT/bin/sentient-gateway" )
fi

# Everything the gateway reads through config/asset-root.ts, plus the webui
# bundle the static handler serves. config/delegation/ is NOT optional: its
# loader degrades to missing frontmatter rather than crashing, so omitting it
# fails silently at runtime.
echo "==> staging runtime assets"
cp -R gateway/templates       "$OUT/share/templates"
cp -R gateway/system_prompts  "$OUT/share/system_prompts"
cp    gateway/persona.md      "$OUT/share/persona.md"
mkdir -p "$OUT/share/config"
cp -R gateway/config/delegation "$OUT/share/config/delegation"
cp -R gateway/webui/dist      "$OUT/share/webui"

echo "==> staging native-service install payload"
if [ ! -d "$REPO/dist/wheels" ]; then
  echo "ERROR: dist/wheels is missing — run ./scripts/build-python-wheels.sh before packaging a release." >&2
  exit 1
fi
for service in whisper-stt local-tts deep-memory; do
  if [ ! -d "$REPO/dist/wheels/$service" ]; then
    echo "ERROR: dist/wheels/$service is missing — run ./scripts/build-python-wheels.sh before packaging a release." >&2
    exit 1
  fi
done
mkdir -p "$OUT/native-sources"
cp -R capabilityServices/WhisperSTTService/src "$OUT/native-sources/whisper-stt"
cp -R capabilityServices/LocalTTSService/src    "$OUT/native-sources/local-tts"
cp -R capabilityServices/DeepMemoryService/src  "$OUT/native-sources/deep-memory"
cp -R "$REPO/dist/wheels" "$OUT/wheels"
cp deploy/mac-prod/native/install-venv.sh "$OUT/install-venv.sh"
# The helper resolves its lock as `<helper-dir>/requirements/<service>.lock`.
# Keep the locks beside the bundled helper so the archive has no dependency on
# a mutable checkout at install time.
cp -R deploy/mac-prod/native/requirements "$OUT/requirements"

echo "==> smoke: assets must resolve from the compiled binary"
# A deliberately-absent config path. The binary must get PAST asset loading and
# fail at CONFIG loading. If GATEWAY_RUNTIME_DIR were wrong it would fail EARLIER
# with ENOENT on a template — that distinction is the whole regression guard.
#
# The "reached config loading" half is asserted on the config PATH, not on a
# function name: --minify renames symbols, so a name-based grep would pass in
# debug and fail in release for a reason that has nothing to do with assets.
SMOKE_CONFIG="/nonexistent/sentient-build-smoke/config.yaml"
set +e
SMOKE="$(GATEWAY_RUNTIME_DIR="$OUT/share" GATEWAY_CONFIG_PATH="$SMOKE_CONFIG" \
  "$OUT/bin/sentient-gateway" 2>&1)"
set -e
# `printf '%s\n'`, never `echo`: under --minify Bun echoes whole minified
# source lines as error context, and those contain backslash escapes (\x00,
# \t, \\). An `echo` that interprets them truncates the haystack at the first
# NUL and the guard silently stops guarding.
#
# Matches both shapes of the regression: the helper's loud error, and a raw
# ENOENT from any future module-scope read that bypassed the helper. Kept
# specific rather than a bare "templates/" — a loose pattern matches the
# minified source context itself.
if printf '%s\n' "$SMOKE" | grep -qE "asset root has no|ENOENT.*templates/"; then
  echo "FAIL: binary could not resolve assets (GATEWAY_RUNTIME_DIR handling is broken)" >&2
  printf '%s\n' "$SMOKE" | tail -5 >&2
  exit 1
fi
if ! printf '%s\n' "$SMOKE" | grep -qF "$SMOKE_CONFIG"; then
  echo "FAIL: binary did not reach config loading; unexpected early failure" >&2
  printf '%s\n' "$SMOKE" | tail -5 >&2
  exit 1
fi
echo "    ok — reached config loading, assets resolved"

echo "==> packaging"
tar -czf "$OUT.tar.gz" -C "$REPO/dist/gateway" "$VERSION"
shasum -a 256 "$OUT.tar.gz" > "$OUT.tar.gz.sha256"
echo "✓ $OUT.tar.gz"
cat "$OUT.tar.gz.sha256"
