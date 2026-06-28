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

if [ "$DEPLOY" = "1" ]; then
  ANDROID_VERSION_CODE="$(cd "$REPO" && ./gradlew -q :android:printVersionCode 2>/dev/null || grep -oE 'versionCode = [0-9]+' android/build.gradle.kts | grep -oE '[0-9]+')"
  ANDROID_VERSION_NAME="$(grep -oE 'versionName = "[^"]+"' "$REPO/android/build.gradle.kts" | sed -E 's/.*"([^"]+)"/\1/')"
  [ -n "$ANDROID_VERSION_CODE" ] && [ -n "$ANDROID_VERSION_NAME" ] || { echo "ERROR: could not extract Android version from android/build.gradle.kts"; exit 1; }
  export ANDROID_VERSION_CODE ANDROID_VERSION_NAME
  "$REPO/scripts/deploy-mobile.sh" "$APK"
fi
