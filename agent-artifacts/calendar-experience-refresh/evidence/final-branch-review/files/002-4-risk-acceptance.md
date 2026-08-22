# Risk acceptance — final-e2e

- Work item: calendar-experience-refresh
- Evaluation: final-e2e
- Reviewed commit: 96874ddc6889184d641e3b6417baeffba50b815d
- Decision: Approved with risk
- Recorded at: 2026-08-22T17:42:29.370Z

## Accepted findings

## Deterministic checks and evidence

schemaVersion: 1
evaluation: final-e2e
recordedAt: 2026-08-22T10:05:38.064Z
entries:
  - result: BUILD SUCCESSFUL
    command: source scripts/env.sh && ./gradlew
      :shared:mobile-data:testDebugUnitTest :android:testDebugUnitTest
      :android:assembleDebug
    description: Shared recovery integration/unit tests, Android tests, and current
      debug build.
  - result: Gateway typecheck passed; bounded repair diff has no whitespace errors.
    command: bun run --filter @sentient/gateway typecheck && git diff --check
      44e7330b857db26215614e8b505f81d1e3bdb5f3..HEAD
    description: Repair boundary checks.
  - result: All commands returned rc=0; verify-recovery confirmed the sentinel
      through the authenticated all-scope window query; cleanup removed the
      fixture state.
    command: calendar:fixture provision; calendar:fixture seed-recovery;
      calendar:fixture verify-recovery; calendar:fixture cleanup against
      loopback local target
    description: Sanitized direct fixture/recovery evidence.
    path: files/005-3-calendar-e2e-r4-verify.out
    checksum: sha256:11af65e83633b13ae220ae66b471d8ea205ca4d70ab08662f429f2fb3f8e29ad
  - result: Prime, cached offline, and reconnect recovery flows passed.
      Recovery-ready and freshness-up-to-date markers appeared; recovery
      occurrence was reachable; offline freshness and disabled mutation state
      cleared after recovery.
    command: maestro test qa/mobile/flows/android/calendar/09a-cache-prime.yaml;
      09-cache-first.yaml; 09b-cache-recover.yaml
    description: Fresh Android recovery evidence.
    path: files/005-4-manifest.json
    checksum: sha256:27cc2331da7baf7402a13d9f670ccfefa340ff1bc555954f69af8bdf95ef6b02
  - result: BUILD SUCCEEDED; current iOS four-view navigation flow passed.
    command: scripts/ios-setup.sh && xcodebuild -project ios/SentientApp.xcodeproj
      -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone
      16,OS=latest' -configuration Debug build CODE_SIGNING_ALLOWED=NO
    description: Current iOS build/navigation evidence.
    path: files/005-5-manifest.json
    checksum: sha256:0a992789f6428f504e744b6aec4c6278f5965c24ca4f2bbd7e3172f1c71b7b33
  - result: 14 caseResults recorded exactly once; cleanup fixtureClean=true,
      androidNetworkRestored=true, productCodeModified=false.
    command: cat /tmp/calendar-e2e-r4/case-results.json
    description: Sanitized final matrix record.
    path: files/005-6-case-results.json
    checksum: sha256:5ede912d56cd0ea12d536f5147a83a1d9c17ab7dd6b5e3779ea7dc0d3cad6399

## Residual risks


## Provenance

Canonical evaluation report: evaluations/final-e2e/evaluation.yaml
Evidence resource: evidence/final-e2e/manifest.yaml
