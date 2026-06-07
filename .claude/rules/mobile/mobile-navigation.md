---
description: Mobile navigation -- state-gate at the root, overlays not stack destinations, typed routes only when a stack appears.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-data/**"
---

# Mobile Navigation

The app navigates by STATE, not a router. The top-level is a gate over a small set of mutually-exclusive screens.

## Root — a state gate, one screen at a time

- The composition root swaps between screens on derived booleans/enum: unconfigured → setup, no-token → login, token present → chat. Both platforms share this 3-way gate.
- Gate on auth (token presence), NOT transport status — a drop must keep the user on the in-session screen with a banner, never bounce to login.
- Settings and the history drawer/sheet are OVERLAYS within the in-session state, not stack destinations.

## What's shipped vs NOT

- There is NO route graph / navigation stack, no tabs, no deep links. Do not add a navigation library or coordinator stack for the current screen set.
- A logout→login transition is driven by clearing the auth gate (the session tears down as a consequence) — navigation follows state, not an imperative navigate call.

## When a real stack appears (typed-route discipline — Future)

- If a multi-destination back stack is ever introduced, apply typed-route discipline then: destinations are a closed sum, the router takes only typed values, deep links round-trip losslessly, tabs are roots with their own back stacks, and routes pass ids (refetch), never large objects. Don't pre-build this.

> When a rule is unclear, read `agents/docs/mobile/mobile-navigation-details.md`.
