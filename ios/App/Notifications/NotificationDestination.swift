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
