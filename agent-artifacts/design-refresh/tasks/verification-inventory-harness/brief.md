# Task Brief: Create the closed refresh inventory and safe text-only verification harness

## Contribution Goal

Make every reachable WebUI and iOS surface/state accountable to an implementation owner and provide safe, machine-checkable local evidence infrastructure for the approved text-only E2E matrix.

## Boundary — Included

- A committed closed surface/state inventory for every current WebUI/iOS gate, route, pane, drawer, dialog, sheet, menu, no-op control, loading/empty/error/dirty/applying/success/permission/reduced-motion state.
- A schema/checker for inventory completeness and structured, non-pixel visual-review manifests.
- Safe local disposable auth/session/calendar fixture orchestration and text-only Web/iOS E2E entrypoints that exclude production, microphone/audio, and connectivity mutation.
- Updated QA configuration/charters where they contradict the approved design-refresh safety boundary.

## Required Work

- 1. Add a machine-readable inventory under qa/design-refresh/ with stable IDs, platform, reachability root/path, surface type, state, design authority, production implementation path, task owner, functional proof, required viewport/text-size/reduced-motion configurations, visual evidence IDs, intentional native adaptation, and status/exclusion reason. Seed it from all branches reachable through the named Web/iOS roots; dormant exports are marked unreachable with evidence rather than treated as acceptance targets.
- 2. Add a deterministic checker that validates schema, unique IDs, allowed authority paths, owner IDs, no missing reachable state, every required final E2E mapping, and later closure status. It must explicitly reject production imports/runtime references to design/prototype/** and require platform-owned copies for needed visual recipes or Rive bytes.
- 3. Add a structured visual-review manifest schema/checker. It verifies that every inventory row has the required reviewed configuration/evidence references, files are sanitized regular files, overflow/target/focus measurements are present where applicable, and intentional native adaptations are recorded. It must not perform pixel-perfect pass/fail comparisons.
- 4. Reconcile qa/web/config.yml and design-refresh charters with scripts/stack.sh and the approved local outward URL. Preserve existing Calendar fixture safety and guaranteed cleanup. Do not use a retired Docker gateway command or bun --hot.
- 5. Provide disposable local fixture lifecycle for authentication/session cases. Because sessions have no delete API, cleanup must delete the whole disposable user's private fixture/store through an existing authorized test-only boundary or a new loopback-only fixture adapter; never expose cleanup in production routing. Reuse calendar fixture principles: reject non-loopback targets, record generated IDs in a temporary state file, and make cleanup idempotent.
- 6. Add a design-refresh-only Maestro/command path for targeted iOS flows that does not grant/use microphone permission and never invokes fault/network phases. Preserve signed simulator build requirements and restore Dynamic Type after E2E-008.
- 7. Define sanitized evidence paths beneath qa/web/evidence/design-refresh/ and qa/mobile/evidence/design-refresh/. Add secret/content guards for credentials, tokens, private content, transcripts, prompts, raw audio, and production identifiers. Disposable test text is allowed but must be clearly synthetic.
- 8. Map E2E-001..009 exactly once into the harness metadata. Final runtime evaluation will execute them; this task builds prerequisites and focused tests only, not microphone/STT/TTS or production E2E.

## Integration Expectation

Deliver this contribution for integration in stage contracts-and-harness.

## Context

- Reachability roots are gateway/webui/src/app.tsx and ios/App/RootView.swift, ios/App/Nav/UserSessionHost.swift, and ios/App/Nav/Route.swift.
- Approved final cases are E2E-001 through E2E-009: Web shell/history, text chat, one harmless setting, Calendar, keyboard/200% zoom; iOS startup/history, text chat, larger-text Settings, and Calendar.
- Existing local-stack authority is scripts/stack.sh and agents/docs/e2e-testing-details.md. Existing qa/web/config.yml and the default qa/mobile/run-e2e.sh include stale or out-of-scope behavior and must not silently govern this matrix.
- DESIGN.MD and design/prototype/** are design context/reference only. Production code and tests must replicate approved values/assets into platform-owned locations rather than import or execute prototype code or assets.

## Boundary — Excluded

- Executing final E2E cases
- Pixel-perfect visual automation
- Production access or mutation
- Microphone, STT, TTS playback, AEC, acoustic, audio-route, reconnection, or network-disruption testing
- Wi-Fi or network-adapter manipulation
- Android visual inventory or Android UI work

## Interfaces and Dependencies

- Produces qa/design-refresh inventory/schema/check commands, safe fixture lifecycle commands, targeted text-only Web/iOS runner configuration, and structured visual-review manifest contracts consumed by every product task and final evaluation.
- Consumes current route/component source and approved E2E-001..009; does not change product behavior.
