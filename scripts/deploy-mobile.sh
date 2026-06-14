#!/usr/bin/env bash
# scp an artifact to the file server (replacing the prior one) and verify by md5.
# Target host/user/path + remote names come from the gitignored release.local.conf.
set -euo pipefail
ARTIFACT="${1:?usage: deploy-mobile.sh <path-to-.ipa-or-.apk>}"
[ -f "$ARTIFACT" ] || { echo "ERROR: artifact not found: $ARTIFACT"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DIR/release.local.conf"
[ -f "$CONF" ] || { echo "ERROR: $CONF missing — copy scripts/release.local.conf.example and fill it."; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${DEPLOY_HOST:?set DEPLOY_HOST in release.local.conf}" "${DEPLOY_USER:?}" "${DEPLOY_PATH:?}"

case "$ARTIFACT" in
  *.ipa) NAME="${IPA_NAME:?set IPA_NAME in release.local.conf}" ;;
  *.apk) NAME="${APK_NAME:?set APK_NAME in release.local.conf}" ;;
  *) echo "ERROR: unknown artifact type (expect .ipa/.apk): $ARTIFACT"; exit 1 ;;
esac

scp -o ConnectTimeout=10 "$ARTIFACT" "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/${NAME}"
LOCAL_MD5="$(md5 -q "$ARTIFACT" 2>/dev/null || md5sum "$ARTIFACT" | cut -d' ' -f1)"
REMOTE_MD5="$(ssh -o ConnectTimeout=10 "${DEPLOY_USER}@${DEPLOY_HOST}" "md5sum \"${DEPLOY_PATH}/${NAME}\"" | cut -d' ' -f1)"
if [ "$LOCAL_MD5" = "$REMOTE_MD5" ]; then
  echo "✓ deployed ${NAME} (md5 ${LOCAL_MD5})"
else
  echo "✗ md5 mismatch (local ${LOCAL_MD5} / remote ${REMOTE_MD5})"; exit 1
fi
