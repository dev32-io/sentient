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

    @MainActor
    func testPushSettingsQueuesImmediateToggleIntents() async {
        let service = FakePushSettingsService(binding: pushSettingsBinding(revision: 1))
        let viewModel = PushNotificationsViewModel(useCases: service)
        await viewModel.start(binding: pushSettingsBinding(revision: 1))

        viewModel.setEnabled(false)
        viewModel.setPreview(.content)
        XCTAssertTrue(viewModel.isSaving)
        await service.waitForPatchCount(2)

        XCTAssertEqual(service.patchRevisions, [1, 2])
        XCTAssertEqual(viewModel.binding?.preferences.revision, 3)
        XCTAssertEqual(viewModel.binding?.preferences.enabled, false)
        XCTAssertEqual(viewModel.binding?.preferences.previewMode, .content)
        XCTAssertFalse(viewModel.isSaving)
        XCTAssertNil(viewModel.saveError)
    }

    @MainActor
    func testPushSettingsConflictStopsQueueAndRetryPreservesIntentOrder() async {
        let service = FakePushSettingsService(binding: pushSettingsBinding(revision: 1), conflictOnFirstEnable: true)
        let viewModel = PushNotificationsViewModel(useCases: service)
        await viewModel.start(binding: pushSettingsBinding(revision: 1))

        viewModel.setEnabled(false)
        viewModel.setPreview(.content)
        await service.waitForPatchCount(1)
        while viewModel.isSaving { await Task.yield() }

        XCTAssertEqual(service.patchRevisions, [1])
        XCTAssertNotNil(viewModel.saveError)
        XCTAssertEqual(viewModel.binding?.preferences.revision, 2)
        XCTAssertEqual(viewModel.binding?.preferences.enabled, true)
        XCTAssertEqual(viewModel.binding?.preferences.previewMode, .hidden)

        viewModel.setEnabled(true)
        XCTAssertEqual(service.patchRevisions, [1])
        XCTAssertNotNil(viewModel.saveError)

        viewModel.retrySave()
        await service.waitForPatchCount(3)
        while viewModel.isSaving { await Task.yield() }

        XCTAssertEqual(service.patchRevisions, [1, 2, 3])
        XCTAssertEqual(viewModel.binding?.preferences.revision, 4)
        XCTAssertEqual(viewModel.binding?.preferences.enabled, false)
        XCTAssertEqual(viewModel.binding?.preferences.previewMode, .content)
        XCTAssertNil(viewModel.saveError)
    }
}

@MainActor
private final class FakePushSettingsService: PushSettingsServicing {
    var currentBinding: SentientResult<PushBinding>
    private(set) var patchRevisions: [Int32] = []
    private var patchWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var conflictOnFirstEnable: Bool

    init(binding: PushBinding, conflictOnFirstEnable: Bool = false) {
        currentBinding = SentientResultSuccess(data: binding)
        self.conflictOnFirstEnable = conflictOnFirstEnable
    }

    func load(installationId: String) async throws -> SentientResult<PushBinding> { currentBinding }

    func saveEnabled(binding: PushBinding, enabled: Bool) async throws -> PushSettingsMutationResult {
        if conflictOnFirstEnable {
            conflictOnFirstEnable = false
            patchRevisions.append(binding.preferences.revision)
            currentBinding = SentientResultSuccess(data: pushSettingsBinding(revision: binding.preferences.revision + 1))
            resumePatchWaiters()
            return .failure("conflict")
        }
        return .success(acknowledge(binding, enabled: enabled, preview: binding.preferences.previewMode))
    }

    func savePreview(binding: PushBinding, mode: PushPreviewMode) async throws -> PushSettingsMutationResult {
        .success(acknowledge(binding, enabled: binding.preferences.enabled, preview: mode))
    }

    func observeBinding(_ receive: @escaping @MainActor (SentientResult<PushBinding>) -> Void) -> Task<Void, Never> {
        Task {}
    }

    func waitForPatchCount(_ count: Int) async {
        guard patchRevisions.count < count else { return }
        await withCheckedContinuation { patchWaiters.append((count, $0)) }
    }

    private func acknowledge(_ binding: PushBinding, enabled: Bool, preview: PushPreviewMode) -> PushBinding {
        patchRevisions.append(binding.preferences.revision)
        let acknowledged = pushSettingsBinding(
            revision: binding.preferences.revision + 1,
            enabled: enabled,
            preview: preview
        )
        currentBinding = SentientResultSuccess(data: acknowledged)
        resumePatchWaiters()
        return acknowledged
    }

    private func resumePatchWaiters() {
        let ready = patchWaiters.filter { patchRevisions.count >= $0.0 }
        patchWaiters.removeAll { patchRevisions.count >= $0.0 }
        ready.forEach { $0.1.resume() }
    }
}

private func pushSettingsBinding(
    revision: Int32,
    enabled: Bool = true,
    preview: PushPreviewMode = .hidden
) -> PushBinding {
    PushBinding(
        bindingId: "binding",
        installationId: "installation",
        platform: "ios",
        generation: 1,
        state: .active,
        replaces: nil,
        preferences: PushPreferences(enabled: enabled, previewMode: preview, revision: revision),
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
    )
}
