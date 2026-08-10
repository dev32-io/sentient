import Testing
import MobileData
@testable import SentientApp

// Pins the permission-prompt dismissal FSM (design spec §7.1): every clearing path
// (.resolved / .userResponded / .localTimeoutFired) is guarded by requestId so a
// stale event (a delayed server echo, an old countdown timer) never clobbers a NEWER
// prompt that has since replaced the one it was raised for.
struct PermissionPromptFSMTests {
    private func prompt(_ id: String) -> PermissionPrompt {
        PermissionPrompt(
            requestId: id,
            toolCallId: "call-\(id)",
            toolName: "search_web",
            args: [:],
            description: "Search the web",
            expiresAtMs: 0
        )
    }

    @Test func requestedSetsPending() {
        let next = PermissionPromptFSM.reduce(current: nil, event: .requested(prompt("req-1")))
        #expect(next?.requestId == "req-1")
    }

    @Test func requestedReplacesAnOutstandingOne() {
        // Defensive only — SessionRuntime serializes one turn at a time, so two live
        // prompts shouldn't normally overlap — but the reducer must not get stuck.
        let next = PermissionPromptFSM.reduce(current: prompt("req-1"), event: .requested(prompt("req-2")))
        #expect(next?.requestId == "req-2")
    }

    @Test func resolvedMatchingIdClears() {
        let next = PermissionPromptFSM.reduce(current: prompt("req-1"), event: .resolved(requestId: "req-1"))
        #expect(next == nil)
    }

    @Test func resolvedStaleIdIsNoOp() {
        let next = PermissionPromptFSM.reduce(current: prompt("req-2"), event: .resolved(requestId: "req-1"))
        #expect(next?.requestId == "req-2")
    }

    @Test func userRespondedMatchingIdClears() {
        let next = PermissionPromptFSM.reduce(current: prompt("req-1"), event: .userResponded(requestId: "req-1"))
        #expect(next == nil)
    }

    @Test func localTimeoutFiredMatchingIdClears() {
        let next = PermissionPromptFSM.reduce(current: prompt("req-1"), event: .localTimeoutFired(requestId: "req-1"))
        #expect(next == nil)
    }

    @Test func localTimeoutFiredStaleIdIsNoOp() {
        // The countdown Task for an old prompt fires AFTER the user already answered
        // and a new prompt arrived — must not clobber the new one.
        let next = PermissionPromptFSM.reduce(current: prompt("req-2"), event: .localTimeoutFired(requestId: "req-1"))
        #expect(next?.requestId == "req-2")
    }
}
