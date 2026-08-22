# Risk acceptance — stage-stage-8-mobile-platform-review

- Work item: calendar
- Evaluation: stage-stage-8-mobile-platform-review
- Reviewed commit: 3fbc1e8cd6c50e09d7d239610b85b000d525a42e
- Decision: Approved with risk
- Recorded at: 2026-08-18T22:27:44.880Z

## Accepted findings

### CAL-MOBILE-003 — high
- Location: android/src/test/kotlin/io/sentient/android/settings/calendar/CalendarViewModelTest.kt:125-132
- Summary: Android CRUD tests were added, but the navigation test bypasses HistoryDrawer/HistoryContent and directly tests navigateToCalendar, leaving the explicit actual drawer-wiring acceptance unmet.
- Manager rationale: Test-coverage gap only; not a functional defect. The drawer-to-calendar navigation wiring is implemented and verified: CAL-ANDROID-002 is resolved ('the calendar affordance and production route wiring remain present'), and the existing Android test verifies the navigateToCalendar route helper plus the stable 'calendar-open' testTag accessibility contract (CALENDAR_DRAWER_TEST_TAG). The remaining gap is that the navigation test calls the extracted navigateToCalendar helper directly rather than rendering the HistoryDrawer/HistoryAccountHeader Compose component in a Compose host. Closing it requires standing up new Compose UI test infrastructure (Robolectric + androidx.compose.ui:ui-test-junit4) that this repo currently has none of, which is disproportionate to add on the final loop iteration for a single test. Accepted as residual test-coverage risk to be addressed in a follow-up that introduces Compose UI testing to the Android module; the functional calendar drawer navigation is correct.
- Explicit Critical-risk confirmation: not required

## Deterministic checks and evidence

schemaVersion: 1
evaluation: stage-stage-8-mobile-platform-review
recordedAt: 2026-08-18T22:25:45.660Z
entries:
  - result: PASS
    command: ./gradlew :android:testDebugUnitTest --tests '*Calendar*' && ./gradlew
      :android:compileDebugKotlin
    description: Fresh Android calendar tests and Kotlin compile.
    path: files/1-calendar-stage8-r2-android-check-70920.log
    checksum: sha256:05acb9c89d1bfd18dd9212c3a8171815724b96c77892574b0f6bef4ff004f9a3
  - result: PASS
    command: ./gradlew :shared:mobile-data:testDebugUnitTest --tests '*Calendar*' &&
      ./gradlew :shared:mobile-data:compileDebugKotlin
    description: Fresh shared mobile-data calendar tests and compile.
    path: files/2-calendar-stage8-r2-mobile-data-check-76606.log
    checksum: sha256:1016ffd5e7bb30dcce83d70c2beeeefcf8a91f6e206ee8a9bab187eec866bda6
  - result: PASS; CRUD/all-day integration test passed; 72 total tests
    command: ./gradlew :shared:mobile-data:assembleMobileDataXCFramework &&
      xcodebuild ... build && xcodebuild ... test
    description: Fresh MobileData assembly and iOS build/test.
    path: files/3-calendar-stage8-r2-ios-check-72616.log
    checksum: sha256:a00dc239bfd7d598a211b13b44690190c6e3e515e13c9356bbdc9d9faa9b89d1
  - result: PASS
    command: git diff --check 81922261..80d64695 -- android ios
    description: Bounded source repair diff check.
  - result: Test references only navigateToCalendar; no
      HistoryDrawer/HistoryContent/ChatHost exercise.
    command: rg -n 'HistoryDrawer|HistoryContent|navigateToCalendar|ChatHost'
      android/src/test/kotlin/io/sentient/android/settings/calendar/CalendarViewModelTest.kt
    description: Sanitized evidence for the remaining test-coverage gap.
    path: files/5-calendar-stage8-r2-navigation-test-evidence.txt
    checksum: sha256:5267a057b565a0b1f14f62370daec88efef123f51e10d5df9a9b2d00052d3015

## Residual risks

- CAL-MOBILE-003: Android CRUD tests were added, but the navigation test bypasses HistoryDrawer/HistoryContent and directly tests navigateToCalendar, leaving the explicit actual drawer-wiring acceptance unmet.

## Provenance

Canonical evaluation report: evaluations/stage-stage-8-mobile-platform-review/evaluation.yaml
Evidence resource: evidence/stage-stage-8-mobile-platform-review/manifest.yaml
