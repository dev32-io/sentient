import Testing
import Foundation
import MobileData
@testable import SentientApp

struct ChatRowsTests {
    // Full init required — SKIE does not propagate Kotlin default args to Swift.
    private func msg(_ ts: Int64, entryId: String = "") -> ChatMessage {
        ChatMessage(ts: ts, role: "user", content: "x",
                    streaming: false, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: entryId)
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

    // MARK: — replyId render-key guard tests (steered-turn regression)

    private func assistantMsg(_ ts: Int64, turnId: String?, replyId: String? = nil,
                               entryId: String = "", streaming: Bool = false) -> ChatMessage {
        ChatMessage(ts: ts, role: "assistant", content: "x",
                    streaming: streaming, cutoffKind: nil, turnId: turnId, replyId: replyId,
                    pendingId: nil, entryId: entryId)
    }

    @Test func distinctReplyIdsProduceDistinctRowIds() {
        // With unique server replyIds, two assistant turns never share a row id.
        let rows = chatRows([assistantMsg(1_700_000_001_000, turnId: "1000", replyId: "r1000"),
                             assistantMsg(1_700_000_002_000, turnId: "2000", replyId: "r2000")], calendar: cal)
            .compactMap { row -> String? in if case .message = row { return row.id } else { return nil } }
        #expect(rows.count == 2)
        #expect(Set(rows).count == 2) // no alias
    }

    @Test func steeredTurnRowsAllUnique() {
        // Real steered-turn shape from device vitals: one turnId, two assistant
        // replies carrying DIFFERENT replyIds (a mid-turn steer rotates replyId),
        // bracketed by the two user messages that triggered them. Keying on
        // turnId alone (the pre-fix rule) collapses the two replies onto one row —
        // a duplicate Identifiable id in the ForEach. This is the pin: it fails
        // against the pre-fix turnId-first rule and passes against replyId-first.
        let t0: Int64 = 1_700_000_000_000
        let messages = [
            msg(t0, entryId: "1819"),
            assistantMsg(t0 + 1_000, turnId: "T1", replyId: "R1", entryId: "e-R1"),
            msg(t0 + 2_000, entryId: "1827"),
            assistantMsg(t0 + 3_000, turnId: "T1", replyId: "R2", entryId: "e-R2"),
        ]
        let ids = chatRows(messages, calendar: cal)
            .compactMap { row -> String? in if case .message = row { return row.id } else { return nil } }
        #expect(ids.count == 4)
        #expect(Set(ids).count == 4) // every row id unique
    }

    @Test func steeredTurnRepliesCollideOnTurnIdAlone() {
        // Mutation check: proves the assertion above is not vacuous. Reproduces
        // the PRE-FIX rule (turn-<turnId> only) inline and shows it genuinely
        // collides for this exact steered-turn shape — only keying on replyId
        // first (the fixed rule, ChatRow.messageRowId) tells the two replies apart.
        let reply1 = assistantMsg(1_700_000_001_000, turnId: "T1", replyId: "R1", entryId: "e-R1")
        let reply2 = assistantMsg(1_700_000_003_000, turnId: "T1", replyId: "R2", entryId: "e-R2")
        let preFixKey = { (m: ChatMessage) in "turn-\(m.turnId ?? "")" }
        #expect(preFixKey(reply1) == preFixKey(reply2)) // pre-fix rule collides
        let ids = chatRows([reply1, reply2], calendar: cal)
            .compactMap { row -> String? in if case .message = row { return row.id } else { return nil } }
        #expect(ids[0] != ids[1]) // fixed rule does not
    }

    @Test func streamingToCommittedHandoffSameRowId() {
        // Streaming bubble (entryId empty) and its committed twin (entryId = R)
        // share replyId — must yield the SAME row id so the handoff never remounts.
        let streaming = assistantMsg(0, turnId: nil, replyId: "R9", entryId: "", streaming: true)
        let committed = assistantMsg(1_700_000_000_000, turnId: nil, replyId: "R9", entryId: "R9")
        #expect(ChatRow.message(streaming, index: 0, continuation: false).id == ChatRow.message(committed, index: 1, continuation: false).id)
    }

    @Test func adjacentSameSpeakerGroupsWithoutLosingRows() {
        let first = assistantMsg(1_700_000_001_000, turnId: "T1", replyId: "R1")
        let second = assistantMsg(1_700_000_002_000, turnId: "T2", replyId: "R2")
        let rows = chatRows([first, second], calendar: cal)
        let continuations = rows.compactMap { row -> Bool? in
            if case let .message(_, _, continuation) = row { return continuation }
            return nil
        }
        #expect(continuations == [false, true])
    }

    @Test func roleChangeAndDayDividerBreakGrouping() {
        let first = assistantMsg(1_700_000_001_000, turnId: "T1")
        let user = msg(1_700_000_002_000)
        let nextDay = assistantMsg(1_700_086_401_000, turnId: "T2")
        let continuations = chatRows([first, user, nextDay], calendar: cal).compactMap { row -> Bool? in
            if case let .message(_, _, continuation) = row { return continuation }
            return nil
        }
        #expect(continuations == [false, false, false])
    }
}
