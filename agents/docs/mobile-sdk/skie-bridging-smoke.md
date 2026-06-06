# SKIE Bridging Smoke — SdkEvent Exhaustive Swift Enum

**Verification date:** 2026-06-06
**Task:** 1.10 (KMP refactor series)
**Status:** FULL SWIFTC TYPECHECK PASS

---

## Framework Build

- **Task used:** `:shared:mobile-sdk:assembleMobileSdkXCFramework`
- **Result:** BUILD SUCCESSFUL (1m 58s)
- **Output:**
  - `shared/mobile-sdk/build/XCFrameworks/release/MobileSdk.xcframework`
  - `shared/mobile-sdk/build/XCFrameworks/debug/MobileSdk.xcframework`
- **Slices:** `ios-arm64`, `ios-arm64-simulator`
- **SKIE version:** 0.10.11 (from generated file header)

---

## Evidence: SdkEvent → Exhaustive Swift Enum

### SKIE-generated Swift source

**File:**
`shared/mobile-sdk/build/skie/binaries/releaseFramework/RELEASE/iosSimulatorArm64/swift/generated/sentient_mobile_shared__mobile_sdk/sentient_mobile_shared__mobile_sdk.SdkEvent.swift`

SKIE generated a `@frozen public enum __Sealed` with all 9 cases and an `onEnum(of:)` overload:

```swift
extension MobileSdk.Skie.sentient_mobile_shared__mobile_sdk.SdkEvent {
    @frozen
    public enum __Sealed : Swift.Hashable {
        case cycleAborted(MobileSdk.SdkEvent.CycleAborted)
        case cycleDone(MobileSdk.SdkEvent.CycleDone)
        case messageCommitted(MobileSdk.SdkEvent.MessageCommitted)
        case messageDelta(MobileSdk.SdkEvent.MessageDelta)
        case messageStarted(MobileSdk.SdkEvent.MessageStarted)
        case protocolError(MobileSdk.SdkEvent.ProtocolError)
        case sessionSwitched(MobileSdk.SdkEvent.SessionSwitched)
        case taskUpserted(MobileSdk.SdkEvent.TaskUpserted)
        case transcriptUpdated(MobileSdk.SdkEvent.TranscriptUpdated)
    }
}

public func onEnum<__Sealed : MobileSdk.SdkEvent>(of sealed: __Sealed)
    -> MobileSdk.Skie.sentient_mobile_shared__mobile_sdk.SdkEvent.__Sealed { ... }
```

### Confirmed in swiftinterface

The same 9 cases + `onEnum` overload appear in:
`shared/mobile-sdk/build/bin/iosSimulatorArm64/releaseFramework/MobileSdk.framework/Modules/MobileSdk.swiftmodule/arm64-apple-ios-simulator.swiftinterface`

---

## All 9 Cases Present

| # | Kotlin sealed subclass | Swift case label | Key properties |
|---|----------------------|------------------|----------------|
| 1 | `MessageStarted` | `.messageStarted` | `cycleId: String` |
| 2 | `MessageDelta` | `.messageDelta` | `cycleId: String`, `chunk: String` |
| 3 | `MessageCommitted` | `.messageCommitted` | `message: ChatMessage` |
| 4 | `TaskUpserted` | `.taskUpserted` | `task: TaskSnapshotItem` |
| 5 | `TranscriptUpdated` | `.transcriptUpdated` | `text: String` |
| 6 | `CycleDone` | `.cycleDone` | `cycleId: String` |
| 7 | `CycleAborted` | `.cycleAborted` | `cycleId: String`, `kind: String?` |
| 8 | `SessionSwitched` | `.sessionSwitched` | `sessionId: String` |
| 9 | `ProtocolError` | `.protocolError` | `error: SentientError` |

**Case label spelling note:** All labels are camelCase matching Kotlin class names. No differences from the spec's expected names.

---

## Smoke File

**Path:** `ios/SkieSmoke/SkieSmoke.swift`

An exhaustive `switch onEnum(of:)` with no `default:` branch. To be wired into the iOS app target in Phase 4.

---

## Verification Level

**FULL SWIFTC TYPECHECK** — the smoke file was compiled headlessly against the simulator slice with zero errors:

```
xcrun --sdk iphonesimulator swiftc -typecheck \
  -target arm64-apple-ios16.0-simulator \
  -F shared/mobile-sdk/build/XCFrameworks/release/MobileSdk.xcframework/ios-arm64-simulator \
  ios/SkieSmoke/SkieSmoke.swift
# → exit 0, no output
```

This confirms SKIE generates a `@frozen` exhaustive enum for `SdkEvent` that Swift can pattern-match without a `default:` branch.

---

## SKIE Warnings (non-blocking)

- `SentientError.Protocol` renamed to `SentientError.Protocol_` (name collision with Swift keyword `Protocol`) — does not affect `SdkEvent`.
- `Ktor_httpHttpStatusCode.description` renamed `description_` (name collision) — does not affect `SdkEvent`.

Both are pre-existing and unrelated to this task. Consider `@ObjCName` annotation in a follow-up.
