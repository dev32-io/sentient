// ---------------------------------------------------------------------------
// BackendConfig — user-entered backend descriptor + pure resolution to the SDK's
// two transport inputs. Native-owned (no KMP push). The /api/v1/ws path is the
// gateway contract; the security→allowSelfSigned mapping is a security boundary.
// Mirrors the Android BackendConfig (which is unit-tested); kept in sync.
// ---------------------------------------------------------------------------
import Foundation

/// Gateway WS path — the wire contract with the gateway. Not user-editable.
private let gatewayWSPath = "/api/v1/ws"

enum ConnectionSecurity: String, CaseIterable, Sendable {
    case tlsValid, tlsTrustSelfSigned, plainWs
}

struct BackendConfig: Equatable, Sendable {
    let host: String
    let port: Int
    let security: ConnectionSecurity

    var gatewayWsURL: String {
        let scheme = security == .plainWs ? "ws" : "wss"
        return "\(scheme)://\(host):\(port)\(gatewayWSPath)"
    }
    var allowSelfSigned: Bool { security == .tlsTrustSelfSigned }
}

enum ResolvedBackend: Equatable, Sendable {
    case configured(gatewayWsURL: String, allowSelfSignedDevHost: Bool)
    case unconfigured
}

/// Precedence: override → non-empty build-time default → unconfigured.
func resolveBackend(override: BackendConfig?, buildTimeDefaultURL: String, buildTimeAllowSelfSigned: Bool) -> ResolvedBackend {
    if let o = override { return .configured(gatewayWsURL: o.gatewayWsURL, allowSelfSignedDevHost: o.allowSelfSigned) }
    if !buildTimeDefaultURL.isEmpty { return .configured(gatewayWsURL: buildTimeDefaultURL, allowSelfSignedDevHost: buildTimeAllowSelfSigned) }
    return .unconfigured
}
