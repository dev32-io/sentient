# SKIE Bridging Smoke — SdkEvent Exhaustive Swift Enum

> **Historical verification snapshot (2026-06-06).** This records the generated
> enum at that date and still uses the retired `cycleId`/`CycleDone` surface. It
> is not current API guidance. Use
> `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkEvent.kt`
> for the current `turnId`-based event contract.

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

---

# SKIE Bridging Smoke — Generic SentientResult Exhaustive Swift Enum

**Verification date:** 2026-06-06
**Task:** 2.9 (KMP refactor series — MobileData umbrella XCFramework)
**Status:** FULL SWIFTC TYPECHECK PASS
**§14 risk:** CLOSED — generic `SentientResult<out T : Any>` bridges cleanly to exhaustive enum

---

## Framework Build

- **Task used:** `:shared:mobile-data:assembleMobileDataXCFramework`
- **Result:** BUILD SUCCESSFUL (~2m) — NO cinterop addition required
- **Output:**
  - `shared/mobile-data/build/XCFrameworks/release/MobileData.xcframework`
  - `shared/mobile-data/build/XCFrameworks/debug/MobileData.xcframework`
- **Slices:** `ios-arm64`, `ios-arm64-simulator` (both present in Info.plist)
- **SKIE version:** 0.10.11 (from generated file header)
- **objcexception cinterop:** NOT added to mobile-data — build succeeded without it. The
  cinterop is consumed transitively from mobile-sdk but emits a non-fatal warning
  (`Interop library ... can't be exported with -Xexport-library`). This does not affect the
  generated Swift interface or SKIE output.

---

## Evidence: Generic SentientResult → Exhaustive Swift Enum

### SKIE-generated Swift source

**File:**
`shared/mobile-data/build/skie/binaries/debugFramework/DEBUG/iosArm64/swift/generated/sentient_mobile_shared__mobile_data/sentient_mobile_shared__mobile_data.SentientResult.swift`

SKIE generated a `@frozen public enum __Sealed<T : Swift.AnyObject>` with all 3 cases,
an `onEnum(of:)` overload with generic constraint, and preserved the `T` type parameter:

```swift
// Generated by Touchlab SKIE 0.10.11
extension MobileData.Skie.sentient_mobile_shared__mobile_data.SentientResult {
    @frozen
    public enum __Sealed<T : Swift.AnyObject> : Swift.Hashable {
        case failure(MobileData.SentientResultFailure)
        case loading(MobileData.SentientResultLoading<T>)
        case success(MobileData.SentientResultSuccess<T>)
    }
}

public func onEnum<T : Swift.AnyObject, __Sealed : MobileData.SentientResult<T>>(of sealed: __Sealed)
    -> MobileData.Skie.sentient_mobile_shared__mobile_data.SentientResult.__Sealed<T> { ... }
```

### Confirmed in swiftinterface

The same 3 cases + `onEnum` overloads appear in:
`shared/mobile-data/build/XCFrameworks/release/MobileData.xcframework/ios-arm64-simulator/MobileData.framework/Modules/MobileData.swiftmodule/arm64-apple-ios-simulator.swiftinterface` (lines 1881–1895)

---

## All 3 Cases Present + Generic-Type Preservation

| # | Kotlin sealed subclass | Swift case label | Associated value type | Key property |
|---|----------------------|------------------|-----------------------|--------------|
| 1 | `Failure(val error: SentientError)` | `.failure` | `MobileData.SentientResultFailure` (non-generic; `Nothing`) | `.error: SentientError` → `.userMessage: String` |
| 2 | `Loading<out T>(val partial: T? = null)` | `.loading` | `MobileData.SentientResultLoading<T>` | `.partial: T?` |
| 3 | `Success<out T>(val data: T)` | `.success` | `MobileData.SentientResultSuccess<T>` | `.data: T` |

**Generic-type preservation:** `loading` and `success` carry `<T>` in their associated value types.
`failure` has no type parameter (`Failure : SentientResult<Nothing>` in Kotlin) — this is correct
and matches the Kotlin definition.

**ObjC header confirmation** (from `MobileData.h`):
- `SentientResultFailure.error: MobileDataSentientError *`
- `SentientResultLoading<T>.partial: T _Nullable`
- `SentientResultSuccess<T>.data: T`

---

## Smoke File

**Path:** `ios/SkieSmoke/SkieResultSmoke.swift`

Exhaustive `switch onEnum(of:)` with no `default:` branch over `SentientResult<ChatModel>`,
exercising all three cases including the typed `.data.committed` access on `ChatModel`
and `.error.userMessage` access on `SentientError`. To be wired into the iOS app target in Phase 4.

---

## Verification Level

**FULL SWIFTC TYPECHECK** — the smoke file was compiled headlessly against the simulator slice with zero errors:

```
xcrun --sdk iphonesimulator swiftc -typecheck \
  -target arm64-apple-ios16.0-simulator \
  -F shared/mobile-data/build/XCFrameworks/release/MobileData.xcframework/ios-arm64-simulator \
  ios/SkieSmoke/SkieResultSmoke.swift
# → exit 0, no output
```

This matches the Task 1.10 verification level (also full typecheck pass). The §14 risk is
empirically closed: SKIE 0.10.11 bridges `sealed class SentientResult<out T : Any>` to a
`@frozen` exhaustive Swift enum with generic type parameter preserved, and the `onEnum(of:)`
function is generic-constrained so the exhaustive `switch` compiles without `default:`.

---

## SKIE Warnings (non-blocking, same as Task 1.10)

- `SentientError.Protocol` renamed to `SentientError.Protocol_` (name collision with Swift keyword `Protocol`)
- `Ktor_httpHttpStatusCode.description` renamed `description_` (name collision)
- `Interop library mobile-sdk-cinterop-objcexception can't be exported with -Xexport-library` (warning only; framework builds and typechecks cleanly)

All pre-existing. Consider `@ObjCName` annotation for the first two in a follow-up.
