---
description: Dependency injection -- framework-managed graph scoped to lifecycles; shared layer stays framework-free.
paths:
  - "android/**"
---
> SCOPE: governs the UI app only. Transport, session/audio FSM, reconnect, logging, and the
> data/usecase layer live in the shared modules — do NOT re-implement them here.

# Dependency Injection

Wire dependencies through a DI graph scoped to real lifecycles. The shared/common layer stays framework-free (hand-written factories); the UI layer uses the platform's runtime DI to manage state-holder lifecycle and scoping.

## Scopes — match the lifecycle, not the file

- App scope: process-lived, non-connection deps (config, token store, persisted prefs).
- Connection scope: the transport + data sources + the usecase graph, alive while authenticated; it SURVIVES in-app navigation so the socket never drops on a screen change. Built on login, torn down on logout. NEVER a process-wide singleton tied to one screen.
- Screen scope: one state-holder per route destination, built by the platform's lifecycle-aware factory; it resolves usecases from the connection scope, never the transport directly.

## Discipline

- Constructor / parameter injection by default; no service-locator lookups buried in a class body.
- Prefer a runtime DI container with NO annotation processor over a codegen one, unless a codegen DI library is already adopted (the build forbids new annotation processors).
- Tests pass fakes through the same constructors — no framework, no module swap.

> When a rule is unclear, read `agents/docs/android/android-di-details.md`.
