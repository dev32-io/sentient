// ---------------------------------------------------------------------------
// ConnectionBanner — canonical connection notice in the reserved shell region.
// Transport state and retry authority remain shared SDK-owned.
//
// Two states, discriminated by STATUS (NOT by connectionLost alone). In the
// mobile-sdk, `connectionLost` is true from the unexpected drop through the
// WHOLE backoff recovery AND at exhaustion — it is cleared only when status
// reaches READY (see SentientSdk.onConnectionDrop / onReconnectExhausted /
// setStatus). So `connectionLost` only gates WHETHER a banner shows; the
// STATUS decides WHICH one:
//   - .reconnecting — SDK is mid-backoff: status is reconnecting/connecting/
//                    authenticating (the loop cycles through these while
//                    connectionLost stays true). A subtle "Reconnecting…"
//                    indicator with a spinner; NO CTA (the SDK is already
//                    retrying). Distinct affordance, never tap-to-retry.
//   - .lost        — recovery is OVER and unhealthy: status is disconnected
//                    (reconnect exhausted) or error (terminal auth failure /
//                    session-ready timeout). Renders "Connection lost." + a
//                    "Tap to reconnect" CTA that calls forceReconnect().
//                    Mirrors webui's manual-tap banner.
//
// Stateless leaf: the host (ChatView) derives the case via
// `ConnectionBannerState.derive(status:connectionLost:)` and passes
// `onReconnect`. No ViewModel reference, no SdkState import beyond the bridged
// `SdkStatus` enum — state hoisting per the swiftui rule. nil case ⇒ the host
// renders nothing.
//
// accessibilityIdentifiers: connection-lost-banner, connection-reconnect,
// connection-reconnecting (host routing + smoke asserts).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

/// Which connection affordance to show, or none. Derived from the SDK's single
/// state surface (`status` + `connectionLost`) via ``derive(status:connectionLost:)``.
enum ConnectionBannerState: Equatable {
    /// Recovery is over and unhealthy — status disconnected (reconnect
    /// exhausted) or error (terminal). Needs a manual "Tap to reconnect".
    case lost
    /// SDK is mid-backoff — status reconnecting/connecting/authenticating while
    /// `connectionLost` stays true. Shows "Reconnecting…"; no CTA.
    case reconnecting

    /// Pure FSM mapping from the single SDK state surface to a banner case.
    ///
    /// `connectionLost` is true from an unexpected drop through the entire
    /// recovery AND at exhaustion (cleared only on READY), so it cannot
    /// distinguish "looping" from "exhausted" on its own — STATUS does that:
    ///   - not (`connectionLost` or status `.error`) → nil
    ///     (healthy, or a normal FIRST connect where `connectionLost` is false).
    ///   - status `.reconnecting` / `.connecting` / `.authenticating` → `.reconnecting`.
    ///   - status `.disconnected` / `.error` → `.lost`.
    ///   - status `.ready` → nil.
    static func derive(status: SdkStatus, connectionLost: Bool) -> ConnectionBannerState? {
        guard connectionLost || status == .error else { return nil }
        switch status {
        case .reconnecting, .connecting, .authenticating: return .reconnecting
        case .disconnected, .error: return .lost
        case .ready: return nil
        }
    }
}

/// Stateless canonical notice; case and reconnect intent are injected.
struct ConnectionBanner: View {
    let state: ConnectionBannerState
    /// Called by the .lost CTA. No-op-friendly for the .reconnecting case (unused).
    let onReconnect: () -> Void

    private static let lostText = "Connection lost."
    private static let reconnectCta = "Tap to reconnect"
    private static let reconnectingText = "Reconnecting…"

    var body: some View {
        switch state {
        case .lost: lostBanner
        case .reconnecting: reconnectingBanner
        }
    }

    private var lostBanner: some View {
        AsyncNotice(kind: .error, title: Self.lostText, retry: onReconnect,
                    accessibilityId: "connection-lost-banner", actionTitle: Self.reconnectCta,
                    actionAccessibilityId: "connection-reconnect")
    }

    private var reconnectingBanner: some View {
        AsyncNotice(kind: .loading, title: Self.reconnectingText,
                    accessibilityId: "connection-reconnecting")
    }
}

#Preview("Connection lost") {
    ZStack(alignment: .top) {
        DuskColors.bg.ignoresSafeArea()
        ConnectionBanner(state: .lost, onReconnect: {})
            .padding(.top, Space.lg)
    }
}

#Preview("Reconnecting") {
    ZStack(alignment: .top) {
        DuskColors.bg.ignoresSafeArea()
        ConnectionBanner(state: .reconnecting, onReconnect: {})
            .padding(.top, Space.lg)
    }
}
