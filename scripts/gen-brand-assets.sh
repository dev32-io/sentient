#!/usr/bin/env bash
# Regenerate the mobile brand PNGs from the ONE canonical mark SVG.
#
# Single source of truth: gateway/webui/public/sentient-mark.svg
#   - webui renders that SVG directly (vector).
#   - iOS + Android render a PNG rasterized from it (no SVG runtime lib).
#   - app icons rasterize it onto the dark app background.
#
# Re-run this whenever sentient-mark.svg changes. Requires: rsvg-convert, magick.
set -euo pipefail
cd "$(dirname "$0")/.."

SVG="gateway/webui/public/sentient-mark.svg"
BG="#2B2621"   # --color-bg / ic_launcher_background — the app background

# ── In-app mark: one transparent hi-dpi master, resized per use-site ──────────
rsvg-convert -w 512 -h 512 "$SVG" -o ios/App/Assets.xcassets/SentientMark.imageset/sentient-mark.png
cp ios/App/Assets.xcassets/SentientMark.imageset/sentient-mark.png \
   android/src/main/res/drawable-nodpi/sentient_mark.png

# ── iOS app icon: mark at ~80% centered on a 1024 opaque dark square ──────────
tmp="$(mktemp -d)"
rsvg-convert -w 820 -h 820 "$SVG" -o "$tmp/m.png"
magick -size 1024x1024 "xc:$BG" "$tmp/m.png" -gravity center -composite \
   ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png

# ── Android adaptive-icon foreground: mark ~66% (safe zone) per density ───────
for pair in 108:mdpi 162:hdpi 216:xhdpi 324:xxhdpi 432:xxxhdpi; do
  fg=${pair%%:*}; name=${pair##*:}; mk=$(( fg * 66 / 100 ))
  rsvg-convert -w "$mk" -h "$mk" "$SVG" -o "$tmp/mk.png"
  magick -size "${fg}x${fg}" xc:none "$tmp/mk.png" -gravity center -composite \
     "android/src/main/res/mipmap-$name/ic_launcher_foreground.png"
done
rm -rf "$tmp"
echo "brand assets regenerated from $SVG"
