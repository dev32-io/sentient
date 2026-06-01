---
description: Mobile lifecycle -- transitions, process death restore, flush-on-background, FGS, permissions, deferred work.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-sdk/**"
---

# Mobile Lifecycle

The OS suspends, kills, and resurrects mobile processes on its own schedule. Treat every transition as routine, not exceptional.

## Transitions — first-class state

- Background → foreground is a state, not an edge case.
- On resume: refresh staleable inputs (clocks, tokens, reachability); re-establish observers.
- Cover the triple: cold start, background+resume, background+kill+restore.

## Process death + restore — every screen rebuilds

- Every screen rebuilds from a small, serializable snapshot (route args + persisted IDs).
- Do NOT depend on in-memory singletons surviving restore; reach for the persistent store.

## Background entry — flush within seconds

- Flush in-flight writes to durable storage in the platform's short budget.
- Long work is wrong-shaped; split + persist intent + resume later.

## Foreground services — typed in manifest AND at start (G4)

- Android 14+ requires `foregroundServiceType` in manifest AND on `startForeground(...)`.
- Pick the narrowest type (`dataSync`, `mediaPlayback`, `location`). Wear/TV/Auto separate.

## Deferred work + permissions (G6/G8)

- WorkManager (Android) and BGTaskScheduler (iOS) for periodic + constrained work.
- NEVER schedule background work on a raw `Thread` / `DispatchQueue`.
- POST_NOTIFICATIONS on Android 13+; ATT on iOS — request at point of use, not at launch.
- Rationale UI before re-asking; settings-bounce-back fallback if denied permanently.

## Observability
- Log every transition (`foreground`, `background`, `will-terminate`, `restore`) as a structured event.
- Android → `Lifecycle`+`WorkManager`+`ForegroundServiceType`; iOS → `scenePhase`+`BGTaskScheduler`+UIBackgroundModes. See `agents/docs/mobile/mobile-lifecycle-details.md`.
