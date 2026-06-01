# Swift -- Details & Examples

This file expands `platforms/ios/rules/swift.md`. The rule states
the bar; this doc shows the patterns and the anti-patterns the
agent reaches for when uncertain.

## Optional-handling patterns

The hierarchy of preference, strongest to weakest:

```swift
// 1. guard let -- best at the top of a function. The non-nil
// binding lives in the surrounding scope; the failure path is
// explicit.
func render(_ user: User?) {
    guard let user else { return }
    print(user.name)
}

// 2. if let -- when the work only applies inside a branch.
if let token = input.token {
    authenticate(with: token)
}

// 3. Nil-coalescing for fallback values.
let display = user?.name ?? "Anonymous"

// 4. Optional chaining for transform-if-present.
let count = user?.followers.count ?? 0
```

The forbidden form:

```swift
// NEVER. `!` says "I promise this is non-nil." When the promise
// breaks, the trap points at the `!`, not at the actual bug.
let name = user!.name
```

If you find yourself writing `!`, the right answer is one of:
1. Change the type to non-optional upstream.
2. Use `guard let x else { fatalError("...") }` with a message.
3. Handle the nil case explicitly.

`try!` is the same anti-pattern for throwing functions; use
`do { try ... } catch { ... }` or propagate with `try`.

## Value vs reference -- when each is right

```swift
// VALUE: a record of values. Identity is not load-bearing;
// equality is structural.
struct User: Equatable, Sendable {
    let id: UserID
    var name: String
    var email: String
}

// REFERENCE: an object with identity. Two AuthSessions with
// equal fields are still distinct sessions.
final class AuthSession {
    let id: SessionID
    private(set) var lastRefreshed: Date
    // ...
}
```

Rule of thumb: if you'd be comfortable comparing two instances
field-by-field for equality, it's a value type. If "same fields,
different object" is a meaningful distinction, it's a reference
type.

## Enum + associated values for closed sums

```swift
enum LoadState<Value: Sendable>: Sendable {
    case idle
    case loading
    case success(Value)
    case failure(Error)
}

// Exhaustive switch -- adding a case forces every consumer to
// update. The compiler is doing the work.
func render(_ state: LoadState<User>) -> some View {
    switch state {
    case .idle:                    return AnyView(EmptyState())
    case .loading:                 return AnyView(Spinner())
    case .success(let user):       return AnyView(UserCard(user))
    case .failure(let error):      return AnyView(ErrorView(error))
    }
}
```

## Protocol orientation -- composition over inheritance

```swift
protocol Identifiable { associatedtype ID: Hashable; var id: ID { get } }
protocol Reloadable { func reload() async throws }

// Compose small protocols at the use site.
protocol UserListItem: Identifiable, Sendable where ID == UserID {
    var displayName: String { get }
}

// Default implementations via extension. Conformers can override.
extension Reloadable {
    func reloadWithBackoff() async throws {
        for delay in [0.5, 1.0, 2.0] {
            do { try await reload(); return }
            catch { try await Task.sleep(for: .seconds(delay)) }
        }
        try await reload()
    }
}
```

## Result vs throws -- the decision

Use `throws` for the inner-call form -- terse, composes via
`try`:

```swift
func loadUser(id: UserID) async throws -> User {
    let data = try await transport.fetch(.user(id))
    return try JSONDecoder().decode(User.self, from: data)
}
```

Use `Result<Success, Failure>` when the caller is a Combine
publisher, an `@escaping` completion, or anywhere you want the
failure case as a value rather than a control-flow jump:

```swift
enum LoadUserOutcome: Sendable {
    case found(User)
    case notFound
    case transportFailure(URLError)
}

func loadUser(id: UserID) async -> LoadUserOutcome {
    do {
        return .found(try await api.fetchUser(id))
    } catch let urlError as URLError {
        return .transportFailure(urlError)
    } catch APIError.notFound {
        return .notFound
    } catch {
        return .transportFailure(URLError(.unknown))
    }
}
```

The domain-enum form is preferred when:
- Callers must discriminate the failure (not-found vs transport).
- The failure carries useful data (validation errors, retry hint).
- The surface is a public module/feature boundary.

## Sendable -- making types safe to share

```swift
// FREE: value type of Sendable parts.
struct Profile: Sendable {
    let id: UUID
    let name: String
    let createdAt: Date
}

// EXPLICIT: a final class whose state is only mutated under a
// lock or actor. The annotation is a promise; the implementation
// must keep it.
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int = 0
    func increment() { lock.withLock { value += 1 } }
}

// PREFERRED for shared mutable state: an actor.
actor SafeCounter {
    private var value: Int = 0
    func increment() { value += 1 }
}
```

## Errors as enums

```swift
enum AuthError: Error, LocalizedError, Sendable {
    case invalidCredentials
    case rateLimited(retryAfter: Duration)
    case transport(URLError)

    var errorDescription: String? {
        switch self {
        case .invalidCredentials:        return "Invalid credentials."
        case .rateLimited(let retry):    return "Try again in \(retry)."
        case .transport(let underlying): return underlying.localizedDescription
        }
    }
}
```

Compare against the anti-pattern: stringly-typed `NSError` bags
where the call site has to memorize a `domain`/`code` pair. The
enum form gives the compiler something to enforce.

## Swift 6 — typed throws

Swift 6 lands typed throws as a first-class feature:

```swift
enum DataError: Error {
    case decoding(String)
    case network(URLError)
}

func loadUser(id: String) async throws(DataError) -> User { ... }
```

Callers know the precise error type without `as?` casting. Use for boundary functions where the error set is closed and small. For functions whose error set is open / depends on dynamic dispatch, untyped `throws` remains correct.

## Sendable upgrades

Swift 6 makes strict concurrency the default. Common upgrades:

- Reference types that have no mutable state: `final class FooView: View, Sendable {}` (View itself is implicitly `Sendable` when frozen).
- Reference types with synchronized mutable state: `final class Cache: @unchecked Sendable {}` with internal lock + `// MARK: Sendable: invariant: all mutation through serialQueue` comment.
- Closures passed across actors: declare `@Sendable`. The compiler will tell you when you forgot.
