import SwiftUI
import MobileData

/// Native presentation lifetime is separate from the authoritative shared state.
/// A close intent is not evidence that UIKit has finished dismissing the sheet.
struct CalendarOverlayPresentation {
    private(set) var nativePresented = false
    private(set) var closeRequested = false
    private var awaitingClose = false

    func isCovered(sharedOpen: Bool) -> Bool { sharedOpen || nativePresented }

    mutating func sharedDidOpen() { awaitingClose = true }
    mutating func didPresent() {
        nativePresented = true
        awaitingClose = true
    }
    mutating func didDismiss() { nativePresented = false }

    mutating func requestClose(sharedOpen: Bool) -> Bool {
        guard sharedOpen, !closeRequested else { return false }
        closeRequested = true
        awaitingClose = true
        return true
    }

    mutating func finishClose(sharedOpen: Bool) -> Bool {
        guard awaitingClose, !isCovered(sharedOpen: sharedOpen) else { return false }
        awaitingClose = false
        closeRequested = false
        return true
    }
}

/// Integration wrapper that presents the controlled mutation state through one
/// native sheet. Keeping one Boolean presentation alive lets preview, editor,
/// delete, conflict, and outcome replace each other without a dismiss/reopen
/// cycle or an intermediate loss of editor state.
struct CalendarOverlayContainer<Content: View>: View {
    let state: CalendarUiState
    let origin: CalendarOverlayOrigin
    let actions: CalendarOverlayActions
    @Binding var presentation: CalendarOverlayPresentation
    let onClosed: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        let overlayOpen = CalendarOverlaySemantics.isOpen(state)
        let covered = presentation.isCovered(sharedOpen: overlayOpen)
        content()
            .allowsHitTesting(!covered)
            .accessibilityHidden(covered)
            .sheet(isPresented: presentationBinding, onDismiss: {
                presentation.didDismiss()
                completeCloseIfReady()
            }) {
                CalendarOverlayHost(state: state, actions: actions)
                    .onAppear { presentation.didPresent() }
            }
            .onChange(of: overlayOpen, initial: true) { _, isOpen in
                // A shared close can arrive before any sheet was presented, or
                // after an interactive dismissal's native completion callback.
                if isOpen {
                    presentation.sharedDidOpen()
                } else {
                    completeCloseIfReady()
                }
            }
    }

    private func completeCloseIfReady() {
        guard presentation.finishClose(sharedOpen: CalendarOverlaySemantics.isOpen(state)) else { return }
        actions.restoreFocus(origin)
        onClosed()
    }

    private var presentationBinding: Binding<Bool> {
        Binding(
            get: { CalendarOverlaySemantics.isOpen(state) },
            set: { isPresented in
                guard !isPresented, CalendarOverlaySemantics.allowsInteractiveDismiss(state) else { return }
                actions.close()
            }
        )
    }
}

/// Controlled content for the single native Calendar sheet. Shared mutation
/// state remains authoritative; this host only selects the mutually exclusive
/// composition and forwards actions.
struct CalendarOverlayHost: View {
    let state: CalendarUiState
    let actions: CalendarOverlayActions

    var body: some View {
        Group {
            if let outcome = state.outcome {
                CalendarOutcomeSheet(outcome: outcome, onClose: actions.acknowledgeOutcome)
            } else if let conflict = state.conflict {
                CalendarConflictSheet(
                    conflict: conflict,
                    error: state.mutation.error,
                    onReread: actions.rereadConflict,
                    onReview: actions.reviewConflict,
                    onCancel: actions.close
                )
            } else if let confirmation = state.deleteConfirmation {
                CalendarDeleteSheet(
                    confirmation: confirmation,
                    isOffline: state.isOffline,
                    isSubmitting: state.mutation.isSubmitting,
                    error: state.mutation.error,
                    onChooseScope: actions.chooseScope,
                    onDelete: actions.confirmDelete,
                    onCancel: actions.close
                )
            } else if let editor = state.editor {
                CalendarEditorSheet(
                    editor: editor,
                    canSave: CalendarOverlaySemantics.canSave(state, draft: editor.draft) &&
                        (editor.applicableScopes.count == 1 || editor.selectedScope != nil),
                    canDelete: state.mutationAvailability.canDelete,
                    isOffline: state.isOffline,
                    isSubmitting: state.mutation.isSubmitting,
                    error: state.mutation.error,
                    onUpdate: actions.updateDraft,
                    onChooseScope: actions.chooseScope,
                    onSave: actions.save,
                    onDelete: actions.requestDelete,
                    onCancel: actions.close
                )
            } else if let preview = state.preview {
                CalendarPreviewSheet(
                    occurrence: preview,
                    locale: Locale(identifier: state.locale.languageTag),
                    canEdit: state.mutationAvailability.canEdit,
                    isOffline: state.isOffline,
                    onEdit: { actions.edit(preview) },
                    onClose: actions.close
                )
            }
        }
        .presentationDetents([.fraction(CalendarOverlaySemantics.maximumHeightFraction)])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(CalendarOverlaySemantics.topRadius)
        .presentationBackground(DuskColors.paper)
        .presentationContentInteraction(.scrolls)
        .interactiveDismissDisabled(!CalendarOverlaySemantics.allowsInteractiveDismiss(state))
    }
}
