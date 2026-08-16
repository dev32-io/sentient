# Evaluation Report: family-integration-safety-review

## Boundary

{"workItem":"first-class-family-tools"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

Checked HEAD 8ac582dc402dcb4fe6cfa673c649676b8fccb687 read-only.

Requirement conclusions:
- PASS: Required automated suite, typecheck, and diff check all pass.
- PASS: Home adapter validation/bounded waits, deterministic Home/player resolution, Home accepted_unverified/no-retry behavior, composed music_play single broker boundary/minimal sequence, standard music primitive availability, standard scene/automation/script discovery/activation/inspection/create/update contracts, and fake-only mutation coverage are supported by tests and code evidence.
- PASS: No live HA/MA calls or mutations were performed. Generated evidence contains no local-development PIN.
- FAIL: Music mutation cancellation after dispatch does not preserve dispatch ambiguity (FIS-001).
- FAIL: Standard music primitive failures do not distinguish rejected and failed semantic outcomes (FIS-002).
- FAIL: Music collection payloads are not fail-closed on wrong upstream result shape (FIS-003).

The explicit integration-safety contract is therefore not met despite the green suite.

## Evidence

- **EV-001:** source scripts/env.sh && bun test gateway/src/tools gateway/src/bootstrap — 419 pass, 2 skip, 0 fail
- **EV-002:** source scripts/env.sh && bun run typecheck — All workspace typechecks exited 0
- **EV-003:** source scripts/env.sh && git diff --check — Exit 0; no output
- **EV-004:** Controlled fake-socket mutation cancellation reproduction — One mutation was sent; surfaced error was cancelled with dispatched=false
- **EV-005:** Controlled standard-primitive rejection reproduction — Typed upstream rejection surfaced as outcome=error, not rejected
- **EV-006:** Controlled malformed MA payload reproduction — Wrong-shaped players/all result surfaced as []

## Findings

- **FIS-001** (high, open): A post-send abort creates a cancelled error with dispatched=false, so standard music mutations report cancellation rather than accepted_unverified and may be retried by the caller.
- **FIS-002** (medium, open): Standard music primitives collapse typed rejection and failure categories into outcome=error rather than the required semantic outcomes.
- **FIS-003** (medium, open): browse/listPlayers silently convert wrong-shaped correlated payloads into empty collections, misreporting malformed upstream data as a legitimate no-result state.

## Verdict

fail

## Residual Risk

- No optional live observational E2E was run, so compatibility with the locally configured HA/MA versions remains unverified.
- Multi-player grouping is a sequential multi-mutation operation; partial completion semantics under cancellation or a later member failure were not directly covered by the reviewed tests.
