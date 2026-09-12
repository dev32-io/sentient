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

func canResumeNotificationDestination(_ destination: NotificationDestination, sessionIds: [String]) -> Bool {
    sessionIds.contains(destination.sessionId)
}

enum NotificationSessionValidation: Equatable {
    case authorized
    case unavailable
    case retryableFailure
}

enum NotificationResumeState: Equatable {
    case idle
    case pending(NotificationDestination)
    case unavailable(NotificationDestination)
    case retryableFailure(NotificationDestination)

    var destination: NotificationDestination? {
        switch self {
        case .idle: nil
        case .pending(let destination), .unavailable(let destination), .retryableFailure(let destination): destination
        }
    }
}

/// Owns destination authorization work and fences its completion to the active
/// authenticated account. A destination is never activated merely because it
/// arrived in a trusted APNs envelope.
@MainActor
final class NotificationResumeController: ObservableObject {
    @Published private(set) var state: NotificationResumeState = .idle
    private var validationTask: Task<Void, Never>?
    private var accountFence: String?
    private var generation = 0

    func setAccountFence(_ fence: String?) {
        guard accountFence != fence else { return }
        generation += 1
        validationTask?.cancel()
        validationTask = nil
        accountFence = fence
        state = .idle
    }

    func resume(
        _ destination: NotificationDestination,
        accountFence: String,
        validate: @escaping @MainActor (String) async -> NotificationSessionValidation,
        activate: @escaping @MainActor (String) -> Void
    ) {
        setAccountFence(accountFence)
        generation += 1
        let operation = generation
        validationTask?.cancel()
        state = .pending(destination)
        validationTask = Task { [weak self] in
            let result = await validate(destination.sessionId)
            guard !Task.isCancelled, let self,
                  self.generation == operation, self.accountFence == accountFence else { return }
            self.validationTask = nil
            switch result {
            case .authorized:
                self.state = .idle
                activate(destination.sessionId)
            case .unavailable:
                self.state = .unavailable(destination)
            case .retryableFailure:
                self.state = .retryableFailure(destination)
            }
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

    func receive(_ destination: NotificationDestination) { self.destination = destination }
    func take() -> NotificationDestination? {
        defer { destination = nil }
        return destination
    }

    func clear() { destination = nil }
}
