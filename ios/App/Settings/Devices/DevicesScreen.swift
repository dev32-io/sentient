// ---------------------------------------------------------------------------
// DevicesScreen — User-group "Devices" category page. One Signal card: linked →
// masked account + since-date + Unlink (confirm → refetch); unlinked → Link
// Signal → QR sheet (rendered from the gateway's qrDataUrl PNG) + status poll →
// linked/failed. Screen exit or Cancel stops the poll and fires link/cancel.
//
// Owns the @Observable DevicesViewModel via @State; DevicesBody is stateless
// (previewable per SignalState). The QR sheet's presentation is the VM's
// `isLinking`; dismissing it cancels the pairing.
// ---------------------------------------------------------------------------
import SwiftUI
import UIKit
import MobileData

struct DevicesScreen: View {
    @State private var vm: DevicesViewModel
    private let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: DevicesViewModel(devices: settings.devices))
    }

    var body: some View {
        DevicesBody(
            signal: vm.signal,
            isUnlinking: vm.isUnlinking,
            onLink: { Task { await vm.startLink() } },
            onUnlink: { Task { await vm.unlink() } }
        )
        .task { await vm.load() }
        .onDisappear { vm.cancelLink() }
        .sheet(isPresented: linkingBinding) {
            QrLinkSheet(
                phase: vm.linkPhase,
                onRetry: { Task { await vm.startLink() } },
                onCancel: { vm.cancelLink() }
            )
        }
    }

    private var linkingBinding: Binding<Bool> {
        Binding(get: { vm.isLinking }, set: { open in if !open { vm.cancelLink() } })
    }
}

/// Stateless Signal card body; owns only the transient unlink-confirm toggle.
private struct DevicesBody: View {
    let signal: DevicesViewModel.SignalState
    let isUnlinking: Bool
    let onLink: () -> Void
    let onUnlink: () -> Void

    @State private var confirmingUnlink = false

    var body: some View {
        SettingsPageScaffold(title: "Devices", screenId: "settings-devices-screen") {
            SettingsCard(title: "Signal", sub: "Text-chat via your own Signal account.") {
                content
            }
        }
        .confirmationDialog("Disconnect Signal?", isPresented: $confirmingUnlink, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive, action: onUnlink)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes Sentient as a linked device from your Signal account. Past conversation history stays in your memory.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch signal {
        case .loading:
            ProgressView().controlSize(.small).padding(.vertical, Space.md)
        case .linked(let account, let since):
            linkedView(account: account, since: since)
        case .unlinked:
            unpairedView
        case .loadError:
            Text("Couldn't load device status.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .padding(.vertical, Space.md)
        }
    }

    private func linkedView(account: String?, since: String?) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(spacing: Space.sm) {
                Circle().fill(DuskColors.ok).frame(width: 8, height: 8)
                Text("Linked").font(Typo.ui(TypeScale.sm, .semibold)).foregroundStyle(DuskColors.ink)
                if let account { Text(account).font(Typo.mono(TypeScale.sm)).foregroundStyle(DuskColors.ink2) }
                if let since { Text("since \(formatSince(since))").font(Typo.ui(TypeScale.xs)).foregroundStyle(DuskColors.ink3) }
            }
            DangerButton(title: isUnlinking ? "Unlinking…" : "Unlink", accessibilityId: "settings-devices-unlink") {
                confirmingUnlink = true
            }
            .disabled(isUnlinking)
        }
        .padding(.vertical, Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var unpairedView: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("Text-chat with your agent from Signal. Links your own Signal account using \"Note to Self\" — no second number needed.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
            Button("Link Signal", action: onLink)
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.accent)
                .accessibilityIdentifier("settings-devices-link")
        }
        .padding(.vertical, Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The link sheet: scan-steps + QR (or preparing / error) + Cancel.
private struct QrLinkSheet: View {
    let phase: DevicesViewModel.LinkPhase
    let onRetry: () -> Void
    let onCancel: () -> Void

    private static let qrSide: CGFloat = 240

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    steps
                    qrArea
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(DuskColors.bg)
            .navigationTitle("Link your Signal account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("settings-devices-link-cancel")
                }
            }
            .duskTheme()
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            stepLine("1. On your phone, open Signal")
            stepLine("2. Tap your avatar → Linked Devices")
            stepLine("3. Tap \"Link New Device\"")
            stepLine("4. Scan this QR code")
        }
    }

    private func stepLine(_ text: String) -> some View {
        Text(text).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
    }

    @ViewBuilder
    private var qrArea: some View {
        switch phase {
        case .idle, .preparing:
            HStack { Spacer(); ProgressView("Preparing link…"); Spacer() }
                .padding(.vertical, Space.xl)
        case .active(let qr):
            qrImage(qr)
        case .failed(let message):
            VStack(spacing: Space.md) {
                Text(message).font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.stop)
                Button("Retry", action: onRetry)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.accent)
                    .accessibilityIdentifier("settings-devices-link-retry")
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.lg)
        }
    }

    @ViewBuilder
    private func qrImage(_ qr: Data) -> some View {
        if let image = UIImage(data: qr) {
            HStack {
                Spacer()
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: Self.qrSide, height: Self.qrSide)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: Radii.sm))
                    .accessibilityIdentifier("settings-devices-qr")
                Spacer()
            }
        } else {
            Text("Couldn't render the linking code.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.stop)
        }
    }
}

/// ISO-8601 → short local date; falls back to the raw string on parse failure.
private func formatSince(_ iso: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .none
    return formatter.string(from: date)
}

// ── Previews — Signal states (no VM) ─────────────────────────────────────────

#Preview("linked") {
    NavigationStack {
        DevicesBody(
            signal: .linked(account: "+1 •••• ••34", since: "2026-06-01T12:00:00Z"),
            isUnlinking: false, onLink: {}, onUnlink: {}
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("unlinked") {
    NavigationStack {
        DevicesBody(signal: .unlinked, isUnlinking: false, onLink: {}, onUnlink: {})
    }
    .preferredColorScheme(.dark)
}
