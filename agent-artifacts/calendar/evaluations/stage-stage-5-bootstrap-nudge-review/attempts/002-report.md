# Evaluation Report: stage-stage-5-bootstrap-nudge-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- orchestratorCfg.calendar config schema, config.yaml defaults, and old-config compatibility
- Capability minting, store open and close on session disposal, and prompt-cache stability preserved across an in-session write
- Nudge cap, deterministic drop order, empty-calendar omission, serving-tz rendering, and child/guest visibility

## Observations

MERGE: NO

Re-review of fd8eb357 verifies S5-BOOTSTRAP-001 and S5-NUDGE-001 are repaired. However, the repair introduces a blocking Major defect: child/guest update/delete calls with omitted scope can reach the household store before the adult gate, returning store-level forbidden instead of household-write-forbidden and violating the zero-store-call pre-PDP requirement. The prior medium verification gap remains deferred. Typecheck and targeted tests pass (5 passed, 0 failed).

## Evidence

- **EV-001:** cd gateway && bun run typecheck — passed
- **EV-002:** cd gateway && bun test src/bootstrap/phase-services src/calendar/nudge src/bootstrap/product-tools/calendar-provider — 5 passed, 0 failed
- **EV-003:** git diff --no-ext-diff --unified=20 76c8c4f3^ 76c8c4f3 -- gateway/src/bootstrap/phase-services.ts gateway/src/bootstrap/product-tools/calendar-provider.ts gateway/src/calendar/nudge.ts gateway/src/calendar/nudge.test.ts — Repair diff inspected; both prior defects are addressed, but omitted-scope household write gating is incomplete.

## Findings

- **S5-BOOTSTRAP-001** (high, resolved): Both targets are now supplied and explicit/no-scope reads route correctly.
- **S5-NUDGE-001** (high, resolved): Marker space and weekly-before-today trimming are implemented and covered by a targeted test.
- **S5-BOOTSTRAP-002** (high, open): Adult gating considers only an explicitly supplied scope; omitted-scope update/delete may call householdStore before failing with store-level forbidden.
- **S5-VERIFY-001** (medium, deferred): Required bootstrap lifecycle, compatibility/timezone, and prompt-cache tests remain absent; deferred residual risk.

## Verdict

fail

## Residual Risk

- Required bootstrap/provider lifecycle and prompt-cache boundary tests remain absent; this is deferred from the prior review per closure-focused re-review rules.
