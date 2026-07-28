import Testing
import Foundation
import MobileData
@testable import SentientApp

struct ChatRowsTests {
    // Full init required — SKIE does not propagate Kotlin default args to Swift.
    private func msg(_ ts: Int64) -> ChatMessage {
        ChatMessage(ts: ts, role: "user", content: "x",
                    streaming: false, cutoffKind: nil, turnId: nil, pendingId: nil, tools: [], entryId: "")
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

    // MARK: — turnId render-key guard tests

    private func assistantMsg(_ ts: Int64, turnId: String?) -> ChatMessage {
        ChatMessage(ts: ts, role: "assistant", content: "x",
                    streaming: false, cutoffKind: nil, turnId: turnId, pendingId: nil, tools: [], entryId: "")
    }

    @Test func distinctTurnIdsProduceDistinctRowIds() {
        // With unique server turnIds, two assistant turns never share a row id.
        let rows = chatRows([assistantMsg(1_700_000_001_000, turnId: "1000"),
                             assistantMsg(1_700_000_002_000, turnId: "2000")], calendar: cal)
            .compactMap { row -> String? in if case .message = row { return row.id } else { return nil } }
        #expect(rows.count == 2)
        #expect(Set(rows).count == 2) // no alias
    }
}
