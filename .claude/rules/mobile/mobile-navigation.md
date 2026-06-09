---
description: Mobile navigation -- typed route graph, one screen per destination, screen re-inits on route-arg change.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-data/**"
---

# Mobile Navigation

Navigate by typed routes. The top-level is a route graph over a small closed set of destinations.

## Routes — typed, one screen per destination

- Destinations are a closed sum; the router takes only typed values. Pass ids as route args and refetch — never large objects.
- A screen RE-INITIALISES when its route argument changes: a new arg = a fresh state-holder = clean per-screen state. This route boundary IS the cleanup boundary for per-screen state — never reset state in place.
- Gate the entry route on auth (token presence), NOT transport status — a drop keeps the user on the in-session screen with a banner, never bounces to login.
- A long-lived connection is scoped ABOVE the route graph, so navigating between destinations never tears it down.
- Logout clears the auth gate and shuts the connection scope → the graph routes to login. Navigation follows state, not an imperative call buried in a handler.

## Overlays

- A transient surface (settings sheet, history drawer) MAY stay an in-screen overlay rather than a stack destination when that fits the UX; promote it to a route only when it needs its own back-stack entry.

## Deep links (when added)

- Typed routes round-trip losslessly; a route arg fully reconstructs its destination. Don't pre-build link handling before a real need.

> When a rule is unclear, read `agents/docs/mobile/mobile-navigation-details.md`.
