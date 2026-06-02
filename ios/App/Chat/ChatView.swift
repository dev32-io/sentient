// ---------------------------------------------------------------------------
// ChatView — placeholder chat screen for D-I2.
//
// D-I3 builds the real conversation UI. For D-I2 this is the post-login landing
// surface: it carries the `chat-screen` accessibilityIdentifier (mirroring the
// Android testTag) so the e2e driver asserts a successful login reached chat,
// shows the live SDK status, and offers a Disconnect that returns to login
// (event-driven off the SDK status in RootView).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct ChatView: View {
    @EnvironmentObject private var store: SdkStore

    var body: some View {
        VStack(spacing: Space.lg) {
            Text("Sentient")
                .font(.system(size: TypeScale.xl, weight: .semibold))
                .foregroundStyle(DuskColors.ink)

            Text("Connected")
                .font(.system(size: TypeScale.base, weight: .medium))
                .foregroundStyle(DuskColors.bgSunk)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(DuskColors.ok, in: Capsule())

            Text("\(store.state.messages.count) messages")
                .font(.system(size: TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .accessibilityIdentifier("message-count")

            Button(action: { store.disconnect() }) {
                Text("Disconnect")
                    .font(.system(size: TypeScale.base, weight: .semibold))
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.sm)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("disconnect")
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
        .accessibilityIdentifier("chat-screen")
    }
}
