// ---------------------------------------------------------------------------
// UpdateFooter — the state-morphing "Check for updates" control + version
// caption for the root Settings page, per the mobile-settings-parity plan's
// UX section. Replaces the current always-visible status-line + action-pair
// in SettingsView's `updateRow` with ONE control that morphs in place:
//
//   idle       → "Check for updates" (quiet/tonal button)
//   checking   → spinner + "Checking…" (disabled)
//   up-to-date → "✓ Up to date" (transient ~3s, then back to idle)
//   available  → "Update to vX.Y.Z" (primary/filled button)
//   failed     → "Check failed — Retry"
//
// Parameterized on the shared KMP `UpdateStatus` (same sealed type
// UpdateGate/UpdateModel already fold via `onEnum(of:)` — see
// ios/App/Update/UpdateGate.swift) rather than owning its own status: the
// caller (a future Settings root screen) passes the ONE process-wide
// UpdateModel's `.status` down, same instance the force-gate + banner read.
//
// "idle" and "up-to-date-at-rest" render identically ("Check for updates");
// only a check that JUST resolved to UpToDate shows the transient checkmark
// — so `onCheck` returns the resolved UpdateStatus directly (rather than
// this view re-reading a `status` prop that may still reflect the PREVIOUS
// render by the time the async check completes) to avoid a stale-capture
// race between the async continuation and the parent's next render pass.
//
// Stateless-leaf in the sense of owning no business state: `isChecking` /
// `justConfirmedUpToDate` are view-local transient UI state (loading spinner,
// timed checkmark), not app state — the caller never reads them.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let checkLabel = "Check for updates"
private let checkingLabel = "Checking…"
private let upToDateLabel = "✓ Up to date"
private let updatePrefix = "Update to v"
private let retryLabel = "Check failed — Retry"
private let upToDateDisplaySeconds: Double = 3.0

struct UpdateFooter: View {
    let status: UpdateStatus
    let versionText: String
    let accessibilityId: String
    /// Identifier for the version caption. Defaults to `\(accessibilityId)-version`;
    /// the root Settings page overrides it to the canonical `settings-version` id.
    var versionAccessibilityId: String? = nil
    /// Runs the check and returns the resolved status (e.g. `{ await
    /// updateModel.check(); return updateModel.status }`).
    let onCheck: () async -> UpdateStatus
    let onInstall: () -> Void

    @State private var isChecking = false
    @State private var justConfirmedUpToDate = false

    var body: some View {
        VStack(spacing: Space.sm) {
            footerButton
            Text(versionText)
                .font(Typo.ui(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
                .accessibilityIdentifier(versionAccessibilityId ?? "\(accessibilityId)-version")
        }
    }

    @ViewBuilder
    private var footerButton: some View {
        if isChecking {
            morphButton(checkingLabel, tint: DuskColors.ink2, filled: false, spinner: true, action: {})
        } else if justConfirmedUpToDate {
            morphButton(upToDateLabel, tint: DuskColors.accent, filled: false, spinner: false, action: {})
        } else {
            switch onEnum(of: status) {
            case .available(let a):
                morphButton(
                    "\(updatePrefix)\(a.versionName)",
                    tint: DuskColors.accent,
                    filled: true,
                    spinner: false,
                    action: onInstall
                )
            case .checkFailed:
                morphButton(retryLabel, tint: DuskColors.stop, filled: false, spinner: false, action: triggerCheck)
            case .upToDate:
                morphButton(checkLabel, tint: DuskColors.ink2, filled: false, spinner: false, action: triggerCheck)
            }
        }
    }

    private func morphButton(
        _ title: String,
        tint: Color,
        filled: Bool,
        spinner: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Space.xs) {
                if spinner {
                    ProgressView().tint(tint)
                }
                Text(title)
                    .font(Typo.ui(TypeScale.base, .semibold))
                    .foregroundStyle(filled ? DuskColors.bg : tint)
            }
            .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
            .padding(.horizontal, Space.md)
            .background(filled ? tint : Color.clear, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay {
                if !filled {
                    RoundedRectangle(cornerRadius: Radii.md).stroke(tint.opacity(0.6), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(spinner)
        .accessibilityIdentifier("\(accessibilityId)-action")
    }

    private func triggerCheck() {
        guard !isChecking else { return }
        isChecking = true
        Task {
            let result = await onCheck()
            isChecking = false
            if case .upToDate = onEnum(of: result) {
                justConfirmedUpToDate = true
                try? await Task.sleep(for: .seconds(upToDateDisplaySeconds))
                justConfirmedUpToDate = false
            }
        }
    }
}

#Preview("idle / up-to-date") {
    UpdateFooter(
        status: UpdateStatusUpToDate.shared,
        versionText: "0.2.0 (6)",
        accessibilityId: "settings-update",
        onCheck: { UpdateStatusUpToDate.shared },
        onInstall: {}
    )
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}

#Preview("available") {
    UpdateFooter(
        status: UpdateStatusAvailable(
            latestBuild: 7,
            versionName: "0.3.0",
            notes: "",
            mandatory: false,
            target: UpdateTargetIosItms(itmsUrl: "itms-services://?action=download-manifest&url=https://example.com/manifest.plist")
        ),
        versionText: "0.2.0 (6)",
        accessibilityId: "settings-update",
        onCheck: { UpdateStatusUpToDate.shared },
        onInstall: {}
    )
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}

#Preview("check failed") {
    UpdateFooter(
        status: UpdateStatusCheckFailed(reason: "network"),
        versionText: "0.2.0 (6)",
        accessibilityId: "settings-update",
        onCheck: { UpdateStatusCheckFailed(reason: "network") },
        onInstall: {}
    )
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
