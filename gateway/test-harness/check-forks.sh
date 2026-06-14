#!/usr/bin/env bash
# Counts Hermes-minted timestamp-named "fork" sessions for a profile.
# A clean run = 0. Any session_YYYYMMDD_HHMMSS_*.json that is a full-history
# copy is an accidental fork (design 2026-06-14 §1). Use as the e2e hard signal.
set -euo pipefail
PROFILE="${1:?usage: check-forks.sh <profileId> [hermesHome]}"
HERMES_HOME="${2:-$HOME/.sentient/gateway/data/$PROFILE}"
SESS_DIR="$HERMES_HOME/profiles/$PROFILE/sessions"
count="$(find "$SESS_DIR" -maxdepth 1 -name 'session_2[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*.json' 2>/dev/null | wc -l | tr -d ' ')"
echo "timestamp-fork sessions for $PROFILE: $count"
