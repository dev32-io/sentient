// ---------------------------------------------------------------------------
// ChatPermissionAlert — the L3 permission-confirm dialog (design spec §7.1).
//
// Mirrors ChatPanelAlerts' alert(isPresented:presenting:) shape: bound to an
// Optional payload via a Binding, no Identifiable conformance needed on the
// payload.
//
// DECISION-REQUIRED. SwiftUI's plain .alert offers no swipe-away or tap-outside
// dismissal on iOS, so Allow/Deny are the ONLY way out — the platform enforces
// what Android's AlertDialog has to opt into (setCancelable(false) + a disabled
// back-press). Both surfaces therefore behave identically for the
// permission-confirm E2E case.
//
// Allow / Deny reuse the SAME two roles ChatPanelAlerts.panelDeletePrompt uses
// for its destructive-confirm / cancel pair: Allow is the consequential grant
// (role: .destructive — the entire point of an L3 confirm is that the tool is
// risky) and Deny is the safe no-op default (role: .cancel).
//
// PermissionPromptFSM is the pure reducer ChatViewModel folds every
// pendingPermission transition through, so the requestId-guard invariant is
// unit-testable without a live AsyncSequence collector (see
// ios/Tests/PermissionPromptFSMTests.swift).
//
// PRIVACY: `description` and `args` are USER CONTENT. They are rendered, never
// logged — mirroring the SDK-side PermissionConnector, which logs ids, toolName
// and the argument-key COUNT only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

/// Events that can change `ChatViewModel.pendingPermission`. Local-only
/// (Swift-native) — not wire types.
enum PermissionPromptEvent {
    /// A new prompt arrived from the SDK's `permissions` StateFlow (permission.request).
    case requested(PermissionPrompt)
    /// The SDK's `permissions` StateFlow no longer carries this prompt
    /// (permission.resolved — allowed / denied / timeout all clear identically;
    /// the outcome is server-side bookkeeping only, not a UI branch here).
    case resolved(requestId: String)
    /// The user tapped Allow or Deny locally — optimistic dismiss ahead of the round trip.
    case userResponded(requestId: String)
    /// The local `expiresAtMs` countdown elapsed before either of the above arrived — a
    /// defensive UI fallback only. The server has already fail-closed denied server-side
    /// (a timeout is never an implicit approval); this just unsticks the dialog if the
    /// `permission.resolved` echo is lost or delayed.
    case localTimeoutFired(requestId: String)
}

/// Pure reducer over `ChatViewModel.pendingPermission`. Every clearing path is guarded
/// by requestId so a stale event never clobbers a NEWER prompt that has since replaced
/// it. Decision-required: the ONLY way `pendingPermission` becomes nil is one of these
/// three events matching the CURRENT requestId — there is no bare "dismiss" path.
enum PermissionPromptFSM {
    static func reduce(current: PermissionPrompt?, event: PermissionPromptEvent) -> PermissionPrompt? {
        switch event {
        case .requested(let prompt):
            return prompt
        case .resolved(let requestId), .userResponded(let requestId), .localTimeoutFired(let requestId):
            return current?.requestId == requestId ? nil : current
        }
    }
}

extension View {
    /// Shows the outstanding permission-confirm prompt, if any, as a decision-required
    /// alert. `prompt` is a Binding the caller derives from `ChatViewModel.pendingPermission`
    /// (see ChatView) — its setter routes a binding-driven `nil` back into a VM call rather
    /// than mutating published state directly, per the MVVM view-calls-VM-methods rule.
    func permissionPrompt(
        _ prompt: Binding<PermissionPrompt?>,
        onRespond: @escaping (String, Bool) -> Void
    ) -> some View {
        alert("Allow this action?", isPresented: Binding(
            get: { prompt.wrappedValue != nil },
            set: { if !$0 { prompt.wrappedValue = nil } }
        ), presenting: prompt.wrappedValue) { p in
            Button("Allow", role: .destructive) {
                onRespond(p.requestId, true)
                prompt.wrappedValue = nil
            }
            .accessibilityIdentifier("permission-allow")
            Button("Deny", role: .cancel) {
                onRespond(p.requestId, false)
                prompt.wrappedValue = nil
            }
            .accessibilityIdentifier("permission-deny")
        } message: { p in
            // `description_` — SKIE renames PermissionPrompt.description to avoid the
            // collision with NSObject's own -description.
            Text("\(formatToolName(rawName: p.toolName))\n\n\(p.description_)")
        }
    }
}
