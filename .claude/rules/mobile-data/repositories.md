---
description: Repository layer over the blackbox SDK -- one per concern, pure event-fold, no-loss, result envelope out.
paths:
  - "shared/mobile-data/**/repository/**"
  - "shared/mobile-data/**/model/**"
---

# Repositories

The SDK is a blackbox datasource. Repositories are the ONLY consumers of the SDK's observable surfaces; ViewModels go through repositories, never the SDK directly.

- One repository per domain concern; each maps its SDK surface to the result envelope.
- Fold the SDK's no-loss event stream through a PURE reducer into live UI state. The no-loss guarantee lives in the reducer, not in any conflating hot state-holder downstream.
- Combine committed history + live reduced state + the optimistic outbox into the single stream a screen collects.
- Map connection state to the result envelope: terminal auth/connection loss → failure, ready → success, otherwise loading.
- Reads are cache-then-refresh: emit a cached partial first, then the refreshed result.
- Repositories are constructed and scoped by the chat session — never singletons, never app-scoped.
- Keep them free of platform and UI types: data in, result envelope out. Pure, unit-tested without a device.

> When a rule is unclear, read `agents/docs/mobile-data/repositories-details.md`.
