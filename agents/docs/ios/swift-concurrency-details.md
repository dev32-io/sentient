# Swift Concurrency -- Details & Examples

This file expands `platforms/ios/rules/swift-concurrency.md`.
The patterns below show structured-vs-unstructured tasks,
`@MainActor` propagation, and common Sendable warnings + fixes.

## Structured vs unstructured tasks

Structured concurrency means: a parent task knows about its
children, and cancelling the parent cancels the children. The
two structured forms:

```swift
// `async let` -- two independent fetches, awaited together.
// If either throws, both are cancelled.
func loadDashboard(userID: UserID) async throws -> Dashboard {
    async let profile = api.fetchProfile(userID)
    async let posts   = api.fetchPosts(userID)
    return Dashboard(
        profile: try await profile,
        posts:   try await posts
    )
}

// `withTaskGroup` -- N parallel children, gathered as they
// finish. Cancellation propagates from the group.
func loadAllAvatars(userIDs: [UserID]) async -> [UserID: UIImage] {
    await withTaskGroup(of: (UserID, UIImage?).self) { group in
        for id in userIDs {
            group.addTask {
                (id, try? await self.api.fetchAvatar(id))
            }
        }
        var result: [UserID: UIImage] = [:]
        for await (id, image) in group {
            if let image { result[id] = image }
        }
        return result
    }
}
```

The unstructured form -- a top-level `Task { ... }` -- is fine
at the boundary between sync and async code (e.g., a `@MainActor`
ViewModel method starting work):

```swift
@MainActor
final class FeedViewModel: ObservableObject {
    @Published var state: FeedState = .loading

    func refresh() {
        // Unstructured Task started from sync method. The Task
        // inherits @MainActor from the surrounding context.
        Task {
            do {
                let items = try await api.fetchFeed()
                state = .loaded(items)
            } catch {
                state = .error(error)
            }
        }
    }
}
```

The anti-pattern -- `Task.detached` used reflexively to "go off
main":

```swift
// BAD: drops the parent's actor + priority. The work no longer
// participates in structured cancellation. Almost never what
// you want.
func refresh() {
    Task.detached {
        let items = try await api.fetchFeed()
        await MainActor.run { self.state = .loaded(items) }
    }
}

// GOOD: same effect, structured. URLSession's async API already
// runs off-main; you only need MainActor for the assignment.
func refresh() {
    Task {
        let items = try await api.fetchFeed()
        state = .loaded(items)  // already on @MainActor
    }
}
```

Use `Task.detached` only when:
1. You genuinely need to escape the parent's actor (rare).
2. You're crossing from a non-Swift context (e.g., a C callback)
   and there is no parent to inherit from.

## `@MainActor` propagation

`@MainActor` propagates through async calls; you do not need to
hop manually.

```swift
@MainActor
final class ProfileViewModel: ObservableObject {
    @Published var name = ""

    // Inherits @MainActor. The `await api.fetchName()` call
    // suspends and runs on whatever actor `api` lives on;
    // resumption is back on the main actor.
    func load() async {
        let fetched = try? await api.fetchName()
        name = fetched ?? ""  // safe; we're back on main.
    }
}
```

A method on a non-`@MainActor` type that needs main can be
annotated locally:

```swift
final class Analytics {
    @MainActor
    func showToast(_ message: String) {
        UIApplication.shared.windows.first?.rootViewController?
            .showToast(message)
    }
}
```

## Cancellation cooperation

```swift
// Long CPU loop -- cooperate by checking cancellation.
func indexAll(_ items: [Item]) async throws -> Index {
    var index = Index()
    for item in items {
        try Task.checkCancellation()  // throws CancellationError
        index.insert(item.normalized())
    }
    return index
}

// Storing a Task for cancellation -- the one valid case for
// long-term retention.
@MainActor
final class SearchViewModel: ObservableObject {
    @Published var results: [SearchResult] = []
    private var searchTask: Task<Void, Never>?

    func search(_ query: String) {
        searchTask?.cancel()           // cancel previous
        searchTask = Task {
            do {
                let hits = try await api.search(query)
                guard !Task.isCancelled else { return }
                results = hits
            } catch is CancellationError {
                // expected; user typed another character
            } catch {
                // real error
            }
        }
    }

    deinit { searchTask?.cancel() }
}
```

## Sendable warnings + common fixes

```swift
// WARNING: "Capture of 'self' with non-sendable type ... in a
// `@Sendable` closure".
// Fix: capture only the Sendable bits.
Task {
    let userID = self.userID                       // Sendable
    let result = try await api.fetchUser(userID)
    await MainActor.run { self.user = result }
}

// WARNING: "Stored property 'cache' of 'Sendable'-conforming
// class 'X' is mutable".
// Fix: either make the class an actor, or move the mutable
// state into one.
actor UserCache {
    private var users: [UserID: User] = [:]
    func get(_ id: UserID) -> User? { users[id] }
    func set(_ id: UserID, _ user: User) { users[id] = user }
}

// WARNING: "Type 'X' does not conform to 'Sendable'".
// Fix: if the type is a value of Sendable parts, add the
// conformance:
struct UserDTO: Codable, Sendable {
    let id: UserID
    let name: String
}
```

## Bridging legacy completion handlers

When you must call a legacy API that takes a completion handler:

```swift
extension LegacyClient {
    func fetchUser(_ id: UserID) async throws -> User {
        try await withCheckedThrowingContinuation { continuation in
            self.fetchUser(id) { result in
                switch result {
                case .success(let user): continuation.resume(returning: user)
                case .failure(let err):  continuation.resume(throwing: err)
                }
            }
        }
    }
}
```

Wrap exactly once, at the boundary. Above the boundary, the rest
of the code sees only `async` -- no completion handlers leak in.

## Swift 6 strict mode (audit I2)

`Config/App.xcconfig`:

```
SWIFT_VERSION = 6.0
SWIFT_STRICT_CONCURRENCY = complete
SWIFT_UPCOMING_FEATURE_REGION_BASED_ISOLATION = YES
SWIFT_UPCOMING_FEATURE_ISOLATED_DEFAULT_VALUES = YES
```

Region-based isolation: the compiler tracks "regions" of objects that move between actors; types don't need to be `Sendable` if they can never be touched from two regions simultaneously. Dramatically reduces `@unchecked Sendable` annotations.

Common migration pain:
- Global mutable state → wrap in `actor` or annotate `@MainActor`.
- ObjC types not `Sendable` → `@preconcurrency import UIKit` as escape hatch while migrating callers.
- Closure captures that cross actors → declare closure `@Sendable` + `[weak self]` to break reference cycles.
