// ---------------------------------------------------------------------------
// UpdateGate — the authed-scoped OTA host. Swift mirror of Android's
// AppNavHost.UpdateOverlay (the overlay mounted only while authed).
//
// RootView renders this for the authed branch (in place of UserSessionHost
// directly). It owns the ONE shared UpdateModel (@StateObject), built with the
// resolved gateway URL, and wires it to the three consumers:
//   - force gate: status Available && mandatory → an OPAQUE full-screen
//     ForceUpdateView overlay AHEAD of the chat content (non-bypassable).
//   - optional banner: Available && !mandatory → a dismissible top overlay.
//   - Settings row: the model is threaded into UserSessionHost → SettingsSheet.
//
// COLD-START gate (lesson from the Android B5 task): the gate MUST be effective at
// launch, not only on a later foreground. The manifest check is a cheap
// UNAUTHENTICATED HTTP GET, independent of the WS connect path, so the
// double-CONNECT "cold-start-skip" guidance does NOT apply here. A one-shot
// `.task { check() }` on first appearance blocks a below-min build before chat is
// usable. SUBSEQUENT foregrounds are re-checked inside UserSessionHost, riding the
// same scenePhase resume signal (which keeps the cold-start-skip) — mirroring
// Android's presence-relay onForegroundExtra. So SentientApp needs no change.
//
// Auth-scoped: this view exists only while RootView is on the hasToken branch, so
// a logout/reconfigure tears it down (and rebuilds it fresh with the new host) —
// the gate keys on AUTH, never transport, so a WS drop never bounces to login.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

/// Which OTA affordance to show, or none. Derived from the model's UpdateStatus
/// into an Equatable value so SwiftUI can animate the transition (the bridged
/// KMP `UpdateStatusAvailable` is not Swift-Equatable).
enum UpdateGateState: Equatable {
    case clear
    case banner(String)
    case forced(String)
}

func updateGateState(version: String?, mandatory: Bool, bannerDismissed: Bool) -> UpdateGateState {
    guard let version else { return .clear }
    if mandatory { return .forced(version) }
    return bannerDismissed ? .clear : .banner(version)
}

struct UpdateGate: View {
    private let appConfig: AppConfig
    @StateObject private var model: UpdateModel
    @State private var bannerDismissed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let log = AppLog("update", "gate")

    init(appConfig: AppConfig) {
        self.appConfig = appConfig
        _model = StateObject(wrappedValue: UpdateModel(
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost
        ))
    }

    /// Map the live status to the affordance to render. Banner is suppressed once
    /// dismissed; the force gate can never be dismissed.
    var gateState: UpdateGateState {
        guard let available = model.status as? UpdateStatusAvailable else {
            return updateGateState(version: nil, mandatory: false, bannerDismissed: bannerDismissed)
        }
        return updateGateState(
            version: available.versionName,
            mandatory: available.mandatory,
            bannerDismissed: bannerDismissed
        )
    }

    var body: some View {
        UserSessionHost(appConfig: appConfig, updateModel: model)
            // Optional banner: pinned top, dismissible. Mutually exclusive with the
            // force gate (mandatory vs !mandatory), so only one ever shows.
            .overlay(alignment: .top) {
                if case let .banner(version) = gateState {
                    UpdateBanner(
                        versionName: version,
                        onUpdate: { model.install() },
                        onDismiss: { bannerDismissed = true }
                    )
                    .padding(.top, Space.sm)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            // Force gate: opaque full-screen, AHEAD of chat, non-bypassable.
            .overlay {
                if case let .forced(version) = gateState {
                    ForceUpdateView(versionName: version, onInstall: { model.install() })
                        .transition(.opacity)
                }
            }
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: gateState)
            // COLD-START one-shot: independent of the WS connect path, so it runs at
            // launch (no cold-start-skip) to block a below-min build immediately.
            .task {
                log.info("cold-start.check")
                await model.check()
            }
    }
}
