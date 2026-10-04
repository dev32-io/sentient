// Synthetic app host for PendingRecoveryConsumerTests. Compiled only into a
// disposable fixture target. No accounts, platform transport, credentials or services.
#if NC_PENDING_FIXTURE
import MobileData
import SwiftUI
import UIKit

@main
final class PendingRecoveryFixtureApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIHostingController(rootView: PendingRecoveryFixtureView())
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

private struct PendingRecoveryFixtureView: View {
    @StateObject private var harness = PendingRecoveryHarness()
    var body: some View {
        VStack(spacing: 0) {
            Text(harness.status).font(.caption).accessibilityIdentifier("pending-fixture-status")
            if let vm = harness.vm, let fixture = harness.fixture {
                ChatView(makeVM: { vm }, makeHistoryVM: { HistoryViewModel(component: fixture.component) },
                    userName: "Fixture", activeSessionId: "history-session", activeDraftId: nil,
                    beginNavigation: { nil }, isNavigationCurrent: { _ in false },
                    onSelectSession: { _ in }, onSelectDraft: { _, _ in }, onNewChat: {},
                    onOpenSettings: {}, onOpenInbox: {}, onLogout: {})
                    .environment(\.sentientIdentityPlaybackEnabled, false)
            }
        }
        .environment(\.horizontalSizeClass, .compact)
        .transaction { $0.animation = nil; $0.disablesAnimations = true }
        .task { await harness.run() }
    }
}

@MainActor
private final class PendingRecoveryHarness: ObservableObject {
    @Published var status = "preparing"
    @Published var vm: ChatViewModel?
    var fixture: NativeSendBridgeFixture?
    private var admissions: [String] = []

    func run() async {
        let mode = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--pending-recovery=") }?
            .split(separator: "=").last.map(String.init) ?? "edit-empty"
        let fixture = NativeSendBridgeFixture()
        self.fixture = fixture
        do {
            try await fixture.connect()
            let vm = ChatViewModel(component: fixture.component, sessionId: "history-session",
                cancelPendingSend: { [weak self] pending in
                    self?.admissions.append(pending.pendingId)
                    guard let restored = try await fixture.drafts.notCommittedIfEmpty(pendingId: pending.pendingId) else {
                        throw ProbeFailure.boundary("admission-empty-editor")
                    }
                    return restored
                })
            self.vm = vm
            defer { vm.retireEditor() }
            try await fixture.acknowledgeRoute(sessionId: "history-session")
            // Fixture has no REST client. Feed actual SDK timeline, rather than
            // overriding VM loading state or leaving a no-client empty-history gate.
            try await fixture.receipt(pendingId: "synthetic-history", sessionId: "history-session")
            try await wait("history") { !vm.state.historyLoading && !vm.state.model.committed.isEmpty }
            try await importFile(vm, name: "accepted.txt")
            let first = try await accept(vm, fixture: fixture, text: "accepted", count: 1)
            let file = first.attachments[0]
            try await wait("upload") { try await fixture.uploadedFileIds().count == 1 }
            if mode != "cancel" {
                try await fixture.releaseUpload(index: 0, success: false)
                try await wait("upload-failure") { vm.attachmentTransfers[file.id]?.phase == .failed }
            }
            if mode != "edit-empty" {
                if mode == "cancel" { try await importFile(vm, name: "waiting.txt") }
                _ = try await accept(vm, fixture: fixture, text: "later FIFO item", count: 2)
                if mode == "edit-occupied" { try await importFile(vm, name: "successor.txt") }
                vm.updateDraft("independent successor")
                try require(await vm.saveDraftBeforeNavigation(), "save-successor")
            }
            let beforeText = vm.draftText
            let beforeFiles = vm.draftAttachments.map(\.id)
            let beforePending = fixture.drafts.snapshot.value.pendingSends.map(\.pendingId)
            try require(mode == "edit-occupied" || vm.draftAttachments.isEmpty, "frozen-composer-separation")
            status = "ready:\(mode)"
            if mode == "edit-empty" {
                try await wait("ui-edit-restores", seconds: 15) {
                    vm.draftText == "accepted" && vm.draftAttachments.map(\.id) == [file.id]
                }
                try require(admissions == [first.pendingId], "own-admission")
                try require(fixture.drafts.snapshot.value.pendingSends.isEmpty, "restored-queue")
            } else {
                if mode == "cancel" {
                    // UI cancel blocks owning head immediately; adapter completes late.
                    try await wait("ui-cancel", seconds: 15) { vm.pendingMessages.first?.status == .failed }
                    try await fixture.releaseUpload(index: 0, success: true)
                    try await wait("late-adapter") { vm.attachmentTransfers[file.id]?.phase != .uploading }
                    let uploaded = try await fixture.uploadedFileIds()
                    try require(uploaded == [file.id], "own-upload-only")
                } else {
                    try await wait("ui-edit-guidance", seconds: 15) {
                        vm.draftSaveError == "Save or send current draft before editing a queued message."
                    }
                }
                try require(admissions.isEmpty, "no-server-retraction")
                try require(vm.draftText == beforeText && vm.draftAttachments.map(\.id) == beforeFiles, "successor-preserved")
                try require(fixture.drafts.snapshot.value.pendingSends.map(\.pendingId) == beforePending, "pending-identities")
                try require(fixture.drafts.snapshot.value.pendingSends.dropFirst().allSatisfy { !$0.attempted }, "fifo-head-blocks")
            }
            let sent = try await fixture.sentPendingIds()
            try require(sent.isEmpty, "no-dispatch")
            status = "passed:\(mode)"
        } catch {
            status = "failed:\(error)"
        }
        try? await fixture.close()
    }

    private func importFile(_ vm: ChatViewModel, name: String) async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
        try Data("synthetic".utf8).write(to: url)
        vm.importAttachments([.temporary(url, displayName: name, mediaType: "text/plain")])
        try await wait("import") { vm.draftAttachments.count == 1 && vm.pendingAttachmentImportCount == 0 }
    }

    private func accept(_ vm: ChatViewModel, fixture: NativeSendBridgeFixture, text: String, count: Int) async throws -> NativePendingSend {
        vm.updateDraft(text)
        vm.send(text)
        try await wait("accept") { !vm.preparingSend && vm.draftText.isEmpty && fixture.drafts.snapshot.value.pendingSends.count == count }
        return fixture.drafts.snapshot.value.pendingSends.last!
    }

    private func wait(_ boundary: String, seconds: Int = 3, _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            await Task.yield()
        }
        throw ProbeFailure.boundary(boundary)
    }
    private func require(_ condition: Bool, _ boundary: String) throws {
        if !condition { throw ProbeFailure.boundary(boundary) }
    }
    private enum ProbeFailure: Error { case boundary(String) }
}
#endif
