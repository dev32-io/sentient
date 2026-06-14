#!/usr/bin/env bash
# Build the signed Android release apk; deploy is opt-in (--deploy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  --deploy) DEPLOY=1 ;;
  "")       DEPLOY=0 ;;
  *) echo "ERROR: unknown argument: $1 (usage: build-android.sh [--deploy])"; exit 1 ;;
esac

[ -f "$REPO/android/keystore.properties" ] || {
  echo "ERROR: android/keystore.properties missing — run scripts/android-make-keystore.sh first."; exit 1; }

( cd "$REPO" && ./gradlew :android:assembleRelease )

APK="$REPO/android/build/outputs/apk/release/android-release.apk"
[ -f "$APK" ] || { echo "ERROR: apk not found at $APK"; ls -l "$REPO/android/build/outputs/apk/release/" || true; exit 1; }
echo "✓ built $APK"

[ "$DEPLOY" = "1" ] && "$REPO/scripts/deploy-mobile.sh" "$APK"
