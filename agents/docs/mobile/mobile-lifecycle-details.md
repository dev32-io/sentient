# Mobile Lifecycle -- Details & Examples

This file expands `platforms/mobile/rules/mobile-lifecycle.md`.
The rule states the bar; this doc shows the patterns and the
anti-patterns the agent reaches for when uncertain. Examples are
written in pseudocode so they transfer across iOS (SwiftUI /
UIKit / scene phases) and Android (Activity / Fragment / Compose
lifecycle / `ProcessLifecycleOwner`).

## The four lifecycle moments worth naming

1. **Cold launch** -- process is starting; nothing in memory.
2. **Background** -- user navigated away; process is still alive
   but suspended-or-soon-to-be.
3. **Resume** -- foreground regained while the process survived.
4. **Restore** -- process was killed; the OS is re-creating the
   prior screen stack from a saved bundle.

Cold launch and resume look similar on the surface ("we are
running"); they differ in what is already loaded. Restore looks
like cold launch ("nothing in memory") but the route stack is
pre-determined by the OS.

## Foreground refresh checklist

On every foreground entry (resume OR restore), code SHOULD:

```pseudocode
onForeground():
    refreshClockBasedUi()        # "5 minutes ago" → "12 minutes ago"
    checkAuthTokenExpiry()       # refresh if within skew window
    reconnectSockets()           # WebSocket, push channels, MQTT
    revalidateFeatureFlags()     # the user may have been gated in
    reattachObservers()          # location, sensors, BLE, NFC
```

Anti-pattern: assume `onAppear` (SwiftUI) or `onResume` (Android)
runs only once. It runs every time the screen returns to the
foreground. Side effects that should be one-shot must guard
themselves explicitly.

## Saving state for restore

Every screen owns a small, serializable snapshot:

```pseudocode
struct ProductScreenSavedState:
    productId: String           # the route argument
    scrollOffset: Int           # restore the scroll position
    selectedTab: TabId          # the user's last sub-view

onSaveState(): return ProductScreenSavedState(...)
onRestoreState(saved): reconfigure from saved
```

Rules:

- The snapshot is small (think kilobytes, not megabytes). Large
  objects belong in the persistent store; the snapshot carries
  only the ID needed to refetch them.
- The snapshot is serializable. Closures, live references, and
  open connections do NOT belong in it.
- If a screen genuinely cannot be restored (e.g. mid-payment),
  on restore it must navigate to a sensible recovery target (the
  cart, the order list, the home tab) -- not crash.

## Resume vs cold-launch for deep links

The same URL must be handled correctly in both:

```pseudocode
handleDeepLink(url):
    if processIsStartingCold():
        # Queue the link; auth and stores are still loading.
        deepLinkQueue.append(url)
    else:
        # We are live. Decide based on current navigator state.
        target = parseTarget(url)
        if target.isCompatibleWithCurrentTask():
            navigator.push(target)
        elif userIsMidEdit():
            navigator.confirmThenReplace(target)
        else:
            navigator.replace(target)
```

The test matrix MUST include both rows. A deep link that lands
correctly from a notification tap (cold) may obliterate unsaved
form input when tapped while the app is open (resume).

## Background flush -- the short budget

The OS gives you a small window when entering background. Use
it; do not try to extend it.

```pseudocode
onWillResignActive():
    # Synchronously flush small, urgent state.
    draftStore.flush()
    outbox.persist()
    analytics.flushBatch()
    # Do NOT start a fresh network upload here.
```

Anti-patterns:

- Starting a long upload in the background handler. It will be
  killed mid-flight. Instead, persist the *intent* and let a
  background-task scheduler (`URLSession` background config /
  `WorkManager`) finish the work later.
- Using a long-running background extension token to "buy more
  time." That token is for finishing the LAST critical bit, not
  for routine work.

## Lifecycle event logging

```pseudocode
log.event("app.lifecycle", {
    transition: "background",
    duration_in_foreground_ms: 142_500,
    pending_writes: 3,
})
```

These breadcrumbs make "the bug only happens after lunch" a
diagnosable problem rather than a folk story.

## Test matrix for any new screen

| Case                              | Where it bites      |
| --------------------------------- | ------------------- |
| Cold launch direct to screen      | initial load path   |
| Background then resume            | observer re-attach  |
| Background, OS kill, restore      | state hydration     |
| Deep link while app is cold       | queueing            |
| Deep link while app is mid-task   | navigator decision  |
| Background entry with unsaved edit| flush correctness   |

If a row in this matrix has no test, the lifecycle is a black
box. Black-box lifecycles ship bugs.

## Foreground service types (Android 14+, audit G4)

Android 14 (API 34) requires every `startForeground` invocation to name a `foregroundServiceType` matching one declared in the manifest. Android 15 narrows allowed types; Android 16 enforces stricter background-start restrictions.

Manifest:

```xml
<service android:name=".SyncService"
    android:foregroundServiceType="dataSync"
    android:exported="false" />
```

Start time:

```kotlin
ServiceCompat.startForeground(
    this,
    NOTIFICATION_ID,
    notification,
    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
)
```

Allowed types as of Android 16: `dataSync`, `mediaPlayback`, `phoneCall`, `location`, `mediaProjection`, `camera`, `microphone`, `health`, `remoteMessaging`, `systemExempted`, `shortService`. Pick the narrowest.

Post-mortem visibility: `ApplicationExitInfo` (API 30+) records why the process was killed. Read on next launch for telemetry.

## WorkManager + BGTaskScheduler (audit G6)

Android: WorkManager for deferred work (`OneTimeWorkRequest`, `PeriodicWorkRequest`, `ExpeditedWorkRequest` for high-priority). Constraints: `setRequiresCharging`, `setRequiredNetworkType`. Unique work with `enqueueUniqueWork` to deduplicate.

iOS: `BGTaskScheduler.shared.register(forTaskWithIdentifier:)` + `BGAppRefreshTask` for short refresh + `BGProcessingTask` for longer work. Declare `BGTaskSchedulerPermittedIdentifiers` in Info.plist.

NEVER spin a raw thread / DispatchQueue for background work that should survive process death.

## Runtime permissions (audit G8)

Android 13+ requires `POST_NOTIFICATIONS`. Pattern: `ActivityResultContracts.RequestPermission()`, request at point of use (notification opt-in flow), show rationale if `shouldShowRequestPermissionRationale` is true, settings-bounce-back if denied permanently (`Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)`).

iOS: ATT framework (`ATTrackingManager.requestTrackingAuthorization`) for IDFA, similar settings-bounce-back via `UIApplication.openSettingsURLString`.
