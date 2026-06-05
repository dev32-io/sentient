import Testing
@testable import SentientApp

struct FollowLatestTests {
    @Test func startsPinned() { #expect(FollowLatestState().pinned) }

    @Test func userScrollUpUnpins() {
        var s = FollowLatestState(pinned: true, lastTop: 100, lastHeight: 500)
        s = followLatestOnScroll(s, top: 40, height: 500, clientHeight: 300) // moved up, dist=160>8
        #expect(!s.pinned)
    }

    @Test func backInSnapZoneRepins() {
        var s = FollowLatestState(pinned: false, lastTop: 40, lastHeight: 500)
        s = followLatestOnScroll(s, top: 200, height: 500, clientHeight: 300) // dist = 0 <= 8
        #expect(s.pinned)
    }

    @Test func contentShrinkDoesNotUnpin() {
        var s = FollowLatestState(pinned: true, lastTop: 200, lastHeight: 500)
        s = followLatestOnScroll(s, top: 150, height: 400, clientHeight: 300) // shrank
        #expect(s.pinned)
    }

    @Test func contentShrinkWhileUnpinnedStaysUnpinned() {
        // shrank, but already unpinned + still above the snap zone → stay unpinned
        var s = FollowLatestState(pinned: false, lastTop: 100, lastHeight: 500)
        s = followLatestOnScroll(s, top: 80, height: 400, clientHeight: 300) // shrank, dist=20>8
        #expect(!s.pinned)
    }
}
