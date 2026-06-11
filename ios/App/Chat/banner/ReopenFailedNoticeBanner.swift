// ---------------------------------------------------------------------------
// ReopenFailedNoticeBanner — the transient one-shot notice shown above the
// composer when a reconnect re-establish was rejected by the gateway
// (`sessions.error code=forbidden`). Spec §14: "Couldn't reopen that chat —
// started a new one."
//
// The SDK already cleared the anchor; the next send mints a fresh chat.
// This view is purely informational — it carries no recovery action, only
// a tap-to-dismiss close button. It is also auto-dismissed after ~4 s by
// the ChatViewModel so the user does not have to act.
//
// Stateless leaf: the host (ChatView) derives the notice text from
// ChatUiState.reopenFailedNotice and injects the dismiss closure.
//
// accessibilityIdentifiers: banner-reopen-failed (container),
//                           banner-reopen-failed-dismiss (close button).
// ---------------------------------------------------------------------------
import SwiftUI

/// The one-shot ReopenFailed notice bar. Stateless: text + dismiss are injected.
struct ReopenFailedNoticeBanner: View {
    /// The notice copy to display (from ChatUiState.reopenFailedNotice).
    let noticeText: String
    /// Tap-to-dismiss; the VM also auto-dismisses after ~4 s.
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            Text(noticeText)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: TypeScale.xs, weight: .semibold))
                    .foregroundStyle(DuskColors.ink3)
                    .frame(width: ReopenFailedStyle.dismissHit, height: ReopenFailedStyle.dismissHit)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("banner-reopen-failed-dismiss")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.xs)
        .background {
            ZStack {
                Rectangle().fill(DuskColors.bgElev)
                Rectangle().fill(DuskColors.line.opacity(ReopenFailedStyle.bgTint))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("banner-reopen-failed")
    }
}

private enum ReopenFailedStyle {
    /// Subtle tint over the elevated surface.
    static let bgTint: Double = 0.35
    /// Dismiss button frame side (enlarged tap area).
    static let dismissHit: CGFloat = 28
}

#Preview("Reopen failed notice") {
    ZStack {
        DuskColors.bg.ignoresSafeArea()
        VStack {
            Spacer()
            ReopenFailedNoticeBanner(
                noticeText: "Couldn't reopen that chat — started a new one.",
                onDismiss: {}
            )
        }
    }
    .preferredColorScheme(.dark)
}
