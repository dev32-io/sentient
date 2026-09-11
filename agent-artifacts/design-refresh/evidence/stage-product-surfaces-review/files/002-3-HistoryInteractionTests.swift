import MobileData
import XCTest
@testable import SentientApp

final class HistoryInteractionTests: XCTestCase {
    private func row(_ id: String, _ title: String) -> SessionRow {
        SessionRow(
            sessionId: id,
            rootId: nil,
            title: title,
            startedAt: 0,
            lastActiveAt: 0,
            messageCount: 0,
            isActive: false
        )
    }

    func testSearchIsTrimmedCaseInsensitiveAndCanProduceNoMatch() {
        let rows = [row("one", "Morning Briefing"), row("two", "Kyoto plans")]
        XCTAssertEqual(historySessions(rows, matching: "  briefing ").map(\.sessionId), ["one"])
        XCTAssertEqual(historySessions(rows, matching: "KYOTO").map(\.sessionId), ["two"])
        XCTAssertTrue(historySessions(rows, matching: "missing").isEmpty)
        XCTAssertEqual(historySessions(rows, matching: "  ").count, 2)
    }

    func testDrawerPositionAndFlingSettling() {
        XCTAssertTrue(DrawerSettlingDecision.shouldOpen(fraction: 0.6, velocityX: 0))
        XCTAssertFalse(DrawerSettlingDecision.shouldOpen(fraction: 0.4, velocityX: 0))
        XCTAssertTrue(DrawerSettlingDecision.shouldOpen(fraction: 0.1, velocityX: 500))
        XCTAssertFalse(DrawerSettlingDecision.shouldOpen(fraction: 0.9, velocityX: -500))
    }

    func testSearchUsesFoundationTargetAndSemanticBodyType() {
        XCTAssertGreaterThanOrEqual(HistorySurfaceLayout.searchMinimumHeight, 44)
        XCTAssertEqual(HistorySurfaceLayout.searchTextRole.baseSize, DesignV2.Typography.body)
        XCTAssertGreaterThanOrEqual(HistorySurfaceLayout.searchTextRole.baseSize, 15)
    }
}
