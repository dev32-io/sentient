# iOS Testing -- Details & Examples

This file expands `platforms/ios/rules/ios-testing.md`. The
patterns below show concrete examples for each layer.

## Unit test -- Swift Testing (iOS 17+ / Xcode 16+)

```swift
import Testing
@testable import App

@MainActor
@Test("submit with valid form transitions to loading then success")
func submitHappyPath() async {
    let fakeUseCase = FakeLoginUseCase()
    fakeUseCase.nextOutcome = .success(UserID("u-1"))
    let vm = LoginViewModel(loginUseCase: fakeUseCase)

    vm.emailChanged("a@b.c")
    vm.passwordChanged("hunter2_strong")
    vm.submitTapped()

    #expect(vm.state.mode == .loading)

    await Task.yield()
    await Task.yield()

    #expect(vm.state.mode == .idle)
    #expect(vm.route == .home(userID: UserID("u-1")))
    #expect(fakeUseCase.calls.count == 1)
}
```

## Unit test -- legacy XCTest (still common)

```swift
import XCTest
@testable import App

final class LoginViewModelTests: XCTestCase {
    @MainActor
    func testSubmitHappyPath() async {
        let fake = FakeLoginUseCase()
        fake.nextOutcome = .success(UserID("u-1"))
        let vm = LoginViewModel(loginUseCase: fake)

        vm.emailChanged("a@b.c")
        vm.passwordChanged("hunter2_strong")
        vm.submitTapped()
        XCTAssertEqual(vm.state.mode, .loading)

        await Task.yield()
        await Task.yield()

        XCTAssertEqual(vm.state.mode, .idle)
        XCTAssertEqual(vm.route, .home(userID: UserID("u-1")))
        XCTAssertEqual(fake.calls.count, 1)
    }
}
```

## Fake over mock

A protocol at the boundary:

```swift
protocol LoginUseCase: Sendable {
    func execute(email: String, password: String) async -> LoginOutcome
}
```

The fake records calls and returns a configured outcome:

```swift
final class FakeLoginUseCase: LoginUseCase, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [(email: String, password: String)] = []
    var calls: [(email: String, password: String)] {
        lock.withLock { _calls }
    }

    var nextOutcome: LoginOutcome = .networkFailure

    func execute(email: String, password: String) async -> LoginOutcome {
        lock.withLock { _calls.append((email, password)) }
        return nextOutcome
    }
}
```

Tests inspect `fake.calls` after the act. There is no "verify
this was called once with these arguments" expectation API --
the assertion is just standard `#expect(...)` against the
recorded data.

## XCUITest -- accessibility identifiers

In the production view:

```swift
TextField("Email", text: $email)
    .accessibilityIdentifier("login.email")
SecureField("Password", text: $password)
    .accessibilityIdentifier("login.password")
Button("Sign in") { onSubmit() }
    .accessibilityIdentifier("login.submit")
```

In the UI test:

```swift
final class LoginUITests: XCTestCase {
    func testHappyPath() {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestMode", "1"]
        app.launch()

        app.textFields["login.email"].tap()
        app.textFields["login.email"].typeText("a@b.c")
        app.secureTextFields["login.password"].tap()
        app.secureTextFields["login.password"].typeText("hunter2_strong")
        app.buttons["login.submit"].tap()

        XCTAssertTrue(
            app.staticTexts["home.title"].waitForExistence(timeout: 5)
        )
    }
}
```

The `-uiTestMode 1` argument tells the app to swap real
services for fakes / in-memory stores. This is what makes UI
tests deterministic.

## Maestro flow

`.maestro/login_smoke.yaml`:

```yaml
appId: com.example.app
---
- launchApp:
    clearState: true
    arguments:
      - -uiTestMode
      - "1"
- tapOn:
    id: "login.email"
- inputText: "a@b.c"
- tapOn:
    id: "login.password"
- inputText: "hunter2_strong"
- tapOn:
    id: "login.submit"
- assertVisible:
    id: "home.title"
```

The flow runs on simulator (`maestro test login_smoke.yaml`) or
on a real device. The same YAML is what an agent drives during
a QA charter -- the smoke flow IS the agent's regression suite.

## Clock injection

Production code that needs time:

```swift
protocol Clock: Sendable {
    var now: Date { get }
    func sleep(for duration: Duration) async throws
}

struct SystemClock: Clock {
    var now: Date { Date() }
    func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: duration)
    }
}
```

A retry-with-backoff that takes a clock:

```swift
struct RetryingClient {
    let api: APIClient
    let clock: Clock

    func fetchWithBackoff() async throws -> Data {
        for delay in [Duration.milliseconds(100), .milliseconds(400), .seconds(1)] {
            do { return try await api.fetch() }
            catch { try await clock.sleep(for: delay) }
        }
        return try await api.fetch()
    }
}
```

The test injects a `TestClock` that resolves sleeps immediately:

```swift
final class TestClock: Clock, @unchecked Sendable {
    var now: Date = Date(timeIntervalSince1970: 0)
    var sleeps: [Duration] = []
    func sleep(for duration: Duration) async throws {
        sleeps.append(duration)
        now = now.addingTimeInterval(TimeInterval(duration.components.seconds))
    }
}

@Test func backoffSleepsTheExpectedAmounts() async throws {
    let fakeAPI = FakeAPIClient()
    fakeAPI.failuresBeforeSuccess = 2
    let clock = TestClock()
    let client = RetryingClient(api: fakeAPI, clock: clock)

    _ = try await client.fetchWithBackoff()

    #expect(clock.sleeps == [.milliseconds(100), .milliseconds(400)])
}
```

The test runs in milliseconds even though production code would
sleep for over a second. That is the entire point of clock
injection: deterministic tests at full speed.

## Swift Testing (iOS 17+ / Xcode 16+)

```swift
import Testing
@testable import App

struct CounterViewModelTests {
    @Test func increments_state_on_increment() async {
        let vm = await CounterViewModel(repository: FakeCounterRepository(initial: 0))
        await vm.increment()
        #expect(vm.count == 1)
    }

    @Test("state goes to error when repository throws")
    func load_error() async {
        let vm = await CounterViewModel(repository: FakeCounterRepository(error: TestError.boom))
        await vm.load()
        if case .error = vm.state {} else {
            Issue.record("expected error state, got \(vm.state)")
        }
    }
}
```

`@Test` replaces XCTestCase subclassing; `#expect` is the failure-recording assertion (non-fatal); `#require` is fatal-on-failure (use for preconditions that prevent further assertions). Parameterized tests via `@Test(arguments:)`.

## Clock injection

```swift
protocol Clock: Sendable {
    func now() -> Date
    func sleep(for duration: Duration) async throws
}

struct SystemClock: Clock {
    func now() -> Date { Date() }
    func sleep(for duration: Duration) async throws { try await Task.sleep(for: duration) }
}

actor TestClock: Clock {
    private var current: Date
    init(now: Date = Date()) { self.current = now }
    func now() -> Date { current }
    func sleep(for duration: Duration) async throws {
        current = current.addingTimeInterval(TimeInterval(duration.components.seconds))
    }
}
```

ViewModel takes `clock: Clock`; production injects `SystemClock()`, tests inject `TestClock`. Time-dependent logic (debouncing, timeouts, scheduling) becomes deterministic.
