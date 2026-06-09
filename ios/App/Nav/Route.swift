// ---------------------------------------------------------------------------
// Route — the closed set of NavigationStack destinations reachable from the
// root chat surface (Swift mirror of Android's Routes, minus chat itself).
//
// The ROOT of the stack is the chat surface, keyed `.id(activeSessionId)` so
// changing the active conversation rebuilds a fresh thin ChatViewModel (the
// SwiftUI analogue of Android's route-recreates-VM). Switching conversation is
// therefore NOT a stack push — it is an `activeSessionId` change at the root.
//
// History and settings are the pushable destinations. History is a thin route
// because selecting a conversation must pop back to the root and flip
// `activeSessionId`; settings is a leaf. (The chat surface still hosts the
// keeper drawer/sheet UI; these Route cases are the typed stack graph the
// cutover spec calls for.)
// ---------------------------------------------------------------------------
import Foundation

/// Closed sum of pushable destinations above the root chat surface.
enum Route: Hashable {
    case history
    case settings
}
