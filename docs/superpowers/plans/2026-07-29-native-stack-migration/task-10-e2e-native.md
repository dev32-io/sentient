### Task 10: The 2.0 native mobile E2E matrix

**Wave 5 · model: sonnet · spec §9.2**

Runs **after** Task 9 completes — one gateway owns `:8888` and one device per Maestro batch. These are serialized, never concurrent.

Maestro **only**; never Playwright for native.

**Files:**
- Modify: `qa/mobile/flows/**` (re-ground existing flows, add new ones)
- Modify: `qa/mobile/fixtures/README.md`
- Create: `qa/mobile/evidence/<date>-<case>/`

---

**iOS build recipe — follow exactly.** Learned the hard way this session; deviating produces errors that point at third-party packages and waste an hour:

```bash
./scripts/ios-setup.sh          # FIRST. A bare gradle assemble refreshes
                                # build/XCFrameworks/debug/ but NOT the stable
                                # MobileData.xcframework the Xcode project links.
SIM=$(xcrun simctl list devices available | awk '/-- iOS 26/{f=1;next} /^-- /{f=0} f && /iPhone/{print;exit}' \
      | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -destination "platform=iOS Simulator,id=$SIM" -configuration Debug build
```
- **`-scheme`, never `-target`** — `-target` bypasses the scheme's SPM wiring and fails inside `swift-markdown-ui` / `swift-cmark` with errors that never mention your code.
- The simulator runtime **must be ≥ iOS 18.0** (`ios/project.yml` sets `deploymentTarget: 18.0`); an older sim fails with "Unable to find a destination matching".

**Runner:** `./qa/mobile/run-e2e.sh [android|ios|all] [--tags T1,T2]`. One warm batch per tag set — **never one invocation per flow**; cold JVM/device-attach cost is fixed per invocation and dominates. Address cases **by tag**, not by filename.

Tag taxonomy — surface: `auth chat session reconnect outbox voice-loop settings-* update logout`; behavior: `fault-armed physical-only slow destructive-profile restore helper`.

---

- [ ] **Step 1: Build both apps against the native stack**

Android:
```bash
./gradlew :android:assembleDebug
adb devices          # expect emulator-5554
```
iOS: the recipe above. Confirm both apps reach the gateway at its LAN address (the emulator/simulator is not on loopback — use the host's LAN IP, which is exactly why the gateway binds `0.0.0.0` while addons do not).

- [ ] **Step 2: Re-ground the existing flows off the retired cycle wire**

Existing flows assert on `cycleId` and `cycle.*` log lines that 2.0 never emits: **T1** login-happy, **T3** send/receive, **T8** reconnect + followup + scroll stability, **T9** auth-expiry, **T10** network-change reconnect. Rewrite their assertions onto `turnId` / `turn.*` and the 2.0 log tags. T8 is the closest methodology template for `reload-convergence` and `steer-followup-audio` — reuse its structure rather than inventing one.

- [ ] **Step 3: Author the missing native permission case**

The predecessor spec's matrix names only web viewports for `permission-confirm-web` — there is **no native case**. That is a genuine gap in the spec, not an omission by choice. Add one, and flag it as a spec correction in your report.

New flows MUST carry real `tags:` from the taxonomy, a conditional login subflow (`runFlow: { when: ..., file: _helpers/login.yaml }`), and visibility waits ≤3000 ms (longer only with an inline comment justifying it).

Selectors: Tasks 8/9 of the previous plan landed `permission-allow` / `permission-deny` ids on both platforms — verify they exist before authoring against them:
```bash
grep -rn "permission-allow\|permission-deny" android/src ios/App | head
```

- [ ] **Step 4: Author using the batch workflow, not one-flow-at-a-time**

Maestro MCP `inspect_screen` **once** per new screen → author every flow touching that screen → **one** batch run → fix residuals. Never write → run → dump-hierarchy → fix per flow.

- [ ] **Step 5: Run the matrix by tag**

```bash
./qa/mobile/run-e2e.sh all --tags chat,session,reconnect,voice-loop
```
Rows: `native-turn-happy`, `native-tool-call`, `permission-confirm` (native), `steer-followup-audio`, `reload-convergence`, `voice-roundtrip`, `restart-persistence`.

- [ ] **Step 6: `voice-roundtrip` via PCM fixture injection**

Use the recipe in `qa/mobile/fixtures/README.md` — and **update that doc**: it still says "Hermes replies", which is pre-2.0. In 2.0 the native loop replies and Hermes is only a delegated tool.

- [ ] **Step 7: Resolve or hand off `05-interrupt.yaml`**

It currently proves only "send → stream, no crash", and is flagged as unable to prove a real interrupt tap without a reachable local-tts on the device. **local-tts is now a native addon on the host** — determine whether the emulator/simulator can reach it at the LAN address. If yes, strengthen the flow to prove the actual interrupt. If no, hand it to Task 11 with the reason. Do not leave it asserting nothing while appearing green.

- [ ] **Step 8: Hand physical-device and acoustic cases to Task 11**

Acoustic barge-in on a real device needs a real mic and speaker — simulators have no audio path, which is precisely why the `physical-only` tag exists. Record it for Task 11 with exact steps. Never fake it.

- [ ] **Step 9: Commit**

```bash
git commit -m "test(e2e): native mobile matrix re-grounded on the turn wire" -- \
  qa/mobile/ agents/docs/testing-knowledge.md
```
