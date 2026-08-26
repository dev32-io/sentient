import XCTest
import MobileData
@testable import SentientApp

final class SettingsSystemSurfaceTests: XCTestCase {
    func testToolPermissionControlRoundTripsEverySupportedValue() {
        XCTAssertEqual(ToolPermission.allCases.map(\.wireValue), ["allow", "ask", "deny", "off"])
        XCTAssertEqual(ToolPermission.selectOptions.map(\.label), ["Allow", "Ask", "Deny", "Off"])
        XCTAssertEqual(ToolPermission.allCases.compactMap { ToolPermission(wireValue: $0.wireValue) }, ToolPermission.allCases)
        XCTAssertNil(ToolPermission(wireValue: "unknown"))
    }

    func testCapabilityIdentifiersBecomeHouseholdFacingLabels() {
        XCTAssertEqual(capabilityName("home-assistant"), "Home Assistant")
        XCTAssertEqual(capabilityName("turn_on"), "Turn On")
        XCTAssertEqual(capabilityName("delegateTask"), "Delegate Task")
    }

    func testDiagnosticRecoveryReferenceIsSanitizedAndBounded() {
        let raw = "case-42 <script>alert@example.com / free form"
        let visible = sanitizedDiagnosticsReference(raw)

        XCTAssertEqual(visible, "case-42scriptalertexamplecomfree")
        XCTAssertLessThanOrEqual(visible.count, 32)
        XCTAssertFalse(visible.contains("@"))
        XCTAssertFalse(visible.contains(" "))
        XCTAssertFalse(visible.contains("/"))
    }

    func testDiagnosticSessionLabelNeverUsesStoragePath() {
        let label = SessionLabel.label(sessionStartMs: 1_700_000_000_000, nowMs: 1_700_000_100_000, isNewest: true)
        XCTAssertEqual(label, "This session")
        XCTAssertFalse(label.contains("/"))
    }

    @MainActor
    func testOwnedStateAlphabetsIncludeAppliedAndFailClosedAccess() {
        XCTAssertEqual(MemoryViewModel.Save.applied, .applied)
        XCTAssertEqual(AudioViewModel.Save.applied, .applied)
        XCTAssertEqual(ModelViewModel.Save.applied, .applied)
        XCTAssertEqual(ToolsViewModel.Save.applied, .applied)
        XCTAssertEqual(SystemPromptViewModel.Save.applied, .applied)
        XCTAssertEqual(AdvancedViewModel.Save.applied, .applied)
        XCTAssertEqual(PersonalitiesViewModel.Op.applied, .applied)
        XCTAssertFalse(SettingsRootViewModel.AccessState.loading.isAdmin)
        XCTAssertFalse(SettingsRootViewModel.AccessState.failed.isAdmin)
        XCTAssertTrue(SettingsRootViewModel.AccessState.ready(isAdmin: true, fishBrowseEnabled: false).isAdmin)
    }
}
