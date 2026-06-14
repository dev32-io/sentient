#!/usr/bin/env bash
# One-time: generate the Android release keystore + write android/keystore.properties.
# The password is random and printed NOWHERE — it lives only in the gitignored props file.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KS="$REPO/android/release.keystore"
PROPS="$REPO/android/keystore.properties"
ALIAS="sentient-release"

[ -f "$KS" ] && { echo "ERROR: $KS already exists — refusing to overwrite (would break update continuity)."; exit 1; }
command -v keytool >/dev/null || { echo "ERROR: keytool not found (install a JDK)."; exit 1; }

PASS="$(openssl rand -base64 24)"
# Feed the password via stdin (-storepass:stdin/-keypass:stdin, keytool ≥ JDK 8u301)
# so it never appears in the process list (`ps aux`), only in the gitignored props file.
printf '%s\n%s\n' "$PASS" "$PASS" | keytool -genkeypair -v -keystore "$KS" -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 \
  -dname "CN=Sentient, OU=Mobile, O=Sentient, C=US" \
  -storepass:stdin -keypass:stdin >/dev/null

umask 077
cat > "$PROPS" <<EOF
storeFile=release.keystore
storePassword=$PASS
keyAlias=$ALIAS
keyPassword=$PASS
EOF
chmod 600 "$PROPS"
echo "✓ created android/release.keystore + android/keystore.properties (both gitignored)."
echo "  Back these up somewhere safe — losing them means sideloaded updates won't install over the old app."
