import Testing
import MobileData
@testable import SentientApp

// Pins the FSM mapping ConnectionBannerState.derive(status:connectionLost:).
// The invariant (mobile-sdk-specific): `connectionLost` stays TRUE from an
// unexpected drop through the entire backoff recovery AND at exhaustion (cleared
// only on READY), so STATUS — not connectionLost — discriminates the looping
// "Reconnecting…" banner from the terminal "Tap to reconnect" one. A naive
// `connectionLost ? .lost : …` derivation makes .reconnecting unreachable; this
// test guards against that regression.
struct ConnectionBannerStateTests {
    @Test func dropEntersReconnecting() {
        // onConnectionDrop: connectionLost=true, status=RECONNECTING together.
        #expect(ConnectionBannerState.derive(status: .reconnecting, connectionLost: true) == .reconnecting)
    }

    @Test func midAttemptConnectingStaysReconnecting() {
        // Backoff loop cycles RECONNECTING → CONNECTING; connectionLost stays true.
        #expect(ConnectionBannerState.derive(status: .connecting, connectionLost: true) == .reconnecting)
    }

    @Test func midAttemptAuthenticatingStaysReconnecting() {
        // …→ AUTHENTICATING; still mid-recovery, still "Reconnecting…".
        #expect(ConnectionBannerState.derive(status: .authenticating, connectionLost: true) == .reconnecting)
    }

    @Test func exhaustedShowsLost() {
        // onReconnectExhausted: connectionLost=true, status=DISCONNECTED.
        #expect(ConnectionBannerState.derive(status: .disconnected, connectionLost: true) == .lost)
    }

    @Test func terminalErrorShowsLost() {
        // setError: status=ERROR (connectionLost may be false on a fresh terminal).
        #expect(ConnectionBannerState.derive(status: .error, connectionLost: false) == .lost)
    }

    @Test func readyClearsBanner() {
        // setStatus(READY) clears connectionLost; healthy ⇒ no banner.
        #expect(ConnectionBannerState.derive(status: .ready, connectionLost: false) == nil)
    }

    @Test func firstConnectShowsNoBanner() {
        // Normal FIRST connect: connectionLost=false, status=CONNECTING ⇒ nil.
        #expect(ConnectionBannerState.derive(status: .connecting, connectionLost: false) == nil)
    }

    @Test func disconnectedWithoutLostShowsNoBanner() {
        // Initial/idle-closed DISCONNECTED without a prior drop ⇒ no banner.
        #expect(ConnectionBannerState.derive(status: .disconnected, connectionLost: false) == nil)
    }
}
