---
description: Swift idioms -- value types, no force-unwrap, protocol orientation, Sendable, typed throws.
paths:
  - "ios/**"
---

# Swift

Swift's type system pushes failure modes from runtime to compile time.

## Value types over reference types
- `struct` wherever identity isn't load-bearing; `final class` only for identity / ObjC interop.
- `enum` with associated values for closed sums.

## Immutability first; optionals never force-unwrap
- `let` over `var`; non-mutating operations (`map`, `filter`, `reduce`) over in-place mutation.
- NEVER `!` on optionals. Use `if let`, `guard let`, `??`.
- Invariant violations: `guard let x = x else { fatalError("...") }` with a real message.

## Protocol orientation
- Protocols + extensions as the primary unit of reuse; class inheritance is last resort.
- Compose small protocols (`Equatable`, `Hashable`, `Sendable`); avoid mega-ViewModel protocols.

## `Result` / `throws` — at boundaries

- Use `Result<Success, Failure: Error>` OR `throws` — not both. Public signatures declare the failure shape.
- Swift 6: typed throws (`func foo() throws(MyError) -> T`) preferred over untyped `throws`.

## `Sendable` + `@MainActor`

- Types crossing concurrency boundaries are `Sendable`; closures need `@Sendable`.
- Value types of `Sendable` parts: free. Reference types: `final class ... : Sendable` or argued `@unchecked Sendable`.
- UI-touching properties/methods are `@MainActor`; compiler enforces statically.
- Enable Swift 6 strict mode in xcconfig (see `swift-concurrency.md`).

## Errors — typed enums

- `enum SomeError: Error, Sendable` per layer; associated values carry diagnostic detail.
- `LocalizedError` for user-facing messages.

See `agents/docs/ios/swift-details.md`.
