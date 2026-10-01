import Foundation
import MobileData
import Testing
@testable import SentientApp

@MainActor
struct CubeHistoryFailureBoundaryTests {
    @Test
    func refusedHistoryRequestReachesSwiftCatchAndAllowsRetry() async throws {
        // Disposable test-app scope; no gateway, socket connect, audio or hardware.
        let session = createUserSession(
            gatewayWsUrl: "ws://127.0.0.1:9/api/v1/ws",
            allowSelfSignedDevHost: false,
            authenticatedUserId: "cube-history-failure-\(UUID().uuidString)",
            capabilities: [],
            devFaultsEnabled: false,
            onLoggedOut: {}
        )
        defer { session.close() }
        let model = HistoryViewModel(component: session.component)

        // Exercise viewer's real Swift -> ChatComponent -> SDK -> Darwin HTTP path.
        // Missing mapping or ChatComponent's @Throws would abort instead of entering catch.
        for _ in 0..<2 {
            do {
                _ = try await model.cubeHistory("cube")
                Issue.record("Unavailable history unexpectedly succeeded")
            } catch is CancellationError {
                Issue.record("Network failure must not become cancellation")
            } catch {
                let failure = try #require((error as NSError).kotlinException)
                #expect(failure is SessionsTransportException)
            }
        }
    }
}
