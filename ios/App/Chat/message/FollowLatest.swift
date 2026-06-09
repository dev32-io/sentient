// FollowLatest — pin-to-bottom logic ported from webui use-follow-latest.ts.
// Pure; a MessageList scroll observer feeds offsets, and scrolls to end while pinned.
import Foundation

struct FollowLatestState: Equatable {
    var pinned: Bool = true
    var lastTop: Double = 0
    var lastHeight: Double = 0
}

/// Update pin state from a scroll sample. Unpin only on a real user scroll-up
/// (top decreased, height stable/growing) landing outside `snapPx`; re-pin in zone.
func followLatestOnScroll(_ s: FollowLatestState, top: Double, height: Double,
                          clientHeight: Double, snapPx: Double = 8, epsilon: Double = 1) -> FollowLatestState {
    var st = s
    let shrank = height < st.lastHeight
    let prevTop = st.lastTop
    st.lastTop = top
    st.lastHeight = height
    if shrank && st.pinned { return st }
    let movedUp = top < prevTop - epsilon
    let dist = height - top - clientHeight
    let atBottom = dist <= snapPx
    if st.pinned && movedUp && !atBottom {
        st.pinned = false
        return st
    }
    if !st.pinned && atBottom { st.pinned = true }
    return st
}
