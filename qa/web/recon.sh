#!/usr/bin/env bash
# recon.sh — route/area discovery for sentient's gateway/webui.
#
# Sentient is a Vite + Preact SPA without explicit URL routing — there's
# one composed shell (AppShell) that swaps between Login → Chat views
# based on auth state. We map "areas" to component-folder groupings
# instead of URL paths, since that's what charters reference for risk
# scoring.
set -euo pipefail

command -v jq >/dev/null || { echo '{"routes": [], "framework": "preact", "notes": "jq missing"}'; exit 0; }

WEBUI_DIR="gateway/webui/src/components"

if [[ ! -d "$WEBUI_DIR" ]]; then
  jq -n --arg dir "$WEBUI_DIR" '{
    routes: [],
    framework: "preact",
    notes: ("webui components dir not found at " + $dir)
  }'
  exit 0
fi

# Discover areas (top-level subdirectories under components/) and
# representative screens (*-screen.tsx files). The Planner uses the
# area names to match against charter frontmatter `area:` fields.
AREAS_JSON="$(find "$WEBUI_DIR" -mindepth 1 -maxdepth 1 -type d \
  | sed "s|^$WEBUI_DIR/||" \
  | jq -R . | jq -s .)"

SCREENS_JSON="$(find "$WEBUI_DIR" -name '*-screen.tsx' -type f 2>/dev/null \
  | sort \
  | jq -R '{component: ., area: (split("/")[-2]), screen: (split("/")[-1] | sub("-screen\\.tsx$"; ""))}' \
  | jq -s .)"

jq -n \
  --argjson areas "$AREAS_JSON" \
  --argjson screens "$SCREENS_JSON" \
'{
  framework: "preact",
  routes: $screens,
  areas: $areas,
  notes: "SPA — no URL routing. Areas map to component folders under gateway/webui/src/components/<area>/. Screens are *-screen.tsx files. Charters target areas, not URL paths."
}'
