# SwiftUI -- Details & Examples

This file expands `platforms/ios/rules/swiftui.md`. The rule
states the bar; this doc shows the patterns and the anti-patterns
the agent reaches for when uncertain.

## Observation (iOS 17+) — the primary state pattern

```swift
@Observable
final class CounterViewModel {
    var count: Int = 0
    func increment() { count += 1 }
}

struct CounterView: View {
    @State private var vm = CounterViewModel()

    var body: some View {
        VStack {
            Text("\(vm.count)")
            Button("Increment") { vm.increment() }
        }
    }
}
```

`@Observable` is a macro applied to a `final class` (or actor). The macro:
- Generates per-property tracking; SwiftUI re-renders only views that read changed properties.
- Removes the `@Published` boilerplate.
- Works seamlessly with `@State` (owner) and `@Bindable` (two-way binding into the VM).

`@Bindable` example:

```swift
struct ProfileView: View {
    @Bindable var vm: ProfileViewModel
    var body: some View {
        Form {
            TextField("Name", text: $vm.name)   // two-way to vm.name
            Toggle("Notifications", isOn: $vm.notifications)
        }
    }
}
```

Pass the VM down via the `@Bindable` wrapper at the consuming view.

## Pre-iOS-17 fallback (legacy)

If your minimum target is iOS 16 or earlier, use the older property wrappers:

- `@StateObject` — reference-type state OWNED by this view; SwiftUI keeps alive across recompositions. Use exactly once per object at the owning level.
- `@ObservedObject` — reference-type state PASSED IN from a parent.

Both require the class to conform to `ObservableObject` and properties to be marked `@Published`. Pattern is verbose; migrate to Observation once min target is iOS 17.

## State hoisting -- a concrete pattern

The leaf is stateless. It declares what it needs and what it
emits. The screen owns the state and threads it down.

```swift
// Stateless leaf -- previewable with fake data, no ViewModel
// reference, no I/O.
struct LoginForm: View {
    let state: LoginUIState
    let onEmailChange: (String) -> Void
    let onPasswordChange: (String) -> Void
    let onSubmit: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            TextField("Email", text: Binding(
                get: { state.email },
                set: onEmailChange
            ))
            SecureField("Password", text: Binding(
                get: { state.password },
                set: onPasswordChange
            ))
            Button("Sign in", action: onSubmit)
                .disabled(!state.canSubmit)
        }
        .padding()
    }
}

// Screen owns the ViewModel. The leaf knows nothing about it.
struct LoginScreen: View {
    @State private var viewModel = LoginViewModel()

    var body: some View {
        LoginForm(
            state: viewModel.state,
            onEmailChange: viewModel.emailChanged,
            onPasswordChange: viewModel.passwordChanged,
            onSubmit: viewModel.submit
        )
    }
}

#Preview("Empty") {
    LoginForm(
        state: LoginUIState(),
        onEmailChange: { _ in },
        onPasswordChange: { _ in },
        onSubmit: {}
    )
}

#Preview("Error") {
    LoginForm(
        state: LoginUIState(emailError: "Invalid email"),
        onEmailChange: { _ in },
        onPasswordChange: { _ in },
        onSubmit: {}
    )
}
```

## `@StateObject` vs `@ObservedObject` -- decision tree

```
Does THIS view create the object?
├── YES -> @StateObject (SwiftUI manages its lifetime across
│         recompositions; create exactly once per owner).
└── NO -> Where does it come from?
    ├── Passed in from a parent -> @ObservedObject (or a plain
    │     `let` if you do not need to observe changes).
    ├── Injected via environment -> @EnvironmentObject (or
    │     @Environment for value-type dependencies).
    └── iOS 17+ @Observable macro -> @Bindable when you need
          bindings, otherwise plain `let`.
```

The classic bug: marking the owning view's reference type as
`@ObservedObject`. SwiftUI will discard and recreate it on every
parent recomposition, dropping all in-flight work. Use
`@StateObject` at the owner; `@ObservedObject` everywhere it is
passed down.

## Effects -- which one when

```swift
struct UserDetailScreen: View {
    let userID: UserID
    @StateObject private var viewModel = UserDetailViewModel()

    var body: some View {
        UserDetailContent(state: viewModel.state)
            // Async work scoped to the view's lifecycle.
            // Cancels when the view leaves the hierarchy.
            .task {
                await viewModel.load(userID)
            }
            // Reload when the input changes.
            .task(id: userID) {
                await viewModel.load(userID)
            }
            // State-driven side effect.
            .onChange(of: viewModel.state.didLogout) { _, didLogout in
                if didLogout { dismiss() }
            }
    }

    @Environment(\.dismiss) private var dismiss
}
```

Common mistake: using `.onAppear { Task { await load() } }`
instead of `.task { await load() }`. The `.task` form is
lifecycle-bound and cancels correctly; the `.onAppear` form
leaks the task if the view disappears mid-load.

## Recomposition pitfalls

```swift
// BAD: a non-Equatable struct in @State forces SwiftUI to
// re-diff the whole subtree every time. Make state Equatable.
struct UIState {
    var items: [Item]
    var selection: Item.ID?
}

// GOOD:
struct UIState: Equatable {
    var items: [Item]
    var selection: Item.ID?
}
```

```swift
// BAD: closure captured in body allocates a new instance every
// recomposition. SwiftUI sees a "different" parameter and
// re-renders the child unnecessarily.
ChildView(onTap: { viewModel.handleTap() })

// SLIGHTLY BETTER: stable method reference, equal across
// recompositions.
ChildView(onTap: viewModel.handleTap)
```

```swift
// BAD: ForEach without Identifiable. SwiftUI uses position as
// identity; reordering or insertion produces wrong animations
// and wrong state restoration.
ForEach(items, id: \.self) { item in Row(item: item) }

// GOOD: stable identity from the model.
struct Item: Identifiable { let id: UUID; ... }
ForEach(items) { item in Row(item: item) }
```

## `.id(_:)` for intentional identity swaps

When a screen's underlying entity changes, you sometimes want to
force a full rebuild (resetting all `@State` inside) rather than
animating from old to new. That is `.id()`'s job:

```swift
struct ProfileScreen: View {
    let profileID: ProfileID

    var body: some View {
        ProfileContent(profileID: profileID)
            .id(profileID)  // new profileID -> new view identity
    }                       // -> all @State inside resets.
}
```

Use sparingly. Most of the time, you want SwiftUI to diff
incrementally; `.id()` opts out of that.

## Preview matrix

For a screen that ships to production, the preview file should
cover at minimum:

```swift
#Preview("Empty / Light") {
    UserListScreen(state: .empty)
}

#Preview("Populated / Dark") {
    UserListScreen(state: .populated([sampleUser]))
        .preferredColorScheme(.dark)
}

#Preview("Error / Accessibility size") {
    UserListScreen(state: .error("Network unavailable"))
        .dynamicTypeSize(.accessibility3)
}

#Preview("Loading / RTL") {
    UserListScreen(state: .loading)
        .environment(\.layoutDirection, .rightToLeft)
}
```

These four previews catch a lot of bugs (theme mismatches, text
clipping under large font scale, mirrored layout glitches, empty-
state copy missing) before the screen ever runs on a device.
