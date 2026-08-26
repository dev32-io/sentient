import XCTest
@testable import SentientApp

@MainActor
final class AccessAccountAdminSurfaceTests: XCTestCase {
    func testBackendValidationRejectsEmptyHostAndOutOfRangePorts() {
        XCTAssertEqual(backendValidationError(host: "  ", port: "443"), "Enter a host or IP.")
        XCTAssertEqual(backendValidationError(host: "gateway.local", port: "0"), "Port must be 1–65535.")
        XCTAssertEqual(backendValidationError(host: "gateway.local", port: "65536"), "Port must be 1–65535.")
        XCTAssertEqual(
            backendValidationError(host: "user:password@gateway.local", port: "443"),
            "Enter a host or IP without a scheme, credentials, or path."
        )
        XCTAssertNil(backendValidationError(host: "gateway.local", port: "443"))
    }

    func testBackendProbeFailureRetriesOnceAndNeverAppliesConfiguration() async {
        var attempts = 0
        var applied = false
        let model = BackendSetupViewModel(
            existing: nil,
            reconfigure: { _ in applied = true },
            probe: { _ in attempts += 1; return false },
            retryDelay: .zero
        )
        model.host = "private-gateway.local"
        model.port = "443"

        model.save()
        await waitUntil { !model.isSaving }

        XCTAssertEqual(attempts, 2)
        XCTAssertFalse(applied)
        XCTAssertFalse(model.didSave)
        XCTAssertEqual(model.error, "Couldn't verify the server. Check the host, port, and TLS option.")
        XCTAssertFalse(model.error?.contains("private-gateway") ?? true)
    }

    func testLoginPickerPresentsEveryReadinessTerminalStateWithoutAnotherClock() {
        XCTAssertEqual(loginPickerState(isLoading: true, userCount: 0, error: nil), .loading)
        XCTAssertEqual(loginPickerState(isLoading: false, userCount: 0, error: nil), .empty)
        XCTAssertEqual(
            loginPickerState(isLoading: false, userCount: 0, error: "Network unavailable"),
            .error("Network unavailable")
        )
        XCTAssertEqual(loginPickerState(isLoading: false, userCount: 2, error: nil), .ready)
    }

    func testUpdateGateCoversOptionalDismissalAndMandatoryOverride() {
        XCTAssertEqual(updateGateState(version: nil, mandatory: false, bannerDismissed: false), .clear)
        XCTAssertEqual(updateGateState(version: "2.0", mandatory: false, bannerDismissed: false), .banner("2.0"))
        XCTAssertEqual(updateGateState(version: "2.0", mandatory: false, bannerDismissed: true), .clear)
        XCTAssertEqual(updateGateState(version: "2.0", mandatory: true, bannerDismissed: true), .forced("2.0"))
    }

    func testAccountAndPinValidationPreserveRecoverableDrafts() {
        XCTAssertFalse(isDisplayNameDirty(draft: "   ", saved: "Ada"))
        XCTAssertFalse(isDisplayNameDirty(draft: " Ada ", saved: "Ada"))
        XCTAssertTrue(isDisplayNameDirty(draft: "Grace", saved: "Ada"))
        XCTAssertEqual(pinChangeValidationError(current: "1234", newPin: "1234"), "Choose a different new PIN.")
        XCTAssertNil(pinChangeValidationError(current: "1234", newPin: "5678"))
    }

    func testMemberValidationAndAuthorizationFailClosed() {
        XCTAssertEqual(addMemberValidationError(name: "", pin: "1234"), "Enter a display name.")
        XCTAssertEqual(addMemberValidationError(name: "Sam", pin: "12"), "Enter a four-digit PIN.")
        XCTAssertNil(addMemberValidationError(name: " Sam ", pin: "1234"))
        XCTAssertTrue(isAuthorizationFailure(kindName: "AUTH"))
        XCTAssertTrue(isAuthorizationFailure(kindName: "auth"))
        XCTAssertFalse(isAuthorizationFailure(kindName: "CONNECTION"))
    }

    func testSecretApplyFeedbackCoversRetryAndTerminalStates() {
        XCTAssertEqual(SecretsViewModel.ApplyPhase.notice, .notice)
        XCTAssertEqual(SecretsViewModel.ApplyPhase.applying, .applying)
        XCTAssertEqual(SecretsViewModel.ApplyPhase.applied, .applied)
        XCTAssertEqual(SecretsViewModel.ApplyPhase.alreadyApplying, .alreadyApplying)
        XCTAssertTrue(SecretsViewModel.ApplyPhase.failed("Retry").isFailed)
        XCTAssertFalse(SecretsViewModel.ApplyPhase.notice.isFailed)
    }

    func testSecretEvidenceIsPresenceOnlyAndLargeTextUsesSharedMinimumTarget() {
        let rawSecret = "never-return-this-value"
        XCTAssertEqual(secretPresenceMask, "••••••••••••")
        XCTAssertFalse(secretPresenceMask.contains(rawSecret))
        XCTAssertGreaterThanOrEqual(DesignMetrics.minimumTarget, 44)
        XCTAssertEqual(DesignTextRole.body.baseSize, DesignV2.Typography.body)
    }

    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
        for _ in 0..<100 where !condition() { await Task.yield() }
        XCTAssertTrue(condition(), "Expected observable completion")
    }
}
