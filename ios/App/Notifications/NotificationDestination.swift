import Foundation

/// The only notification/deep-link destination accepted by the native app.
/// Gateway locations and arbitrary URLs are deliberately not represented.
struct NotificationDestination: Equatable, Sendable {
    let sessionId: String

    init?(sessionId: String) {
        let value = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 200,
              value.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_" )).contains($0) })
        else { return nil }
        self.sessionId = value
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == "sentient", url.host?.lowercased() == "session" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 1, url.query == nil, url.fragment == nil,
              let decoded = parts[0].removingPercentEncoding,
              decoded.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) == parts[0]
        else { return nil }
        self.init(sessionId: decoded)
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let value = userInfo["sessionId"] as? String else { return nil }
        self.init(sessionId: value)
    }
}

enum NotificationSessionValidation: Equatable {
    case authorized
    case unavailable
    case retryableFailure
}

enum NotificationResumeState: Equatable {
    case idle
    case pending(NotificationDestination)
    case clearing(NotificationDestination)
    case unavailable(NotificationDestination)
    case retryableFailure(NotificationDestination)
    case clearFailure(NotificationDestination)

    var destination: NotificationDestination? {
        switch self {
        case .idle: nil
        case .pending(let destination), .clearing(let destination), .unavailable(let destination),
             .retryableFailure(let destination), .clearFailure(let destination): destination
        }
    }

    var isBusy: Bool {
        switch self {
        case .pending, .clearing: true
        case .idle, .unavailable, .retryableFailure, .clearFailure: false
        }
    }
}

/// Owns acknowledged activation work and fences completion to active account.
/// A destination is never routed merely because it arrived in trusted APNs data.
@MainActor
final class NotificationResumeController: ObservableObject {
    @Published private(set) var state: NotificationResumeState = .idle
    private var activationTask: Task<Void, Never>?
    private var accountFence: String?
    private var generation = 0

    func setAccountFence(_ fence: String?) {
        guard accountFence != fence else { return }
        generation += 1
        activationTask?.cancel()
        activationTask = nil
        accountFence = fence
        state = .idle
    }

    func resume(
        _ destination: NotificationDestination,
        accountFence: String,
        activate: @escaping @MainActor (String) async -> NotificationSessionValidation,
        route: @escaping @MainActor (String) -> Void,
        clear: @escaping @MainActor (String) async -> Bool = { _ in true }
    ) {
        setAccountFence(accountFence)
        generation += 1
        let operation = generation
        activationTask?.cancel()
        state = .pending(destination)
        activationTask = Task { [weak self] in
            let result = await activate(destination.sessionId)
            guard !Task.isCancelled, let self,
                  self.generation == operation, self.accountFence == accountFence else { return }
            switch result {
            case .authorized:
                self.state = .clearing(destination)
                route(destination.sessionId)
                let cleared = await clear(destination.sessionId)
                guard !Task.isCancelled, self.generation == operation, self.accountFence == accountFence else { return }
                self.activationTask = nil
                self.state = cleared ? .idle : .clearFailure(destination)
            case .unavailable:
                self.activationTask = nil
                self.state = .unavailable(destination)
            case .retryableFailure:
                self.activationTask = nil
                self.state = .retryableFailure(destination)
            }
        }
    }

    func retryClear(
        _ destination: NotificationDestination,
        accountFence: String,
        clear: @escaping @MainActor (String) async -> Bool
    ) {
        setAccountFence(accountFence)
        generation += 1
        let operation = generation
        activationTask?.cancel()
        state = .clearing(destination)
        activationTask = Task { [weak self] in
            let cleared = await clear(destination.sessionId)
            guard !Task.isCancelled, let self,
                  self.generation == operation, self.accountFence == accountFence else { return }
            self.activationTask = nil
            self.state = cleared ? .idle : .clearFailure(destination)
        }
    }

    func dismiss() { state = .idle }
    func cancel() { setAccountFence(nil) }
}

/// Keeps one supported destination across cold launch and login. A newer user
/// action replaces the older pending intent; authorization is still checked by
/// the existing session-resume path after authentication.
@MainActor
final class PendingNotificationNavigation: ObservableObject {
    @Published private(set) var destination: NotificationDestination?
    private var requiredAccountFence: String?

    func receive(_ destination: NotificationDestination, requiredAccountFence: String? = nil) {
        self.requiredAccountFence = requiredAccountFence
        self.destination = destination
    }

    func bindPending(to accountFence: String) {
        guard destination != nil else { return }
        requiredAccountFence = accountFence
    }

    /// Keeps newer app-scoped intent when one arrived while expiry was starting.
    func preserve(_ fallback: NotificationDestination?, for accountFence: String) {
        if destination != nil {
            requiredAccountFence = accountFence
        } else if let fallback {
            receive(fallback, requiredAccountFence: accountFence)
        }
    }

    func take(accountFence: String? = nil) -> NotificationDestination? {
        defer { clear() }
        guard requiredAccountFence == nil || requiredAccountFence == accountFence else { return nil }
        return destination
    }

    func clear() {
        requiredAccountFence = nil
        destination = nil
    }
}
