# Combine -- Details & Examples

This file expands `platforms/ios/rules/combine.md`. The patterns
below show legacy-bridge usage and the retain-cycle anti-patterns
that bite Combine code most often.

## Legal bridging examples

A framework hands you a publisher; you want async values:

```swift
import Combine

// `NotificationCenter.publisher` gives a Combine publisher.
// Bridge to AsyncSequence at the boundary.
@MainActor
final class KeyboardObserver {
    @Published private(set) var height: CGFloat = 0
    private var task: Task<Void, Never>?

    func start() {
        task = Task { @MainActor in
            for await note in NotificationCenter.default
                .publisher(for: UIResponder.keyboardWillChangeFrameNotification)
                .values
            {
                guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey]
                    as? CGRect else { continue }
                height = frame.height
            }
        }
    }

    deinit { task?.cancel() }
}
```

A `CurrentValueSubject` exposed as a read-only publisher:

```swift
final class ThemeStore {
    private let subject = CurrentValueSubject<Theme, Never>(.system)

    var current: Theme { subject.value }
    var publisher: AnyPublisher<Theme, Never> { subject.eraseToAnyPublisher() }

    func update(_ theme: Theme) { subject.send(theme) }
}
```

Consumer bridges to AsyncSequence:

```swift
@MainActor
final class HomeViewModel: ObservableObject {
    @Published private(set) var theme: Theme = .system
    private var observationTask: Task<Void, Never>?

    init(themeStore: ThemeStore) {
        observationTask = Task { @MainActor [weak self] in
            for await theme in themeStore.publisher.values {
                self?.theme = theme
            }
        }
    }

    deinit { observationTask?.cancel() }
}
```

## Retain-cycle anti-patterns

The classic `assign(to:on:)` cycle:

```swift
// BAD: `assign(to: \.title, on: self)` captures `self` strongly.
// The subscription holds the cancellable, the cancellable holds
// `self`, `self` holds the cancellables Set. Cycle.
final class ProfileViewModel {
    @Published var title: String = ""
    private var cancellables: Set<AnyCancellable> = []

    init(repo: ProfileRepository) {
        repo.titlePublisher
            .receive(on: DispatchQueue.main)
            .assign(to: \.title, on: self)
            .store(in: &cancellables)
    }
}
```

Two correct forms:

```swift
// GOOD A: property-wrapper assign. Manages weakness internally.
final class ProfileViewModel: ObservableObject {
    @Published var title: String = ""
    private var cancellables: Set<AnyCancellable> = []

    init(repo: ProfileRepository) {
        repo.titlePublisher
            .receive(on: DispatchQueue.main)
            .assign(to: &$title)  // no retain cycle, manages itself
    }
}

// GOOD B: explicit weak in a sink.
final class ProfileViewModel: ObservableObject {
    @Published var title: String = ""
    private var cancellables: Set<AnyCancellable> = []

    init(repo: ProfileRepository) {
        repo.titlePublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in
                self?.title = value
            }
            .store(in: &cancellables)
    }
}
```

## Subject choice -- state vs events

```swift
// STATE -- CurrentValueSubject. New subscriber sees current.
final class AuthStore {
    let user = CurrentValueSubject<User?, Never>(nil)

    func signIn(_ user: User) { self.user.send(user) }
    func signOut()            { self.user.send(nil) }
}

// EVENTS -- PassthroughSubject. No current; subscribers see
// only events emitted after they subscribed.
final class Analytics {
    let events = PassthroughSubject<AnalyticsEvent, Never>()

    func track(_ event: AnalyticsEvent) { events.send(event) }
}
```

The bug to avoid: using `PassthroughSubject` for state. A
subscriber that subscribes after the event has fired gets
nothing -- the screen renders the empty default forever.

## Cancellables-set lifetime

```swift
// GOOD: tied to the owning object.
final class HomeViewModel: ObservableObject {
    private var cancellables: Set<AnyCancellable> = []
    // deinit implicitly cancels everything in the set.
}

// BAD: static = forever.
final class Globals {
    static var cancellables: Set<AnyCancellable> = []
}

// BAD: stored in a singleton with no clear ownership of when
// to clear. Subscriptions live until the process dies.
let sharedCancellables = NSPointerArray.weakObjects()
```

If a subscription must outlive a screen, model it as a service
object with a clear lifetime contract (e.g., signed-in -> signed
-out), not as a free-floating static.

## When the bridge is wrong -- new code path

If you're writing new code and you find yourself reaching for
Combine, ask first:

1. Is there a Combine surface I must conform to? If no, use
   `async/await` and skip Combine entirely.
2. Is the work a one-shot? Use `Task { await ... }`, not a
   publisher.
3. Is the work a stream? Use `AsyncStream<T>`, not
   `PassthroughSubject`.
4. Is the work state? Use `@Published` on an `ObservableObject`
   (or `@Observable` on iOS 17+), not a `CurrentValueSubject`
   piped through `.sink`.

Combine remains useful at boundaries (especially with Apple
APIs that still return publishers), but the interior of new
modules should not depend on it.
