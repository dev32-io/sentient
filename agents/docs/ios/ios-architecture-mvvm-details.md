# MVVM Architecture -- Details & Worked Example

This file expands `platforms/ios/rules/ios-architecture-mvvm.md`.
The example below shows the full flow end-to-end for a Login
screen: `LoginState`, `LoginRoute`, `LoginViewModel`, the
`LoginUseCase` abstraction, and the consuming view.

## LoginState

A `sealed` modeling of the screen's mode -- idle, loading, error,
success. The flat form fields are separate from the mode so that
typing into "email" does not have to redeclare the entire state.

```swift
struct LoginUIState: Equatable, Sendable {
    var email: String = ""
    var password: String = ""
    var mode: Mode = .idle

    enum Mode: Equatable, Sendable {
        case idle
        case loading
        case error(message: String)
    }

    var canSubmit: Bool {
        !email.isEmpty && !password.isEmpty && mode != .loading
    }
}
```

`canSubmit` is a derived computed property -- the view reads it
directly, no extra plumbing.

## LoginRoute -- navigation as state

```swift
enum LoginRoute: Hashable, Identifiable {
    case home(userID: UserID)
    case forgotPassword

    var id: Self { self }
}
```

The view binds `NavigationStack` and `.sheet(item:)` to this
enum. The ViewModel decides where the user goes by setting it.

## LoginUseCase -- the abstraction

```swift
protocol LoginUseCase: Sendable {
    func execute(email: String, password: String) async -> LoginOutcome
}

enum LoginOutcome: Sendable {
    case success(UserID)
    case invalidEmail(reason: String)
    case invalidPassword(reason: String)
    case networkFailure
}

struct DefaultLoginUseCase: LoginUseCase {
    let authRepository: AuthRepository

    func execute(email: String, password: String) async -> LoginOutcome {
        guard email.contains("@") else {
            return .invalidEmail(reason: "Enter a valid email")
        }
        guard password.count >= 8 else {
            return .invalidPassword(reason: "Password too short")
        }
        do {
            let userID = try await authRepository.signIn(email, password)
            return .success(userID)
        } catch is URLError {
            return .networkFailure
        } catch AuthError.invalidCredentials {
            return .invalidPassword(reason: "Incorrect password")
        } catch {
            return .networkFailure
        }
    }
}
```

The ViewModel depends on the protocol, not the concrete type --
the test substitutes a fake without touching the real network.

## LoginViewModel

```swift
@Observable
@MainActor
final class LoginViewModel {
    private(set) var state = LoginUIState()
    var route: LoginRoute?

    private let loginUseCase: LoginUseCase

    init(loginUseCase: LoginUseCase) {
        self.loginUseCase = loginUseCase
    }

    func emailChanged(_ value: String) {
        state.email = value
        if case .error = state.mode { state.mode = .idle }
    }

    func passwordChanged(_ value: String) {
        state.password = value
        if case .error = state.mode { state.mode = .idle }
    }

    func submitTapped() {
        guard state.canSubmit else { return }
        state.mode = .loading
        Task {
            let outcome = await loginUseCase.execute(
                email: state.email,
                password: state.password
            )
            switch outcome {
            case .success(let userID):
                state.mode = .idle
                route = .home(userID: userID)
            case .invalidEmail(let reason):
                state.mode = .error(message: reason)
            case .invalidPassword(let reason):
                state.mode = .error(message: reason)
            case .networkFailure:
                state.mode = .error(message: "Network unavailable")
            }
        }
    }

    func forgotPasswordTapped() {
        route = .forgotPassword
    }
}
```

Key properties of this ViewModel:
- `@MainActor` -- the compiler enforces UI mutations on main.
- `private(set) var state` -- only methods on this class mutate
  it; the view reads it.
- `route` is mutable from the view ONLY for the dismiss case
  (binding back to `nil`); the ViewModel sets it for navigation.
- The Task is unstructured (started from a method, not stored).
  If we needed cancellation, we'd store the `Task` handle.

## The view

```swift
struct LoginScreen: View {
    @State private var viewModel: LoginViewModel

    init(useCase: LoginUseCase) {
        _viewModel = State(wrappedValue: LoginViewModel(loginUseCase: useCase))
    }

    var body: some View {
        NavigationStack {
            LoginForm(
                state: viewModel.state,
                onEmailChange: viewModel.emailChanged,
                onPasswordChange: viewModel.passwordChanged,
                onSubmit: viewModel.submitTapped,
                onForgotPassword: viewModel.forgotPasswordTapped
            )
            .navigationDestination(item: $viewModel.route) { route in
                switch route {
                case .home(let userID):       HomeScreen(userID: userID)
                case .forgotPassword:         ForgotPasswordScreen()
                }
            }
        }
    }
}
```

`LoginForm` is the stateless leaf -- it takes `state` and
callbacks. It can be `#Preview`'d with fake state without any
ViewModel involved.

## Testing the ViewModel

Because the ViewModel is "method in, state out, I/O behind a
protocol," unit testing is mechanical: construct a VM with a
fake use case, call methods, assert state.

```swift
@MainActor
@Test
func submitWithValidFormNavigatesToHome() async {
    let fakeUseCase = FakeLoginUseCase()
    fakeUseCase.nextOutcome = .success(UserID("u-1"))
    let vm = LoginViewModel(loginUseCase: fakeUseCase)

    vm.emailChanged("a@b.c")
    vm.passwordChanged("hunter2_strong")
    vm.submitTapped()

    // Yield until the Task completes.
    await Task.yield()
    await Task.yield()

    #expect(vm.state.mode == .idle)
    #expect(vm.route == .home(userID: UserID("u-1")))
}

@MainActor
@Test
func networkFailureShowsErrorMode() async {
    let fakeUseCase = FakeLoginUseCase()
    fakeUseCase.nextOutcome = .networkFailure
    let vm = LoginViewModel(loginUseCase: fakeUseCase)

    vm.emailChanged("a@b.c")
    vm.passwordChanged("hunter2_strong")
    vm.submitTapped()
    await Task.yield()
    await Task.yield()

    if case .error(let msg) = vm.state.mode {
        #expect(msg == "Network unavailable")
    } else {
        Issue.record("expected error mode, got \(vm.state.mode)")
    }
    #expect(vm.route == nil)
}
```

This is why we keep state and route separate, and why we keep
I/O behind a protocol: each axis can be asserted independently.

## Observation-based ViewModel (audit I3)

```swift
@Observable
@MainActor
final class ProfileViewModel {
    enum Route: Hashable {
        case editProfile
        case settings(section: SettingsSection)
    }

    var state: ProfileState = .loading
    var path: [Route] = []
    private let repository: ProfileRepository

    init(repository: ProfileRepository) {
        self.repository = repository
        Task { await load() }
    }

    func load() async {
        do {
            state = .loaded(try await repository.fetch())
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    func editTapped() { path.append(.editProfile) }
}

struct ProfileScreen: View {
    @State private var vm: ProfileViewModel

    init(repository: ProfileRepository) {
        _vm = State(wrappedValue: ProfileViewModel(repository: repository))
    }

    var body: some View {
        NavigationStack(path: $vm.path) {
            ProfileContent(state: vm.state, onEdit: vm.editTapped)
                .navigationDestination(for: ProfileViewModel.Route.self) { route in
                    switch route {
                    case .editProfile: EditProfileView()
                    case .settings(let section): SettingsView(section: section)
                    }
                }
        }
    }
}
```

`ProfileContent` is the stateless leaf — takes `state` + closures, no VM reference, easy to `#Preview`.
