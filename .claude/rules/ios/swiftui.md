---
description: SwiftUI -- pure views, Observation primary, state hoisting, effects, previews mandatory.
paths:
  - "ios/**"
---

# SwiftUI

The SwiftUI runtime relies on purity, state ownership, and identity to skip work.

## Pure views
- `body` has NO side effects (no network, no I/O, no shared-state mutation, no analytics).
- Side effects in `.task { }`, `.task(id:) { }`, `.onAppear { }`, `.onChange(of:) { }`.

## State — Observation first (iOS 17+)
- `@Observable` class + `@State var vm = MyVM()` on the owning view; `@Bindable` for two-way bindings.
- Legacy fallback (iOS 16 and earlier): `@StateObject` (owner) / `@ObservedObject` (passed-in).
- `@Environment(\.x)` for ambient dependencies (theme, dismiss action, DI services).

## State hoisting
- Stateless leaf views take `state: T` + closures (`onTap: () -> Void`); never reference a ViewModel.
- Screen-level views own the VM; leaves do not.

## Effects — pick the right modifier
- `.task { }` — async work scoped to view lifetime; cancels on disappear.
- `.task(id:) { }` — restarts when id changes.
- `.onChange(of: v) { ... }` — state-driven side effects on `@MainActor`.
- Prefer `.task` over `.onAppear { Task { } }`.

## Previews — mandatory
- Every screen-level view: at least one `#Preview`; multi-state screens get one per state.
- Previews take fake data; no real network / VM I/O.
- Variant previews: `.preferredColorScheme(.dark)`, `.dynamicTypeSize(.accessibility3)`.

## Identifiability
- `ForEach` content is `Identifiable` or has explicit `id:`.
- `.id(value)` only when you intentionally want full rebuild on value change (sparingly).

See `agents/docs/ios/swiftui-details.md`.
