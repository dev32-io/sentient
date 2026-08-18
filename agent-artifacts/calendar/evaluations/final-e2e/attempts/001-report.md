# Evaluation Report: final-e2e

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO
Initial exhaustive final-E2E review of commit ee13c5419433d1997c7231eff5a88164cb685e0c. The local stack was exercised against all 12 persisted cases and disposable state was removed afterward. Passing cases: E2E-001 core persistence/web list, E2E-004 typed child write rejection with no permission dialog, E2E-006 empty nudge, E2E-009 Android drawer list, E2E-010 guest broker denial, E2E-011 retired HA names absent, and E2E-012 DST expansion. Mixed or unmet cases: E2E-002 week view rendered 2 current-week instances rather than 10; E2E-003 an agent adults-only create lost visibility=adults and persisted as everyone (the separately created true adults-only fixture was hidden from child UI/tools/nudge); E2E-005 emitted an overflow marker but dropped all important weekly items; E2E-007 default household timezone recurrence listed as 422 invalid, while an explicit IANA zone worked; E2E-008 web create/list worked but the route accumulated 218 calendar REST requests due an effect/render loop. These are blocking acceptance/privacy or stability defects, so merge is not safe.

## Evidence

- **EV-001:** cat /tmp/calendar-e2e-final-20260818/evidence-summary.json — Sanitized per-case results, request-loop count, cleanup status, and DST observations.
- **EV-002:** maestro test /tmp/calendar-e2e-mobile.yaml — Completed: login, drawer open, calendar route, and assertion of the mobile event.
- **EV-003:** sqlite3 -readonly <disposable-private-calendar-db> 'select count(*) ...' — One persisted private calendar row observed during E2E-001; database removed during teardown.
- **EV-004:** git status --short --branch && git diff --check — Reviewed branch clean; no evaluated product files changed.

## Findings

- **CAL-E2E-001** (critical, open): Native calendar tool definitions omit JSON properties; a live adults-only agent create lost visibility=adults and persisted as everyone, exposing the event to the child path.
- **CAL-E2E-002** (high, open): Recurring events using timeZoneId=household are created but list/expansion returns 422 invalid because the sentinel is not resolved to an IANA household zone.
- **CAL-E2E-003** (high, open): Over-budget nudge trimming removes weekly important/pinned entries before today entries; the live capped nudge retained no important weekly items.
- **CAL-E2E-004** (high, open): Recreated default CalendarApi identity causes an effect/render/request loop; 218 calendar REST resource entries accumulated during one live page session.
- **CAL-E2E-005** (high, open): The week view requests only one seven-day window; the COUNT=10 MO,FR event produced 10 in a covering query but only 2 rendered in the current week, missing the exact persisted matrix outcome.

## Verdict

fail

## Residual Risk

- Only the Android mobile client path was driven for E2E-009; the iOS client was not run.
- The live run used a date/time-specific local stack; DST behavior was verified with an explicit America/New_York event zone.
