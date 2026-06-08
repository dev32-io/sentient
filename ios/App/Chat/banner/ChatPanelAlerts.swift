// ---------------------------------------------------------------------------
// ChatPanelAlerts — rename / delete alert modifiers + payload type for the
// history side-panel's context-menu actions. Extracted from ChatView to keep
// that file under 300 lines.
//
// PanelTarget is an Identifiable payload that drives .alert(isPresented:) for
// both the rename (text-field alert) and delete (destructive confirm) flows.
// The two view modifiers mirror HistorySheet's file-private renamePrompt /
// deletePrompt; they live here because the sheet is gone and ChatView is now
// the alert host.
// ---------------------------------------------------------------------------
import SwiftUI

/// Rename/delete alert payload for a panel row. Module-internal so ChatView
/// and the modifier extensions share the type.
struct PanelTarget: Identifiable {
    let id: String
    let title: String
}

extension View {
    /// Shows a rename alert with an inline text field.
    func panelRenamePrompt(
        _ target: Binding<PanelTarget?>,
        text: Binding<String>,
        onConfirm: @escaping (String, String) -> Void
    ) -> some View {
        alert("Rename chat", isPresented: Binding(
            get: { target.wrappedValue != nil },
            set: { if !$0 { target.wrappedValue = nil } }
        )) {
            TextField("Title", text: text)
                .accessibilityIdentifier("history-rename-input")
            Button("Save") {
                if let t = target.wrappedValue {
                    let trimmed = text.wrappedValue.trimmingCharacters(in: .whitespaces)
                    if !trimmed.isEmpty { onConfirm(t.id, trimmed) }
                }
                target.wrappedValue = nil
            }
            Button("Cancel", role: .cancel) { target.wrappedValue = nil }
        }
    }

    /// Shows a destructive delete-confirm alert.
    func panelDeletePrompt(
        _ target: Binding<PanelTarget?>,
        onConfirm: @escaping (String) -> Void
    ) -> some View {
        alert("Delete chat?", isPresented: Binding(
            get: { target.wrappedValue != nil },
            set: { if !$0 { target.wrappedValue = nil } }
        ), presenting: target.wrappedValue) { t in
            Button("Delete", role: .destructive) {
                onConfirm(t.id)
                target.wrappedValue = nil
            }
            Button("Cancel", role: .cancel) { target.wrappedValue = nil }
        } message: { t in
            Text("\"\(t.title)\" will be permanently deleted.")
        }
    }
}
