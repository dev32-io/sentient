#!/usr/bin/env bash
# Deploy a mobile artifact to the Mac mini release dir served at /download, and
# refresh manifest.json. Version metadata comes from the calling build script
# via env (ANDROID_VERSION_CODE/NAME or IOS_BUNDLE_VERSION/SHORT_VERSION).
set -euo pipefail
ARTIFACT="${1:?usage: deploy-mobile.sh <path-to-.ipa-or-.apk>}"
[ -f "$ARTIFACT" ] || { echo "ERROR: artifact not found: $ARTIFACT"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DIR/release.local.conf"
[ -f "$CONF" ] || { echo "ERROR: $CONF missing — copy scripts/release.local.conf.example."; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${DEPLOY_HOST:?set DEPLOY_HOST}" "${DEPLOY_USER:?set DEPLOY_USER}" "${RELEASES_PATH:?set RELEASES_PATH}"
: "${IOS_BUNDLE_ID:=io.dev32.sentient}" "${IOS_MIN_BUILD:=0}" "${ANDROID_MIN_BUILD:=0}"
SSH="ssh -o ConnectTimeout=10 ${DEPLOY_USER}@${DEPLOY_HOST}"

case "$ARTIFACT" in
  *.apk) PLAT=android; REMOTE="${RELEASES_PATH}/android/latest.apk" ;;
  *.ipa) PLAT=ios;     REMOTE="${RELEASES_PATH}/ios/latest.ipa" ;;
  *) echo "ERROR: unknown artifact type (expect .ipa/.apk): $ARTIFACT"; exit 1 ;;
esac

$SSH "mkdir -p ${RELEASES_PATH}/android ${RELEASES_PATH}/ios"
scp -o ConnectTimeout=10 "$ARTIFACT" "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE}"
LOCAL_MD5="$(md5 -q "$ARTIFACT" 2>/dev/null || md5sum "$ARTIFACT" | cut -d' ' -f1)"
REMOTE_MD5="$($SSH "md5sum '${REMOTE}'" | cut -d' ' -f1)"
[ "$LOCAL_MD5" = "$REMOTE_MD5" ] || { echo "✗ md5 mismatch"; exit 1; }
echo "✓ uploaded ${REMOTE} (md5 ${LOCAL_MD5})"

# --- regenerate manifest.json from the two latest deployed versions ---
# Read the existing remote manifest (if any) so the OTHER platform's block is
# preserved when only one platform is being deployed.
EXISTING="$($SSH "cat '${RELEASES_PATH}/manifest.json' 2>/dev/null || echo '{}'")"
MANIFEST="$(PLAT="$PLAT" EXISTING="$EXISTING" \
  ANDROID_VERSION_CODE="${ANDROID_VERSION_CODE:-}" ANDROID_VERSION_NAME="${ANDROID_VERSION_NAME:-}" \
  ANDROID_MIN_BUILD="$ANDROID_MIN_BUILD" \
  IOS_BUNDLE_VERSION="${IOS_BUNDLE_VERSION:-}" IOS_SHORT_VERSION="${IOS_SHORT_VERSION:-}" \
  IOS_MIN_BUILD="$IOS_MIN_BUILD" IOS_BUNDLE_ID="$IOS_BUNDLE_ID" \
  node "$DIR/build-manifest.mjs")"
echo "$MANIFEST" | $SSH "cat > '${RELEASES_PATH}/manifest.json'"
echo "✓ manifest.json updated"
