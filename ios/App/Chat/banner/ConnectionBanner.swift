// ---------------------------------------------------------------------------
// ConnectionBanner — the connection-state pill that floats over the chat
// surface, mirroring the webui ConnectionLostBanner (app.tsx) + .connection-
// lost-banner styling (styles/components.css).
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

/// A floating status pill. Stateless: the case + reconnect action are injected.
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

    // ── Connection lost (terminal) ──────────────────────────────────────────

    private var lostBanner: some View {
        HStack(spacing: Space.md) {
            Text(Self.lostText)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            Button(action: onReconnect) {
                Text(Self.reconnectCta)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.bg)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
                    .background(DuskColors.ink, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connection-reconnect")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .background {
            // Warm warn-tint pill: a translucent warn fill over the bg pill,
            // approximating webui color-mix(in oklab, warn 18%, bg).
            ZStack {
                Capsule().fill(DuskColors.bg)
                Capsule().fill(DuskColors.warn.opacity(BannerStyle.warnTint))
            }
        }
        .overlay(Capsule().stroke(DuskColors.line, lineWidth: 1))
        .shadow(color: .black.opacity(BannerStyle.shadowOpacity), radius: BannerStyle.shadowRadius, y: 6)
        // NOT .combine: the reconnect Button must stay independently addressable
        // (connection-reconnect) for taps + tests; .contain keeps the container
        // identified while preserving child elements.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connection-lost-banner")
    }

    // ── Reconnecting (mid-backoff) ──────────────────────────────────────────

    private var reconnectingBanner: some View {
        HStack(spacing: Space.sm) {
            ProgressView()
                .controlSize(.small)
                .tint(DuskColors.ink3)
            Text(Self.reconnectingText)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink2)
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .background(DuskColors.bgElev, in: Capsule())
        .overlay(Capsule().stroke(DuskColors.line, lineWidth: 1))
        .shadow(color: .black.opacity(BannerStyle.shadowOpacity), radius: BannerStyle.shadowRadius, y: 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("connection-reconnecting")
    }
}

private enum BannerStyle {
    /// Warn-color tint over the bg pill (webui uses color-mix warn 18%).
    static let warnTint: Double = 0.18
    static let shadowOpacity: Double = 0.35
    static let shadowRadius: CGFloat = 18
}

// ── Host modifier ───────────────────────────────────────────────────────────
//
// Composes the floating banner overlay + the authExpired→logout side effect so
// the host (ChatView) attaches one modifier instead of inlining both. The
// overlay is top-pinned (mirrors webui's fixed-top banner); the side effect
// lives in .onChange, never in body, per the swiftui rule.

private struct ConnectionStateModifier: ViewModifier {
    let banner: ConnectionBannerState?
    let onReconnect: () -> Void
    let authExpired: Bool
    let onAuthExpired: () -> Void

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let banner {
                    ConnectionBanner(state: banner, onReconnect: onReconnect)
                        .padding(.top, Space.sm)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: Motion.normal), value: banner)
            .onChange(of: authExpired) { _, expired in
                if expired { onAuthExpired() }
            }
    }
}

extension View {
    /// Attach the connection-state affordances (floating banner + auth-expired
    /// logout). `banner == nil` renders nothing; `authExpired` fires once on the
    /// false→true edge. web-sdk parity (app.tsx connectionLost + authExpired).
    func connectionState(
        banner: ConnectionBannerState?,
        onReconnect: @escaping () -> Void,
        authExpired: Bool,
        onAuthExpired: @escaping () -> Void
    ) -> some View {
        modifier(ConnectionStateModifier(
            banner: banner,
            onReconnect: onReconnect,
            authExpired: authExpired,
            onAuthExpired: onAuthExpired
        ))
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
