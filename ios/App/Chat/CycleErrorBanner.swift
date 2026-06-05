// ---------------------------------------------------------------------------
// CycleErrorBanner — the inline, dismissible recovery affordance shown above the
// composer when a chat cycle aborts UNSOLICITED (wire-death / server error mid-
// cycle, surfaced as `SdkState.lastCycleError == true`). Mirrors the web-sdk
// graceful-degradation intent: the user got silence, so offer a way forward.
//
// Two recovery actions:
//   - Retry        — re-send the last user message (derived from state.messages
//                    via `CycleErrorRecovery.lastUserText`). Hidden when there is
//                    no prior user turn to resend.
//   - Start a new chat — newChat().
//
// The SDK auto-clears `lastCycleError` on the next cycle.started / a successful
// cycle / newChat / switchSession, so the row disappears once recovery begins —
// this view never mutates SDK state. The host MAY locally dismiss it (hide until
// the NEXT error) via the "×" close button; that is UI-only state.
//
// Stateless leaf: the host (ChatView) derives `lastUserText`, passes the two
// actions + a dismiss closure. No ViewModel reference, no SdkState import beyond
// the bridged `ChatMessage` used by the pure derivation — state hoisting per the
// swiftui rule.
//
// accessibilityIdentifiers: cycle-error-banner (container), cycle-error-retry,
// cycle-error-newchat, cycle-error-dismiss.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

/// Pure derivation helpers for the cycle-error recovery affordance. Kept
/// separate from the view so the "last user message" logic is unit-testable the
/// same way `ConnectionBannerState.derive` is (ios-testing rule).
enum CycleErrorRecovery {
    /// The text of the most recent user turn in `messages`, or nil when there is
    /// no user entry to resend. Drives whether Retry is offered. Trailing/leading
    /// whitespace is trimmed; a blank-after-trim entry counts as "nothing to
    /// resend" (returns nil) so Retry never fires an empty send.
    static func lastUserText(in messages: [ChatMessage]) -> String? {
        for message in messages.reversed() where message.role == "user" {
            let trimmed = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return nil
    }
}

/// The inline recovery row. Stateless: the resend text + actions are injected.
struct CycleErrorBanner: View {
    /// Last user message to resend; nil ⇒ no Retry button (nothing to resend).
    let lastUserText: String?
    /// Re-send `lastUserText`. Only invoked when `lastUserText != nil`.
    let onRetry: () -> Void
    /// Start a fresh chat (newChat()).
    let onNewChat: () -> Void
    /// Local dismiss — hide until the next error. UI-only; does not touch the SDK.
    let onDismiss: () -> Void

    private static let title = "Couldn't get a response."
    private static let retryCta = "Retry"
    private static let newChatCta = "Start a new chat"

    private var canRetry: Bool { lastUserText != nil }

    var body: some View {
        HStack(alignment: .center, spacing: Space.md) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: TypeScale.sm))
                .foregroundStyle(DuskColors.warn)
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(Self.title)
                    .font(Typo.ui(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink)
                actions
            }
            Spacer(minLength: Space.sm)
            dismissButton
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .background {
            // Warm warn-tint surface, matching the connection-lost banner's
            // approximation of webui color-mix(in oklab, warn 18%, bg).
            ZStack {
                RoundedRectangle(cornerRadius: Radii.lg).fill(DuskColors.bgElev)
                RoundedRectangle(cornerRadius: Radii.lg)
                    .fill(DuskColors.warn.opacity(CycleErrorStyle.warnTint))
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: Radii.lg).stroke(DuskColors.line, lineWidth: 1)
        )
        .padding(.horizontal, Space.lg)
        .padding(.top, Space.sm)
        // .contain (not .combine): Retry / new-chat / dismiss must each stay
        // independently addressable for taps + tests.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cycle-error-banner")
    }

    // ── Action row ────────────────────────────────────────────────────────────

    private var actions: some View {
        HStack(spacing: Space.sm) {
            if canRetry {
                Button(action: onRetry) {
                    Text(Self.retryCta)
                        .font(Typo.ui(TypeScale.sm, .semibold))
                        .foregroundStyle(DuskColors.bg)
                        .padding(.horizontal, Space.sm)
                        .padding(.vertical, Space.xs)
                        .background(DuskColors.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("cycle-error-retry")
            }
            Button(action: onNewChat) {
                Text(Self.newChatCta)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.ink2)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
                    .overlay(Capsule().stroke(DuskColors.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("cycle-error-newchat")
        }
    }

    private var dismissButton: some View {
        Button(action: onDismiss) {
            Image(systemName: "xmark")
                .font(.system(size: TypeScale.xs, weight: .semibold))
                .foregroundStyle(DuskColors.ink3)
                .frame(width: CycleErrorStyle.dismissHit, height: CycleErrorStyle.dismissHit)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
        .accessibilityIdentifier("cycle-error-dismiss")
    }
}

private enum CycleErrorStyle {
    /// Warn-color tint over the elevated surface (webui color-mix warn 18%).
    static let warnTint: Double = 0.16
    /// Dismiss ("×") button frame side. The visible tap area is enlarged beyond
    /// the glyph by the button's surrounding padding.
    static let dismissHit: CGFloat = 28
}

// ── Host modifier ───────────────────────────────────────────────────────────
//
// Stacks the recovery row ABOVE the wrapped content (the composer), owns the
// UI-only local-dismiss state, and resets the dismiss on the false→true error
// edge so a FRESH cycle error re-shows the row even if a prior one was
// dismissed. The side effect lives in .onChange, never in body (swiftui rule).
// Mirrors ConnectionBanner's `connectionState` modifier pattern.

private struct CycleErrorRecoveryModifier: ViewModifier {
    let hasError: Bool
    let lastUserText: String?
    let onRetry: () -> Void
    let onNewChat: () -> Void

    @State private var dismissed = false

    private var shows: Bool { hasError && !dismissed }

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            if shows {
                CycleErrorBanner(
                    lastUserText: lastUserText,
                    onRetry: onRetry,
                    onNewChat: onNewChat,
                    onDismiss: { dismissed = true }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            content
        }
        .animation(.easeInOut(duration: Motion.normal), value: shows)
        .onChange(of: hasError) { _, nowError in
            if nowError { dismissed = false }
        }
    }
}

extension View {
    /// Attach the cycle-error recovery row above this view (the composer). Shows
    /// when `hasError`; offers Retry (resends `lastUserText`, omitted when nil) +
    /// Start-a-new-chat. Locally dismissible; re-shows on the next error edge.
    func cycleErrorRecovery(
        hasError: Bool,
        lastUserText: String?,
        onRetry: @escaping () -> Void,
        onNewChat: @escaping () -> Void
    ) -> some View {
        modifier(CycleErrorRecoveryModifier(
            hasError: hasError,
            lastUserText: lastUserText,
            onRetry: onRetry,
            onNewChat: onNewChat
        ))
    }
}

#Preview("Cycle error — with retry") {
    ZStack {
        DuskColors.bg.ignoresSafeArea()
        CycleErrorBanner(
            lastUserText: "What's the weather tomorrow?",
            onRetry: {},
            onNewChat: {},
            onDismiss: {}
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("Cycle error — no prior turn (new-chat only)") {
    ZStack {
        DuskColors.bg.ignoresSafeArea()
        CycleErrorBanner(
            lastUserText: nil,
            onRetry: {},
            onNewChat: {},
            onDismiss: {}
        )
    }
    .preferredColorScheme(.dark)
}
