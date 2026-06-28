#!/usr/bin/env bash
# Build the signed ad-hoc iOS ipa via fastlane; deploy is opt-in (--deploy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  --deploy) DEPLOY=1 ;;
  "")       DEPLOY=0 ;;
  *) echo "ERROR: unknown argument: $1 (usage: build-ios.sh [--deploy])"; exit 1 ;;
esac

command -v xcodegen &>/dev/null || { echo "ERROR: xcodegen not installed (brew install xcodegen)."; exit 1; }
command -v bundle &>/dev/null || { echo "ERROR: bundler not installed (gem install bundler; then bundle install)."; exit 1; }
CONF="$REPO/scripts/release.local.conf"
[ -f "$CONF" ] || { echo "ERROR: $CONF missing — copy scripts/release.local.conf.example and set IOS_TEAM_ID."; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${IOS_TEAM_ID:?set IOS_TEAM_ID in scripts/release.local.conf}"
export IOS_TEAM_ID
[ -n "${APPLE_ID:-}" ] && export APPLE_ID

( cd "$REPO" && bundle exec fastlane ios adhoc )

IPA="$REPO/ios/build/ipa/SentientApp.ipa"
[ -f "$IPA" ] || { echo "ERROR: ipa not produced at $IPA"; exit 1; }
echo "✓ built $IPA"

if [ "$DEPLOY" = "1" ]; then
  IOS_SHORT_VERSION="$(grep -E 'CFBundleShortVersionString:' "$REPO/ios/project.yml" | head -1 | sed -E 's/.*: *//')"
  IOS_BUNDLE_VERSION="$(grep -E 'CFBundleVersion:' "$REPO/ios/project.yml" | head -1 | sed -E 's/.*"?([0-9]+)"?.*/\1/')"
  export IOS_SHORT_VERSION IOS_BUNDLE_VERSION
  "$REPO/scripts/deploy-mobile.sh" "$IPA"
fi
