// ---------------------------------------------------------------------------
// GatewayConfig — the BUILD-TIME default only. Debug reads GatewayWSURL from the
// bundle (set via Local.xcconfig → Info.plist); absent → localhost fallback.
// Release bakes nothing ("") → the resolver forces the in-app setup page. The
// runtime override (BackendConfigStore) takes precedence over this. No private
// host is hardcoded here.
// ---------------------------------------------------------------------------
import Foundation

enum GatewayConfig {
    /// Build-time default WS URL, or "" when none (release first-launch).
    static let buildTimeDefaultWsURL: String = {
        let fromBundle = (Bundle.main.object(forInfoDictionaryKey: "GatewayWSURL") as? String) ?? ""
        if !fromBundle.isEmpty { return fromBundle }
        #if DEBUG
        // See BackendSetupViewModel — inbound-proxy owns 443, the gateway is
        // loopback-only behind it.
        return "wss://localhost/api/v1/ws"
        #else
        return ""
        #endif
    }()

    /// The build-time-default trust posture: debug trusts the local dev cert.
    static let buildTimeAllowSelfSigned: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()
}
