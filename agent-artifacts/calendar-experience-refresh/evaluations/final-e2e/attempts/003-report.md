# Evaluation Report: final-e2e

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Final E2E re-review iteration 2 evaluated repair commit 7c0823df813d1828249bbb2e2b57d025abb02be0. All 14 approved matrix cases were executed and reported once. Verified repairs include Android editor Save/action reachability and timed creation, successful web recurring creation, iOS login/startup and four-view Calendar navigation, continued web focus restoration, and cached adjacent navigation.

Three blocking acceptance failures remain: Android persisted Month restoration after process recreation, mobile cache-prime/reconnect recovery stuck refreshing, and iOS editor Save accessibility above the active keyboard. Sanitized case records are stored in /tmp/calendar-e2e-r2/case-results.json.

## Evidence

- **EV-001:** Reviewed repair commit. — 7c0823df813d1828249bbb2e2b57d025abb02be0
- **EV-002:** Fresh Android and shared focused checks. — BUILD SUCCESSFUL
- **EV-003:** Fresh iOS build and navigation result. — BUILD SUCCEEDED; iOS reached calendar-surface and completed four-view navigation.
- **EV-004:** Sanitized matrix evidence. — All 14 cases reported once; cleanup reports seededR2EventsDeleted=1, androidNetworkRestored=true, productCodeModified=false.

## Findings

- **E2E-MAJOR-001** (high, open): Android shared-ready gating and pre-relaunch actions pass, but process recreation still does not expose the persisted Month state.
- **E2E-MAJOR-002** (high, resolved): Android preview Edit and pinned Save action are reachable; timed create reaches outcome.
- **E2E-MAJOR-003** (high, resolved): Valid web recurring creation succeeds while invalid temporal drafts remain protected.
- **E2E-MAJOR-004** (high, open): Cache prime remains stuck refreshing and reconnect does not publish the expected refreshed occurrence.
- **E2E-MAJOR-005** (high, resolved): The fresh iOS build/login reaches calendar-surface and completes four-view navigation.
- **E2E-MAJOR-006** (high, resolved): Web overlay close paths continue restoring originating controls.
- **E2E-MAJOR-007** (high, open): iOS editor Save is not accessible while the title keyboard is active, so timed creation cannot complete.

## Verdict

fail

## Residual Risk

- The approved local fixture adapter was not directly callable from the E2E session; an existing local account and synthetic event state were used, then the seeded event was deleted. No product code was modified.
- Several complete cross-platform cases remain blocked by unavailable disposable fixture setup; no success was inferred.
- Accessibility evidence remains semantic DOM/keyboard/native-hierarchy inspection rather than an actual assistive-technology session.
