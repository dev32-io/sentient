import Foundation

struct CubeRegistryRecord: Codable, Identifiable, Equatable {
    let version: Int
    let deviceId: String
    let attemptId: String
    let generation: Int
    let deviceClass: String
    let status: String
    let expiresAt: Double
    var managerSecret: String?
    var id: String { deviceId }

    func validate(deviceId expected: String? = nil) throws {
        guard version == 1, deviceClass == "cube", UUID(uuidString: deviceId) != nil,
              expected == nil || expected == deviceId, UUID(uuidString: attemptId) != nil,
              generation > 0, generation <= Int(UInt32.max),
              ["pending", "committed", "active", "disabled"].contains(status) else {
            throw CubeHardwareError.incompatible
        }
    }
}

struct CubeGateway: Equatable {
    let origin: URL
    let wsPath: String
    let registryURL: URL

    init(wsURL: String) throws {
        guard var parts = URLComponents(string: wsURL), parts.scheme == "wss",
              let host = parts.host, !host.isEmpty, !host.contains(":"),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.hasSuffix("/ws"), parts.percentEncodedPath.utf8.count <= 96 else {
            throw CubeHardwareError.incompatible
        }
        wsPath = parts.percentEncodedPath
        let base = String(parts.percentEncodedPath.dropLast(3))
        parts.scheme = "https"
        parts.path = ""
        guard let origin = parts.url, origin.absoluteString.utf8.count <= 192 else {
            throw CubeHardwareError.incompatible
        }
        self.origin = origin
        parts.percentEncodedPath = base + "/devices"
        guard let registry = parts.url else { throw CubeHardwareError.incompatible }
        registryURL = registry
    }
}

/// Feature-local native adapter; uses the app's current human bearer and configured WS base.
/// No redirects, cookie jar, response cache, body logging, or automatic mutation retries.
@MainActor
final class CubeRegistry {
    let gateway: CubeGateway
    private let token: () -> String?
    private let session: URLSession
    private var retryNotBefore = Date.distantPast

    init(gateway: CubeGateway, allowSelfSignedDevHost: Bool,
         configuration: URLSessionConfiguration = .ephemeral, token: @escaping () -> String?) {
        self.gateway = gateway
        self.token = token
        let config = configuration
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        config.urlCache = nil
        config.httpCookieStorage = nil
        session = URLSession(configuration: config, delegate: CubeHTTPDelegate(
            host: gateway.origin.host!, allowSelfSigned: allowSelfSignedDevHost), delegateQueue: nil)
    }

    func list() async throws -> [CubeRegistryRecord] {
        let records = try JSONDecoder().decode([CubeRegistryRecord].self, from: await request(nil, body: nil))
        try records.forEach { try $0.validate() }
        return records
    }

    func mutate(_ operation: String, deviceId: String, attempt: CubeSetupAttempt? = nil,
                managerSecret: String? = nil) async throws -> CubeRegistryRecord {
        var body: [String: Any] = ["version": 1, "deviceId": deviceId]
        if let attempt, let managerSecret {
            body["attemptId"] = attempt.attemptId
            body["enrollmentSecret"] = attempt.enrollmentSecret
            body["managerSecret"] = managerSecret
        }
        let record = try JSONDecoder().decode(CubeRegistryRecord.self, from: await request(operation, body: body))
        try record.validate(deviceId: deviceId)
        return record
    }

    private func request(_ operation: String?, body: [String: Any]?) async throws -> Data {
        try Task.checkCancellation()
        guard Date() >= retryNotBefore else { throw CubeHardwareError.registry(429) }
        guard let bearer = token(), !bearer.isEmpty else { throw CubeHardwareError.authentication }
        let url = operation.map { gateway.registryURL.appendingPathComponent($0) } ?? gateway.registryURL
        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw CubeHardwareError.unavailable }
        guard http.statusCode == 200 else {
            if http.statusCode == 429 {
                let seconds = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 1
                retryNotBefore = Date().addingTimeInterval(min(300, max(1, seconds)))
            }
            // Deliberately no body-derived diagnostics (escrow responses contain secrets).
            throw CubeHardwareError.registry(http.statusCode)
        }
        guard data.count <= 262_144 else { throw CubeHardwareError.incompatible }
        return data
    }

    deinit { session.invalidateAndCancel() }
}

private final class CubeHTTPDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let host: String
    let allowSelfSigned: Bool
    init(host: String, allowSelfSigned: Bool) { self.host = host; self.allowSelfSigned = allowSelfSigned }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
#if DEBUG
        // Same opt-in debug trust posture as existing app auth, additionally fenced to this origin.
        if allowSelfSigned, challenge.protectionSpace.host == host,
           challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust)); return
        }
#endif
        completionHandler(.performDefaultHandling, nil)
    }
}
