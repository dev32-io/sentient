// ---------------------------------------------------------------------------
// SettingsDiagnostics — the "Send diagnostic log" two-lane section of Settings.
// Swift mirror of Android's SettingsDiagnostics (settings/SettingsDiagnostics.kt).
//
// Lane 1: a button (settings-send-logs). Tap → reveals the session list.
// Lane 2: newest-first sessions, each human-labelled ("Today 9:43 PM"), crashed
//   ones flagged 🔴, "This session" (the newest) default-selected. Tapping a row's
//   send button MORPHS it in place into a progress bar (bound to progress: Double?),
//   then a result line ("Sent ✓ — ref XXXX" / "Retry").
//
// Reads the VM's published state; dispatches selection + upload as closures. The
// owning SettingsSheet builds + owns the SendLogsViewModel.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let diagnosticsLabel = "Diagnostics"
private let sendLogsLabel = "Send diagnostic log"
private let crashFlag = "🔴 "
private let labelSent = "Sent ✓"
private let sentRefPrefix = "Sent ✓ — ref "
private let labelRetry = "Retry"
private let labelSend = "Send"
private let labelSelect = "Select"
private let labelNoSessions = "No diagnostic sessions yet."

/// The diagnostics section. Reads `model` published state; the newest session is
/// default-selected. Stateless beyond which row is selected (view-local).
struct SettingsDiagnostics: View {
    @ObservedObject var model: SendLogsViewModel
    let nowMs: Int64

    @State private var expanded = false
    @State private var selectedPath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(diagnosticsLabel)
                .font(Typo.ui(TypeScale.base, .semibold))
                .foregroundStyle(DuskColors.ink3)

            sendLogsButton

            if expanded {
                switch model.loadPhase {
                case .loading:
                    DesignProgress(title: "Loading diagnostic sessions")
                        .accessibilityIdentifier("settings-log-loading")
                case .failed:
                    AsyncNotice(kind: .error, title: "Couldn't load diagnostic sessions") {
                        Task { await model.load() }
                    }
                case .ready where model.sessions.isEmpty:
                    AsyncNotice(kind: .empty, title: labelNoSessions)
                        .accessibilityIdentifier("settings-log-empty")
                case .ready:
                    sessionRows
                }
            }
        }
        .onChange(of: model.sessions) { _, sessions in
            // Default-select the newest ("This session") once the list loads.
            if selectedPath == nil { selectedPath = sessions.first?.path }
        }
    }

    private var sendLogsButton: some View {
        DesignActionButton(
            title: sendLogsLabel,
            role: .quiet,
            accessibilityId: "settings-send-logs",
            action: {
                expanded.toggle()
                if expanded && selectedPath == nil { selectedPath = model.sessions.first?.path }
            }
        )
    }

    private var sessionRows: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(Array(model.sessions.enumerated()), id: \.element.path) { index, session in
                SessionUploadRow(
                    info: session,
                    label: SessionLabel.label(
                        sessionStartMs: session.sessionStartMs,
                        nowMs: nowMs,
                        isNewest: index == 0
                    ),
                    selected: session.path == selectedPath,
                    isUploading: session.path == model.uploadingPath,
                    progress: session.path == model.uploadingPath ? model.progress : nil,
                    outcome: session.path == model.uploadingPath ? model.outcome : nil,
                    onSelect: { selectedPath = session.path },
                    onUpload: { model.upload(path: session.path) }
                )
            }
        }
    }
}

#Preview("empty") {
    SettingsDiagnostics(
        model: SendLogsViewModel(initialLoadPhase: .ready),
        nowMs: Int64(Date().timeIntervalSince1970 * 1000)
    )
    .padding()
    .background(DuskColors.bg)
}

/// One session: a select-row whose trailing send control morphs into a bar then a result.
private struct SessionUploadRow: View {
    let info: VitalsSessionInfo
    let label: String
    let selected: Bool
    let isUploading: Bool
    let progress: Double?
    let outcome: UploadOutcome?
    let onSelect: () -> Void
    let onUpload: () -> Void

    var body: some View {
        HStack(spacing: Space.sm) {
            Text((info.crashed ? crashFlag : "") + label)
                .font(Typo.ui(TypeScale.sm, selected ? .semibold : .regular))
                .foregroundStyle(selected ? DuskColors.accent : DuskColors.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            UploadControl(
                selected: selected,
                isUploading: isUploading,
                progress: progress,
                outcome: outcome,
                onSelect: onSelect,
                onUpload: onUpload
            )
        }
        .padding(.vertical, Space.xs)
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("settings-log-session-\(info.sessionStartMs)")
    }
}

/// The morphing trailing control: select → send button → progress bar → result line.
private struct UploadControl: View {
    let selected: Bool
    let isUploading: Bool
    let progress: Double?
    let outcome: UploadOutcome?
    let onSelect: () -> Void
    let onUpload: () -> Void

    var body: some View {
        switch (isUploading, progress, outcome) {
        case let (true, p?, _):
            DesignProgress(value: p, accessibilityId: "settings-log-progress")
                .frame(width: DesignMetrics.progressWidth)
        case let (_, _, .sent(ref)):
            Text(ref.isEmpty ? labelSent : "\(sentRefPrefix)\(ref)")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.accent)
                .accessibilityIdentifier("settings-log-sent")
        case (_, _, .failed):
            DesignTextButton(
                title: labelRetry,
                role: .destructive,
                accessibilityId: "settings-log-failed",
                action: { onSelect(); onUpload() }
            )
        default:
            if selected {
                DesignTextButton(title: labelSend, role: .action, accessibilityId: "settings-log-send", action: onUpload)
            } else {
                DesignTextButton(title: labelSelect, accessibilityId: "settings-log-select", action: onSelect)
            }
        }
    }
}
