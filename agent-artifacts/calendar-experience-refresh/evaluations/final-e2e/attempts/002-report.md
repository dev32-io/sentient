# Evaluation Report: final-e2e

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Final E2E re-review iteration 1 evaluated repair commit 90704ece85fe3d10ffa35757168189ea96582d6f. All 14 approved matrix cases were executed and reported once. Verified repairs include Android shared-ready gating, Android preview Edit visibility, web all-day creation, web focus restoration, Android cached adjacent offline navigation, and successful fresh Android/iOS builds.

Blocking acceptance remains unmet for Android relaunch restoration, Android editor Save visibility, web recurring creation, mobile recovery/revalidation, and iOS Calendar startup/surface reachability. Sanitized case records are stored in /tmp/calendar-e2e-r1/case-results.json.

## Evidence

- **EV-001:** Reviewed repair commit. — 90704ece85fe3d10ffa35757168189ea96582d6f
- **EV-002:** Fresh Android repair build. — BUILD SUCCESSFUL
- **EV-003:** Fresh iOS build result. — BUILD SUCCEEDED; simulator flow still failed before composer/calendar readiness.
- **EV-004:** Sanitized matrix evidence. — All 14 cases reported once; cleanup reports seededExistingUserEventsDeleted=10, androidNetworkRestored=true, androidDisplayRestored=true, productCodeModified=false.

## Findings

- **E2E-MAJOR-001** (high, open): Android shared readiness and pre-relaunch view/date actions pass, but relaunch still does not expose the persisted Month state.
- **E2E-MAJOR-002** (high, open): Android preview Edit is repaired, but calendar-editor-save remains absent from the visible editor sheet.
- **E2E-MAJOR-003** (high, open): Web all-day creation is repaired, but recurring creation still fails with invalid-time while retaining the draft.
- **E2E-MAJOR-004** (high, open): Cached adjacent offline navigation passes, but cache-prime freshness and reconnect refreshed-occurrence assertions still fail.
- **E2E-MAJOR-005** (high, open): The fresh iOS build installs, but the direct flow fails before composer readiness and never reaches calendar-surface.
- **E2E-MAJOR-006** (high, resolved): Web Add, preview close, and editor cancel restore stable originating controls rather than BODY or unnamed focus.

## Verdict

fail

## Residual Risk

- The local fixture adapter was not directly callable from the E2E session; an existing local adult account and synthetic events were used, then ten seeded events were deleted. No product code was modified.
- E2E-007, E2E-010, and E2E-012 remain blocked rather than inferred successful because complete cross-platform setup was unavailable.
- Accessibility evidence remains semantic DOM/keyboard/native-hierarchy inspection rather than an actual assistive-technology session.
