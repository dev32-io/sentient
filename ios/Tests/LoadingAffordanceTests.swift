import Testing
import MobileSdk
@testable import SentientApp

struct LoadingAffordanceTests {
    @Test func connectingShowsConnecting() {
        #expect(chatLoading(status: .connecting, cognition: .idle, hasMessages: false) == .connecting)
    }

    @Test func authenticatingShowsConnecting() {
        #expect(chatLoading(status: .authenticating, cognition: .idle, hasMessages: false) == .connecting)
    }

    @Test func readyEmptyIsSessionStarting() {
        #expect(chatLoading(status: .ready, cognition: .idle, hasMessages: false) == .sessionStarting)
    }

    @Test func readyWithMessagesThinkingIsNone() {
        #expect(chatLoading(status: .ready, cognition: .thinking, hasMessages: true) == LoadingAffordance.none)
    }

    @Test func readySteadyIsNone() {
        #expect(chatLoading(status: .ready, cognition: .idle, hasMessages: true) == LoadingAffordance.none)
    }
}
