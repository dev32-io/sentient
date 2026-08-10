### Task 6b: Remove signal-cli entirely

**Wave 3 (addendum) · model: opus · operator directive 2026-07-29: "just remove signal-cli, dead weight, and we don't need that for our app"**

Runs **before** Task 8 — this changes the stack shape, and T8's evidence would be stale if it verified a stack that was about to lose a service.

**Why it is already safe to remove:** `signal-cli` was never registered in `managed_services` (`grep -c signal gateway/config.yaml` → **0**), so the orchestrator has never started it. `signal-provisioner.finalize()` already logs `finalize.no-runner-to-restart` rather than pretending. The feature has been inert since the ACP purge; this deletes the carcass.

**Files:**

*Gateway*
- Delete: `gateway/src/devices/signal/` (8 files: `boot-reconciler.ts`, `pairing-coordinator.ts`, `pending-links.ts`, `signal-cli-client.ts`, `signal-provisioner.ts` + their tests)
- Delete: `gateway/src/api/handlers/devices.ts` (the entire `/api/v1/devices*` surface is signal-only — verify in Step 2)
- Delete: `gateway/templates/services/signal-cli.yaml`, `deploy/signal-cli/`
- Modify: `gateway/src/bootstrap/phase-services.ts`, `gateway/src/bootstrap/create-gateway-services.ts` (`devicesHandlerDeps`), `gateway/src/api/router.ts` (route removal), both compose files (build-only stanza)

*Web*
- Delete: `gateway/webui/src/components/settings/panes/devices-pane.tsx`, `qr-link-modal.tsx`
- Modify: the settings nav entry that reaches them

*Android*
- Delete: `android/src/main/kotlin/io/sentient/android/settings/devices/` (`QrImage.kt`, `SignalLinkDialog.kt`, `DevicesScreen.kt`, `DevicesViewModel.kt`)
- Modify: the settings nav graph entry

*iOS*
- Delete: `ios/App/Settings/Devices/`
- Modify: the settings nav entry

*KMP*
- Delete: `shared/mobile-sdk/.../settings/DevicesHttpClient.kt`, `DeviceModels.kt` + test
- Delete: `shared/mobile-data/.../data/settings/DevicesRepository.kt`, `usecase/settings/DevicesUseCases.kt` + tests
- Modify: `shared/mobile-data/.../FakeSettingsRepos.kt`, and any DI component wiring them

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -10
git status --short
ls gateway/src/devices/signal/ 2>/dev/null && echo "not yet removed"
grep -c signal gateway/config.yaml   # expect 0 — already orphaned
```

- [ ] **Step 2: Prove `/api/v1/devices*` is signal-only before deleting the handler**

The handler name is generic; its contents may not be. Check before assuming:

```bash
grep -nE "pathname ===|pathname.startsWith" gateway/src/api/handlers/devices.ts
```
Every route must be a signal pairing/link/unlink route. **If any route serves a non-signal device concern, keep the handler and delete only the signal routes** — say which in your report.

- [ ] **Step 3: Capture the baseline**

```bash
cd gateway/src && bun test 2>&1 | tail -4      # expect 1140 pass / 3 skip / 0 fail
cd ../.. && ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests --console=plain 2>&1 | tail -3
```
Record both. The drop must be attributable **only** to deleted subjects.

- [ ] **Step 4: Delete the gateway surface, then green**

```bash
git rm -r gateway/src/devices/signal/
git rm gateway/templates/services/signal-cli.yaml
git rm -r deploy/signal-cli/
```
Remove `devicesHandlerDeps` from `phase-services.ts` / `create-gateway-services.ts`, the `/api/v1/devices` branch from `api/router.ts`, and the `signal-cli` build-only stanza from both compose files. Then:

```bash
bun run --filter '@sentient/gateway' typecheck
cd gateway/src && bun test 2>&1 | tail -4
```
Expected: typecheck exit 0; only signal test files' cases missing.

- [ ] **Step 5: Commit the gateway half**

```bash
git commit -m "refactor(gateway): remove the signal-cli device surface" -- \
  gateway/src/devices/ gateway/src/api/ gateway/src/bootstrap/ \
  gateway/templates/services/signal-cli.yaml deploy/signal-cli/ \
  deploy/macos/docker-compose.yml deploy/mac-prod/docker-compose.yml
```

- [ ] **Step 6: Delete the KMP surface, then green**

Delete the SDK/data files listed above and unwire them from their DI components. `FakeSettingsRepos.kt` must drop its devices fake too, or the test module will not compile.

```bash
./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests --console=plain 2>&1 | tail -3
```
Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git commit -m "refactor(mobile-sdk): remove the signal device client and repository" -- \
  shared/mobile-sdk/ shared/mobile-data/
```

- [ ] **Step 8: Delete the web surface, then green**

Remove the two panes and the settings nav entry pointing at them.

```bash
bun run --filter '@sentient/webui' typecheck
bun run --filter '@sentient/webui' test 2>&1 | grep -E "Tests|Exited"
```
Expected: typecheck exit 0, tests pass. A dangling import from the settings nav is the likely failure — fix it, do not stub the pane.

- [ ] **Step 9: Commit**

```bash
git commit -m "refactor(webui): remove the signal device pairing panes" -- gateway/webui/src/
```

- [ ] **Step 10: Delete the Android + iOS surfaces, then build both**

```bash
./gradlew :android:compileDebugKotlin :android:testDebugUnitTest --console=plain 2>&1 | grep -E "BUILD|error:"
```
For iOS, follow the recipe exactly — `./scripts/ios-setup.sh` FIRST (a bare gradle assemble refreshes `build/XCFrameworks/debug/` but NOT the stable `MobileData.xcframework` the project links), then `-scheme` (never `-target`), targeting a simulator on **iOS ≥ 18.0**:

```bash
./scripts/ios-setup.sh
SIM=$(xcrun simctl list devices available | awk '/-- iOS 26/{f=1;next} /^-- /{f=0} f && /iPhone/{print;exit}' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination "platform=iOS Simulator,id=$SIM" -configuration Debug build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: both BUILD SUCCEEDED.

- [ ] **Step 11: Commit**

```bash
git commit -m "refactor(mobile): remove the signal device settings screens" -- android/ ios/
```

- [ ] **Step 12: Sweep for orphans**

```bash
grep -rniE "signal-cli|signalcli|signal_cli|SignalProvisioner|SignalLink|SignalDevice|devices/signal" \
  gateway/src gateway/webui/src shared android/src ios/App .claude docs/superpowers/plans deploy 2>/dev/null \
  | grep -viE "AbortSignal|\.signal|signal\)" | grep -v "task-6b-remove-signal-cli"
grep -rn "sentient-signal-cli" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head
```
Expected: no matches outside this task file. Also update `.claude/rules/` or `agents/docs/` if either names signal as a device surface, and `docs/mobile-release.md` if it mentions the pairing screens.

- [ ] **Step 13: Full gate + commit the sweep**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
git commit -m "docs: drop signal from the device surface docs" -- .claude/ agents/docs/ docs/
```

- [ ] **Step 14: Record the removal in your report**

State the final test counts for all five surfaces (gateway, config, webui, KMP, android) and confirm the drop is attributable only to deleted subjects.
