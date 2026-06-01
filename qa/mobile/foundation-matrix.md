# Foundation e2e matrix (P0)
| # | Case | Platform | How | Pass criteria | Status |
|---|------|----------|-----|---------------|--------|
| F1 | KMP common tests | shared | `./gradlew :shared:mobile-sdk:allTests` | PlatformTest green | ✅ iosSimulatorArm64Test: 2 tests, 0 failures (greeting_includes_sdk_name + logger_tag_roots_under_sentient_mobile_sdk) |
| F2 | Android app builds + launches + renders SDK greeting | Android emu | android run + layout | greeting text in layout JSON | ✅ APK installed to emulator-5554; `uiautomator dump` grep hit "sentient-mobile-sdk on Android" |
| F3 | iOS app builds + launches + renders SDK greeting | iPhone 14 Pro 26.5 | maestro assertVisible | id=foundation-greeting visible | ✅ `maestro --device 2BB144EC-281C-4E5E-883F-65A21EF67056 test foundation-ios.yaml`: assertVisible COMPLETED |
| F4 | Emulator -> host gateway reachable | Android emu | adb ping 10.0.2.2 + health | 0% loss + {"status":"ok"} | ✅ `curl -sk https://localhost:8888/api/v1/health` → `{"status":"ok"}`; `adb shell ping -c2 10.0.2.2` → 0% loss |
| F5 | Sim -> host gateway reachable | iOS sim | simctl openurl + screenshot | gateway reached (TLS handshake) | ✅ Safari opened localhost:8888 — TLS handshake completed (self-signed cert warning shows "localhost" in URL bar) |
| F6 | Rules load on edit | repo | edit a file under android/ ios/ shared/mobile-sdk | matching rules auto-load (paths globs correct) | ✅ No language globs (`**/*.kt` / `**/*.swift`) in any rule; android rules → `android/**`, ios → `ios/**`, mobile-sdk → `shared/mobile-sdk/**` |
