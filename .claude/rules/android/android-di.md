---
description: Manual DI -- explicit constructors + ViewModel factory, app-scope vs session-scope, no Hilt.
paths:
  - "android/**"
---
> SCOPE: governs the UI app only. Transport, session/audio FSM, reconnect, logging, and the
> data/repository layer live in the shared modules — do NOT re-implement them here.

# Dependency Injection

Wire dependencies BY HAND — explicit constructors + the platform ViewModel factory. No Hilt/Dagger. Keep the graph readable top-to-bottom from the entry point.

## ViewModels — manual factory

- Construct ViewModels via the platform ViewModel factory, passing collaborators as explicit constructor params.
- Key the chat/history ViewModels by the active session's identity so each entry gets a fresh VM; the VM's clear callback is the single teardown path.
- A ViewModel takes its repositories + lifecycle callbacks + the app-scoped presence relay. It never reaches for a global.

## App-scoped vs session-scoped

- App-lifetime, NON-SDK deps (token store, auth client, capability list) live in one app-scoped holder; they outlive a screen.
- The SDK + repositories live ONLY inside the chat-scoped session, built by a factory. NEVER a process-wide SDK singleton.
- The only app-scoped lifecycle object is the presence relay. Everything else is session-scoped.

## Discipline

- Constructor injection by default; no service-locator lookups inside a class body.
- No reflection / annotation-processor DI. Tests pass fakes through the same constructors — no framework, no module swap.

> When a rule is unclear, read `agents/docs/android/android-di-details.md`.
