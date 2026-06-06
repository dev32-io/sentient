import Testing
import MobileSdk
@testable import SentientApp

struct LoadingAffordanceTests {
    @Test func connectingShowsConnecting() {
        #expect(chatLoading(status: .connecting) == .connecting)
    }

    @Test func authenticatingShowsConnecting() {
        #expect(chatLoading(status: .authenticating) == .connecting)
    }

    // A READY-but-empty session is NOT a loading state — an empty chat is
    // immediately typeable, so no "session starting" spinner (it would spin forever).
    @Test func readyEmptyIsNone() {
        #expect(chatLoading(status: .ready) == LoadingAffordance.none)
    }

    @Test func readySteadyIsNone() {
        #expect(chatLoading(status: .ready) == LoadingAffordance.none)
    }

    @Test func disconnectedIsNone() {
        #expect(chatLoading(status: .disconnected) == LoadingAffordance.none)
    }
}
