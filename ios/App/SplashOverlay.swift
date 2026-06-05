// ---------------------------------------------------------------------------
// SplashOverlay — full-screen animated speaking splash shown on launch and on
// every backend reconfigure. Covers all three RootView gate states (setup /
// chat / login) with a minimum visible duration of SplashLayout.minDisplay.
//
// Re-show is driven by SdkStore.configGeneration: RootView's .task(id:) resets
// showSplash = true on each bump, enforces the min-duration floor, then fades out.
// ---------------------------------------------------------------------------
import SwiftUI

struct SplashOverlay: View {
    var body: some View {
        ZStack {
            DuskColors.bg.ignoresSafeArea()
            VStack(spacing: Space.lg) {
                SentientMark(size: SplashLayout.markSize, mode: .speaking)
                    .overlay(AvatarRipple(active: true))
                Text("Sentient")
                    .font(Typo.display(TypeScale.display, .semibold))
                    .foregroundStyle(DuskColors.ink)
            }
        }
        .accessibilityIdentifier("splash")
    }
}

#Preview {
    SplashOverlay()
}
