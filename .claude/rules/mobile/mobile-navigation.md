---
description: Mobile navigation -- typed routes, state-aware deep links, defined back behavior.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-sdk/**"
---

# Mobile Navigation

Stringly-typed routes and undefined back behavior are mobile's two biggest sources of state-management debt.

## Routes — typed, not stringly

- Destinations are values of a closed sum (sealed class / enum / @Serializable).
- Router accepts only typed values; raw `String` paths cross the boundary at URL parse/format only.
- Adding a destination forces every dispatch site to acknowledge it (exhaustive `when`).

## Deep links — land at the right STATE

- Pre-populate the state the user expects: right tab, right item, right filter.
- Define per linkable destination: synchronous from URL, async, and loading-state UI.
- Round-trip MUST be lossless: state → URL → parse → state equals original.

## Back — defined per screen

- Every screen has one back target. System gesture, in-screen back button, and navbar chevron MUST agree.
- After multi-step flows (e.g. checkout), back from confirmation does NOT re-enter the flow.
- Modal dismiss restores underlying screen as-was; modal back-stack is local.

## Tabs — roots, not pushable

- Tabs are roots with their own back stacks. Switching tabs does NOT push onto a global stack.
- Deep link into tabbed app selects the right tab AND drives that tab's stack; other tabs keep state.

## Forbidden

- Passing large objects through routes. Pass the ID; refetch.
- Navigation by side effect (mutating a global + letting next render notice).
- Back behavior conditional on caller. If the screen needs to know its caller, it's a flow with an explicit entry.

- Platform navigation APIs differ; the principle of typed destinations and defined back stacks applies on both. See the details file for concrete Android and iOS implementations.

> When a rule is unclear, read `agents/docs/mobile/mobile-navigation-details.md`.
