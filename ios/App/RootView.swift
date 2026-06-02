// ---------------------------------------------------------------------------
// RootView — the app root, proving the SKIE → SwiftUI state path.
//
// D-I1 scope: render the live SDK status inside the Dusk theme to prove the
// StateFlow<SdkState> flows from the KMP SDK into SwiftUI. Login (D-I2) and
// chat (D-I3) land later; this view intentionally shows only the status label,
// the message count, and a connect/disconnect control. It reads the injected
// SdkStore and dispatches commands — it owns no business logic (the SDK does).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct RootView: View {
    @EnvironmentObject private var store: SdkStore

    var body: some View {
        VStack(spacing: Space.lg) {
            Text("Sentient")
                .font(.system(size: TypeScale.xl, weight: .semibold))
                .foregroundStyle(DuskColors.ink)

            statusBadge

            Text("\(store.state.messages.count) messages")
                .font(.system(size: TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .accessibilityIdentifier("message-count")

            connectButton
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
    }

    /// The live SDK status, mapped from the SKIE-bridged `SdkStatus` enum.
    private var statusBadge: some View {
        Text(statusLabel)
            .font(.system(size: TypeScale.base, weight: .medium))
            .foregroundStyle(DuskColors.bgSunk)
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .background(statusColor, in: Capsule())
            .accessibilityIdentifier("sdk-status")
    }

    private var connectButton: some View {
        Button(action: toggleConnection) {
            Text(isConnected ? "Disconnect" : "Connect")
                .font(.system(size: TypeScale.base, weight: .semibold))
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("connect-toggle")
    }

    private var isConnected: Bool {
        store.state.status == .ready
            || store.state.status == .connecting
            || store.state.status == .authenticating
    }

    private func toggleConnection() {
        if isConnected { store.disconnect() } else { store.connect() }
    }

    private var statusLabel: String {
        switch store.state.status {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting"
        case .authenticating: return "Authenticating"
        case .ready: return "Ready"
        case .reconnecting: return "Reconnecting"
        case .error: return "Error"
        @unknown default: return store.state.status.name
        }
    }

    private var statusColor: Color {
        switch store.state.status {
        case .ready: return DuskColors.ok
        case .error: return DuskColors.stop
        case .reconnecting, .connecting, .authenticating: return DuskColors.warn
        case .disconnected: return DuskColors.ink3
        @unknown default: return DuskColors.ink3
        }
    }
}
