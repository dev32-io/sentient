import Testing
@testable import SentientApp

// Pins the pure send-queue policy (web-sdk parity): text typed while the SDK is
// not READY is queued rather than dropped; the queue drains in order on the
// rising edge to READY.
struct SendQueueTests {
    @Test func sendsImmediatelyWhenReady() {
        let (s, out) = sendQueueOnSend(SendQueueState(), text: "hi", ready: true)
        #expect(out == ["hi"]); #expect(s.pending.isEmpty)
    }

    @Test func queuesWhenNotReady() {
        let (s, out) = sendQueueOnSend(SendQueueState(), text: "hi", ready: false)
        #expect(out.isEmpty); #expect(s.pending == ["hi"])
    }

    @Test func drainsInOrderOnRisingEdge() {
        let (next, out) = sendQueueOnStatus(SendQueueState(pending: ["a", "b"]), ready: true, wasReady: false)
        #expect(out == ["a", "b"]); #expect(next.pending.isEmpty)
    }

    @Test func doesNotDrainWhenAlreadyReady() {
        let (_, out) = sendQueueOnStatus(SendQueueState(pending: ["a"]), ready: true, wasReady: true)
        #expect(out.isEmpty)
    }
}
