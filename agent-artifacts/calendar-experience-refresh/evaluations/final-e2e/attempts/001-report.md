# Evaluation Report: final-e2e

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Initial exhaustive final-E2E review of commit ffd4545d2f2b33b9ee15646109afd5ea1bbee4ab. All 14 approved matrix cases were executed and reported once. Web responsive evidence passed key geometry checks: 42 Month cells, seven Week/Month columns, no horizontal overflow at 1440x1000, 1024x900, 768x900, and 390x844, with collapsed controls reachable. Web stale-conflict and non-disclosure behavior were also observed.

Blocking failures remain in Android route restoration and native editor/preview controls, web all-day and recurring creation, mobile adjacent-cache and recovery behavior, web overlay focus restoration, and iOS Calendar surface startup. Sanitized case records are stored in /tmp/calendar-e2e-20260822-0225/case-results.json.

## Evidence

- **EV-001:** Reviewed commit. — ffd4545d2f2b33b9ee15646109afd5ea1bbee4ab
- **EV-002:** Sanitized final E2E matrix evidence. — All 14 case results recorded exactly once; cleanup reports disposableUsersRemaining=0, androidDisplayRestored=true, productCodeModified=false.

## Findings

- **E2E-MAJOR-001** (high, open): Android relaunch preference assertion timed out; the expected restored Month state was not observable.
- **E2E-MAJOR-002** (high, open): Android editor exposed no calendar-editor-save and event preview exposed no Edit action, blocking native create/edit/recurrence/delete/temporal flows.
- **E2E-MAJOR-003** (high, open): Web all-day household and recurring Add submissions failed while retaining drafts, although timed creation succeeded.
- **E2E-MAJOR-004** (high, open): Adjacent cached navigation and connectivity recovery did not expose the expected cached and refreshed occurrences.
- **E2E-MAJOR-005** (high, open): The freshly built iOS app did not expose calendar-surface, blocking the iOS matrix.
- **E2E-MAJOR-006** (high, open): Web overlay close paths restored focus to BODY or an unnamed target instead of the originating control.

## Verdict

fail

## Residual Risk

- The fixture helper was not invoked as a standalone runner; loopback-created disposable state was explicitly cleaned and the remaining disposable-user count was verified as zero.
- Accessibility evidence is semantic DOM/keyboard/native-hierarchy inspection, not a real screen-reader, VoiceOver, or TalkBack session.
- iOS exact viewport evidence remains blocked until native Calendar surface startup is repaired.
