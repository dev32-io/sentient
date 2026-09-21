#!/usr/bin/env bash
# Build the gateway as a standalone native executable plus its runtime assets.
#
#   ./scripts/build-gateway.sh              debug   (sourcemaps, no minify)
#   ./scripts/build-gateway.sh --release    release (minified + bytecode)
#
# Output: dist/gateway/<version>/{bin/sentient-gateway, share/..., wheels/,
# native-sources/..., addons/attachment-parser/{addon.json,identity.json,image.tar}}
# plus a tarball and a sha256 the installer verifies.
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
  --release) PROFILE="release"; VARIANT="Release" ;;
  "")        PROFILE="debug";   VARIANT="Debug" ;;
  *) echo "ERROR: unknown argument: $1 (usage: build-gateway.sh [--release])"; exit 1 ;;
esac
VARIANT_DEFINE="process.env.SENTIENT_BUILD_VARIANT=\"$VARIANT\""

command -v bun &>/dev/null || { echo "ERROR: bun not found — run 'source scripts/env.sh' first."; exit 1; }

VERSION="$(bun -e 'console.log(require("./gateway/package.json").version)')"
[ -n "$VERSION" ] || { echo "ERROR: could not read version from gateway/package.json"; exit 1; }
OUT="$REPO/dist/gateway/$VERSION"
rm -rf "$OUT"; mkdir -p "$OUT/bin" "$OUT/share"

PARSER_METADATA="$REPO/gateway/addons/attachment-parser/addon.json"
PARSER_RUNTIME_IMAGE="sentient/attachment-parser:local"
PARSER_IMAGE_REPOSITORY="sentient/attachment-parser"

read_parser_metadata() {
  python3 "$REPO/scripts/attachment_parser_metadata.py" "$1"
}

parser_revision() {
  local revision
  revision="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" || {
    echo "ERROR: cannot determine source revision for attachment-parser image" >&2
    return 1
  }
  if [ -n "$(git -C "$REPO" status --porcelain -- gateway/addons/attachment-parser 2>/dev/null)" ]; then
    revision="${revision}-dirty"
  fi
  printf '%s' "$revision"
}

build_attachment_parser_release() {
  local fields parser_name parser_version parser_protocol
  fields="$(read_parser_metadata "$PARSER_METADATA")" || {
    echo "ERROR: invalid parser metadata at $PARSER_METADATA" >&2
    exit 1
  }
  IFS=$'\t' read -r parser_name parser_version parser_protocol _ <<<"$fields"
  local revision
  revision="$(parser_revision)" || exit 1
  # SemVer build metadata is canonical in addon.json but '+' is not a Docker
  # tag character. Keep manifest version unchanged; map only tag derivation.
  local parser_tag_version="${parser_version//+/_}"
  local image_ref="$PARSER_IMAGE_REPOSITORY:release-${parser_tag_version}-${revision}"
  local payload="$OUT/addons/attachment-parser"
  mkdir -p "$payload"

  echo "==> building attachment-parser image ($parser_version, $revision)"
  docker build \
    --build-arg "ADDON_NAME=$parser_name" \
    --build-arg "ADDON_VERSION=$parser_version" \
    --build-arg "ADDON_PROTOCOL_VERSION=$parser_protocol" \
    --build-arg "ADDON_REVISION=$revision" \
    --tag "$image_ref" \
    "$REPO/gateway/addons/attachment-parser"

  local image_id image_name image_version image_protocol image_revision
  image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
  image_name="$(docker image inspect --format '{{index .Config.Labels "io.sentient.addon.name"}}' "$image_ref")"
  image_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_ref")"
  image_protocol="$(docker image inspect --format '{{index .Config.Labels "io.sentient.addon.protocol-version"}}' "$image_ref")"
  image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "ERROR: parser image has invalid Docker identity: $image_id" >&2
    exit 1
  }
  [ "$image_name" = "$parser_name" ] || {
    echo "ERROR: parser image name label is '$image_name', expected '$parser_name'" >&2
    echo "       Dockerfile must consume ADDON_NAME" >&2
    exit 1
  }
  [ "$image_version" = "$parser_version" ] || {
    echo "ERROR: parser image version label is '$image_version', expected '$parser_version'" >&2
    echo "       Dockerfile must consume ADDON_VERSION" >&2
    exit 1
  }
  [ "$image_protocol" = "$parser_protocol" ] || {
    echo "ERROR: parser image protocol label is '$image_protocol', expected '$parser_protocol'" >&2
    echo "       Dockerfile must consume ADDON_PROTOCOL_VERSION" >&2
    exit 1
  }
  [ "$image_revision" = "$revision" ] || {
    echo "ERROR: parser image revision label is '$image_revision', expected '$revision'" >&2
    echo "       Dockerfile must consume ADDON_REVISION" >&2
    exit 1
  }

  cp "$PARSER_METADATA" "$payload/addon.json"
  docker save --output "$payload/image.tar" "$image_ref"
  local archive_sha256
  archive_sha256="$(shasum -a 256 "$payload/image.tar" | awk '{print $1}')"
  python3 - "$payload/identity.json" "$parser_name" "$parser_version" "$parser_protocol" \
    "$image_ref" "$image_id" "$revision" "$PARSER_RUNTIME_IMAGE" "$archive_sha256" <<'PY'
import json
import sys

out, name, version, protocol, image_ref, image_id, revision, runtime_image, archive_sha256 = sys.argv[1:]
with open(out, "w") as handle:
    json.dump(
        {
            "addon": {
                "name": name,
                "version": version,
                "protocolVersion": int(protocol),
            },
            "image": {
                "ref": image_ref,
                "imageId": image_id,
                "revision": revision,
                "runtimeImage": runtime_image,
                "archive": "image.tar",
                "archiveSha256": archive_sha256,
            },
        },
        handle,
        indent=2,
        sort_keys=True,
    )
    handle.write("\n")
PY
  echo "    parser payload: $payload/image.tar"
}

echo "==> building webui"
( cd gateway/webui && bun run build )

echo "==> compiling gateway ($PROFILE)"
if [ "$PROFILE" = "release" ]; then
  # NOTE: --bytecode is deliberately NOT used, despite spec §5 pinning it.
  # `bun build --bytecode` implies --format=cjs, and CJS cannot host the
  # top-level `await`s in gateway/src/main.ts — it fails the build outright
  # with `"await" can only be used inside an "async" function`. Re-add
  # --bytecode only once the entrypoint no longer uses top-level await.
  ( cd gateway && bun build src/main.ts --compile --minify --define "$VARIANT_DEFINE" \
      --outfile "$OUT/bin/sentient-gateway" )
else
  ( cd gateway && bun build src/main.ts --compile --sourcemap=inline --define "$VARIANT_DEFINE" \
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

# Production releases carry parser image ID/archive identity. Clean revision
# tags are unique; dirty staging tags may repeat. Debug builds stay a native-only
# bundle; local development gets its :local image from scripts/stack.sh.
if [ "$PROFILE" = "release" ]; then
  build_attachment_parser_release
fi

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
