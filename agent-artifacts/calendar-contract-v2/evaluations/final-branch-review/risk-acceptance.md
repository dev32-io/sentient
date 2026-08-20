# Risk acceptance — final-branch-review

- Work item: calendar-contract-v2
- Evaluation: final-branch-review
- Reviewed commit: 8884fa9d77e35c7ae86ad50c1bbad602256cc1bf
- Decision: Approved with risk
- Recorded at: 2026-08-20T05:30:01.180Z

## Accepted findings

### CAL-V2-FINAL-003 — high
- Location: shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/calendar/CalendarModels.kt:455-462
- Summary: Deprecated baseEventId remains exported on CalendarEvent, so the explicit V1-field removal requirement is unmet.
- Manager rationale: The remaining deprecated baseEventId member exists only on a non-serializable compatibility view used by unchanged platform source. Exact serialized V2 DTOs expose eventId/occurrenceId/originalStart and nextCursor only, CalendarHttpClient never populates or normalizes baseEventId, and mobile-data mutations use persisted V2 identity. Removing this source-only member now conflicts with the reviewed no-UI-change boundary; it is deferred to the planned UI refresh without accepting any V1 wire compatibility.
- Explicit Critical-risk confirmation: not required

## Deterministic checks and evidence

schemaVersion: 1
evaluation: final-branch-review
recordedAt: 2026-08-20T05:29:22.008Z
entries:
  - result: 31 tests passed; gateway typecheck passed
    command: source scripts/env.sh && cd gateway && bun test
      src/api/handlers/calendar.test.ts src/calendar/calendar-query.test.ts
      src/calendar/types.test.ts
      src/bootstrap/product-tools/calendar-provider.test.ts && bun run typecheck
    description: Focused REST/query contract verification.
    path: files/1-gateway-summary.txt
    checksum: sha256:160cf437e7c3782acfbc8b1c0bfbf061db3f01c2dd44efab503e4204383f8da7
  - result: 12 tests passed; web typecheck passed
    command: source scripts/env.sh && cd gateway/webui && bun run test:unit --
      src/services/calendar-api.test.ts
      src/components/calendar/calendar-view.test.tsx && bun run typecheck
    description: Web recurrence and compatibility verification.
    path: files/2-web-summary.txt
    checksum: sha256:fc982673f69f8141c1a83e594efea9b1f071c37cd13e3312d68ae9933bc9109a
  - result: BUILD SUCCESSFUL
    command: source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest
      --tests '*Calendar*' --tests '*PrivacyGuard*'
      :shared:mobile-sdk:compileDebugKotlin
      :shared:mobile-data:testDebugUnitTest --tests '*Calendar*'
      :shared:mobile-data:compileDebugKotlin :android:compileDebugKotlin
    description: KMP/mobile-data calendar/privacy and Android compilation.
    path: files/3-mobile-summary.txt
    checksum: sha256:e5cb36f08c776fc42ff5f54fdaf781e029b95f0759a3be5ca113f473edd5eb1d
  - result: root typecheck and bounded repair diff check passed; repair UI-path diff
      is empty
    command: source scripts/env.sh && bun run typecheck; git diff --check
      327108f287d44c1e34ab3685e602f08e3fa99de2..HEAD
    description: Repair integrity and no-UI repair-scope verification.
    path: files/4-integrity-summary.txt
    checksum: sha256:c9f45326ae1116c0413a9dc9ec4e3a03ab0f105848a0dc93d1362343338202b1

## Residual risks

- CAL-V2-FINAL-003: Deprecated baseEventId remains exported on CalendarEvent, so the explicit V1-field removal requirement is unmet.

## Provenance

Canonical evaluation report: evaluations/final-branch-review/evaluation.yaml
Evidence resource: evidence/final-branch-review/manifest.yaml
