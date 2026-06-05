import Testing
import Foundation
import MobileSdk
@testable import SentientApp

struct ChatRowsTests {
    // Full init required — SKIE does not propagate Kotlin default args to Swift.
    private func msg(_ ts: Int64) -> ChatMessage {
        ChatMessage(ts: ts, role: "user", content: "x",
                    streaming: false, cutoffKind: nil, cycleId: nil, tools: [])
    }
    private let cal = Calendar(identifier: .gregorian)

    @Test func sameDayGetsOneDivider() {
        let day: Int64 = 1_700_000_000_000
        let rows = chatRows([msg(day), msg(day + 60_000)], calendar: cal)
        #expect(rows.filter { if case .divider = $0 { return true } else { return false } }.count == 1)
    }

    @Test func twoDaysGetTwoDividers() {
        let d1: Int64 = 1_700_000_000_000
        let d2 = d1 + 24 * 3600 * 1000
        let rows = chatRows([msg(d1), msg(d2)], calendar: cal)
        #expect(rows.filter { if case .divider = $0 { return true } else { return false } }.count == 2)
    }

    @Test func emptyInputGivesNoRows() {
        #expect(chatRows([], calendar: cal).isEmpty)
    }
}
