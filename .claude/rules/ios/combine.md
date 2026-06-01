---
description: Combine -- legacy-bridge only, lifetime-scoped cancellables, retain-cycle hygiene.
paths:
  - "ios/**"
---

# Combine

In new code prefer `async/await` + `AsyncSequence`. Combine is acceptable only where the surrounding code already uses it or a framework hands you publishers.

## When to reach for Combine
- Surrounding module is already Combine-shaped.
- A non-owned framework returns `Publisher` you can't cleanly bridge.
- Need behavior `AsyncSequence` doesn't express (multicasting, `combineLatest` across N inputs).

## When NOT to
- New code with no Combine surface.
- ViewModels with state — use `@Observable` + `async/await`.
- Anywhere a `for await ...` loop suffices.

## Lifetime — `Set<AnyCancellable>` per owner
- Store every subscription in `private var cancellables: Set<AnyCancellable> = []` tied to the OWNING object's lifetime.
- Owner's `deinit` releases the set → cancels all.
- NEVER store an `AnyCancellable` in a static or global.

## Subjects — pick the right one
- `CurrentValueSubject` — has a current value; state-like (active theme, current user).
- `PassthroughSubject` — no current value; event-like (button tapped, logout requested).
- `@Published` — a `CurrentValueSubject` glued to an `ObservableObject` property (legacy).

## Retain cycles — the recurring bug
- `assign(to:on:)` captures `on:` strongly; `on: self` = cycle. Use `assign(to: &$published)` instead.
- `sink { }` captures freely; always declare `[weak self]`.

## Bridging to async/await
- `publisher.values` is an `AsyncPublisher`; iterate with `for await`.
- Single-value, then complete: `await publisher.first().values`.
- NEVER bridge async/await BACK to Combine unless a framework forces it.

See `agents/docs/ios/combine-details.md`.
