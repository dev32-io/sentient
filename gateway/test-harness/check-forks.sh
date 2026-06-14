#!/usr/bin/env bash
# Counts Hermes-minted timestamp-named "fork" sessions for a profile.
# Hermes mints a fork session named session_YYYYMMDD_HHMMSS_*.json (8-digit
# date) when it duplicates a conversation — the accidental-fork bug
# (design 2026-06-14 §1). A clean run produces only session_<uuid>.json.
#
# NOTE: a profile accumulates HISTORICAL forks from before the fix, so the
# total is not the e2e signal. Pass a `sinceISO` 3rd arg to count only forks
# created during a test window — that count must be 0 for a green run.
#
# usage: check-forks.sh <profileId> [hermesHome] [sinceISO]
#   sinceISO e.g. "2026-06-14 16:00:00"
set -euo pipefail
PROFILE="${1:?usage: check-forks.sh <profileId> [hermesHome] [sinceISO]}"
HERMES_HOME="${2:-$HOME/.sentient/gateway/data/$PROFILE}"
SINCE="${3:-}"
SESS_DIR="$HERMES_HOME/profiles/$PROFILE/sessions"
GLOB='session_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*.json'

total="$(find "$SESS_DIR" -maxdepth 1 -name "$GLOB" 2>/dev/null | wc -l | tr -d ' ')"
echo "timestamp-fork sessions for $PROFILE (total, incl. historical): $total"

if [ -n "$SINCE" ]; then
  recent="$(find "$SESS_DIR" -maxdepth 1 -name "$GLOB" -newermt "$SINCE" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  created since '$SINCE' (THIS is the e2e signal — must be 0): $recent"
fi
