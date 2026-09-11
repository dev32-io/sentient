import Foundation
import Testing
import MobileData
@testable import SentientApp

@MainActor
struct AuthViewModelTimingTests {
    @Test func fastSuccessCommitsOnlyAfterCheckingAndAcceptedFeedback() async throws {
        let f = Fixture()
        defer { f.cleanUp() }
        f.submit()
        try await eventually { f.auth.logins.count == 1 }
        f.time.advance(.milliseconds(100))
        f.auth.finishLogin(f.success)
        try await eventually { f.time.pending != nil }
        #expect(f.time.durations == [.milliseconds(600)])
        f.expectUncommitted()
        #expect(f.model.isSubmitting)
        #expect(f.model.pinSuccess == nil)

        f.time.release()
        try await eventually { f.time.durations.count == 2 }
        #expect(f.time.durations == [.milliseconds(600), .milliseconds(250)])
        #expect(f.model.pinSuccess != nil)
        #expect(f.model.isSubmitting)
        f.expectUncommitted()
        f.time.release()
        try await eventually { f.connections == 1 }
        #expect(f.tokens.saved == ["test-token"])
        #expect(f.names.load() == "Server name")
        #expect(f.identities == ["server-id"])
        #expect(!f.model.isSubmitting)
        // Commit goes straight to the auth callback: no third success/welcome hold.
        #expect(f.time.pending == nil)
        #expect(f.time.durations.count == 2)
    }

    @Test func slowSuccessDoesNotRepeatCheckingDelay() async throws {
        let f = Fixture()
        defer { f.cleanUp() }
        f.submit()
        try await eventually { f.auth.logins.count == 1 }
        f.time.advance(.seconds(2))
        f.auth.finishLogin(f.success)
        try await eventually { f.time.pending != nil }
        #expect(f.time.durations == [.milliseconds(250)])
        #expect(f.model.pinSuccess != nil)
        f.expectUncommitted()
        f.time.release()
        try await eventually { f.connections == 1 }
        #expect(f.time.durations.count == 1)
    }

    @Test func invalidPinRecoversOnceAfterMinimumAndAllowsRetry() async throws {
        let f = Fixture()
        defer { f.cleanUp() }
        f.submit()
        try await eventually { f.auth.logins.count == 1 }
        // Kotlin's covariant Failure<Nothing> is erased at the ObjC boundary.
        let failure = AuthResultFailure(error: AuthError.InvalidCredentials.shared)
        f.auth.finishLogin((failure as AnyObject) as! AuthResult<AuthResponse>)
        try await eventually { f.time.pending != nil }
        #expect(f.time.durations == [.milliseconds(700)])
        #expect(f.model.error == nil)
        #expect(f.model.pinFeedbackRevision == 0)
        #expect(f.model.isSubmitting)
        f.time.release()
        try await eventually { !f.model.isSubmitting }
        #expect(f.model.error != nil)
        #expect(f.model.pin.isEmpty)
        #expect(f.model.pinSuccess == nil)
        #expect(f.model.pinFeedbackRevision == 1)
        #expect(f.time.durations.count == 1)
        f.expectUncommitted()
        f.submit()
        try await eventually { f.auth.logins.count == 2 }
        #expect(f.model.error == nil)
        #expect(f.model.pinFeedbackRevision == 1)
        f.model.cancel()
        f.time.advance(.seconds(1))
        f.auth.finishLogin(f.success)
        await drain()
    }

    enum Exit: CaseIterable { case cancel, back, reselect }

    @Test(arguments: Exit.allCases, [false, true])
    func abandonedAttemptCannotCommit(exit: Exit, acceptedPending: Bool) async throws {
        let f = Fixture()
        defer { f.cleanUp() }
        f.submit()
        try await eventually { f.auth.logins.count == 1 }
        f.time.advance(.seconds(1))
        if acceptedPending {
            f.auth.finishLogin(f.success)
            try await eventually { f.time.pending != nil }
            #expect(f.model.pinSuccess != nil)
        }
        switch exit {
        case .cancel: f.model.cancel()
        case .back: f.model.back()
        case .reselect: f.model.select(f.other)
        }
        let selected = f.model.selectedUser?.userId
        let feedback = f.model.pinSuccess
        if acceptedPending { f.time.release() } else { f.auth.finishLogin(f.success) }
        // Both fakes deliberately ignore task cancellation and return normally.
        await drain()
        f.expectUncommitted()
        #expect(f.model.selectedUser?.userId == selected)
        #expect(f.model.pinSuccess == feedback)
        #expect(!f.model.isSubmitting)
        #expect(f.model.pin.isEmpty)
        #expect(f.model.error == nil)
        #expect(f.model.pinFeedbackRevision == 0)
        #expect(f.time.pending == nil)
    }

    @Test func cancelledListCannotPublishOrResolveInitialUsers() async throws {
        let f = Fixture()
        defer { f.cleanUp() }
        let request = Task { await f.model.loadUsers() }
        try await eventually { f.auth.lists.count == 1 }
        f.model.cancel()
        f.model.select(f.other)
        f.auth.lists[0].resume(returning: AuthResultSuccess(value: [f.user] as NSArray))
        await request.value
        #expect(f.model.users.isEmpty)
        #expect(f.model.selectedUser?.userId == f.other.userId)
        #expect(f.model.error == nil)
        #expect(f.initialResolutions == 0)
    }

    @Test func lateListCannotOverwriteNewScopeOrResolveInitialUsersTwice() async throws {
        let f = Fixture()
        defer { f.cleanUp() }
        let old = Task { await f.model.loadUsers() }
        try await eventually { f.auth.lists.count == 1 }
        f.model.cancel()
        let current = Task { await f.model.loadUsers() }
        try await eventually { f.auth.lists.count == 2 }
        f.auth.lists[1].resume(returning: AuthResultSuccess(value: [f.other] as NSArray))
        await current.value
        f.model.select(f.other)
        f.auth.lists[0].resume(returning: AuthResultSuccess(value: [f.user] as NSArray))
        await old.value
        #expect(f.model.users.map(\.userId) == [f.other.userId])
        #expect(f.model.selectedUser?.userId == f.other.userId)
        #expect(!f.model.isLoadingUsers)
        #expect(f.model.error == nil)
        #expect(f.initialResolutions == 1)
    }
}

@MainActor
private final class Fixture {
    let auth = ControlledAuth()
    let time = ControlledTime()
    let tokens = MemoryTokens()
    let suite = "AuthViewModelTimingTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    let names: DisplayNameStore
    let user = AuthUserLite(userId: "picker-id", displayName: "Picker name", avatarTint: "blue")
    let other = AuthUserLite(userId: "other-id", displayName: "Other", avatarTint: "green")
    var identities: [String] = []
    var connections = 0
    var initialResolutions = 0
    lazy var model = AuthViewModel(
        connect: { [unowned self] in
            #expect(tokens.saved == ["test-token"])
            #expect(names.load() == "Server name")
            #expect(identities == ["server-id"])
            connections += 1
        },
        onAuthenticatedUser: { [unowned self] in identities.append($0) },
        onInitialUsersResolved: { [unowned self] in initialResolutions += 1 },
        authClient: auth, tokenStore: tokens, displayNameStore: names,
        sleep: { [unowned self] in await time.sleep($0) },
        now: { [unowned self] in time.instant }
    )
    var success: AuthResult<AuthResponse> {
        AuthResultSuccess(value: AuthResponse(token: "test-token", user: AuthUser(
            userId: "server-id", displayName: "Server name", role: "adult", isAdmin: false, avatarTint: "blue"
        )))
    }
    init() {
        defaults = UserDefaults(suiteName: suite)!
        names = DisplayNameStore(defaults: defaults)
    }
    func submit() {
        if model.selectedUser == nil { model.select(user) }
        for digit in "1234" { model.appendDigit(digit) }
    }
    func expectUncommitted() {
        #expect(tokens.saved.isEmpty)
        #expect(names.load() == nil)
        #expect(identities.isEmpty)
        #expect(connections == 0)
    }
    func cleanUp() {
        model.cancel()
        defaults.removePersistentDomain(forName: suite)
    }
}

@MainActor
private final class ControlledAuth: LoginAuthenticating {
    var logins: [CheckedContinuation<AuthResult<AuthResponse>, Never>] = []
    var lists: [CheckedContinuation<AuthResult<NSArray>, Never>] = []
    func login(userId: String, pin: String) async throws -> AuthResult<AuthResponse> {
        await withCheckedContinuation { logins.append($0) }
    }
    func listUsers() async throws -> AuthResult<NSArray> {
        await withCheckedContinuation { lists.append($0) }
    }
    func finishLogin(_ result: AuthResult<AuthResponse>) { logins.last!.resume(returning: result) }
}

@MainActor
private final class ControlledTime {
    var instant = ContinuousClock().now
    var durations: [Duration] = []
    var pending: CheckedContinuation<Void, Never>?
    func advance(_ duration: Duration) { instant = instant.advanced(by: duration) }
    func sleep(_ duration: Duration) async {
        durations.append(duration)
        await withCheckedContinuation { pending = $0 }
    }
    func release() {
        advance(durations.last!)
        let continuation = pending
        pending = nil
        continuation?.resume()
    }
}

private final class MemoryTokens: NSObject, SecureTokenStore {
    var saved: [String] = []
    func save(token: String) { saved.append(token) }
    func load() -> String? { saved.last }
    func clear() { saved.removeAll() }
}

@MainActor
private func eventually(_ condition: () -> Bool) async throws {
    for _ in 0..<1_000 {
        if condition() { return }
        await Task.yield()
    }
    try #require(condition(), "Expected observable state transition")
}

@MainActor
private func drain() async {
    for _ in 0..<100 { await Task.yield() }
}
