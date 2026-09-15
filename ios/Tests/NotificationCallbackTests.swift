import XCTest
@testable import SentientApp

final class NotificationCallbackTests: XCTestCase {
    @MainActor
    func testBackgroundNotificationCallbackStoresPendingIntentBeforeCompletingOnMain() async {
        let coordinator = NativePushCoordinator()
        let destination = NotificationDestination(sessionId: "scheduled-session")!
        let completed = expectation(description: "notification callback completed")
        var completionCount = 0

        DispatchQueue.global().async {
            coordinator.completeNotificationResponse(userInfo: ["sessionId": destination.sessionId]) {
                completionCount += 1
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(coordinator.navigation.destination, destination)
                completed.fulfill()
            }
        }

        await fulfillment(of: [completed], timeout: 2)
        XCTAssertEqual(completionCount, 1)
    }

    @MainActor
    func testBackgroundMalformedNotificationStillCompletesOnceOnMain() async {
        let coordinator = NativePushCoordinator()
        let completed = expectation(description: "malformed notification callback completed")
        var completionCount = 0

        DispatchQueue.global().async {
            coordinator.completeNotificationResponse(userInfo: ["sessionId": "../invalid"]) {
                completionCount += 1
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertNil(coordinator.navigation.destination)
                completed.fulfill()
            }
        }

        await fulfillment(of: [completed], timeout: 2)
        XCTAssertEqual(completionCount, 1)
    }
}
