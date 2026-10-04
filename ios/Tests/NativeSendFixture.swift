import Foundation
import MobileData
import Testing
@testable import SentientApp

/// Fail at causal boundary rather than hanging in a continuation or waiting for suite timeout.
@MainActor
func sendEventually(
    _ label: String,
    _ condition: @escaping @MainActor () async throws -> Bool
) async throws {
    let deadline = ContinuousClock.now + .seconds(3)
    while ContinuousClock.now < deadline {
        if try await condition() { return }
        await Task.yield()
    }
    Issue.record("Native send boundary timed out: \(label)")
    throw NativeSendWaitExpired(boundary: label)
}

private struct NativeSendWaitExpired: Error { let boundary: String }

@MainActor
func withNativeSendFixture(_ body: @MainActor (NativeSendBridgeFixture) async throws -> Void) async throws {
    let fixture = NativeSendBridgeFixture()
    do {
        try await fixture.connect()
        try await body(fixture)
        try await fixture.close()
    } catch {
        try? await fixture.close()
        throw error
    }
}

@MainActor
func acceptFixtureFile(_ fixture: NativeSendBridgeFixture, text: String) async throws -> NativePendingSend {
    let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("one".utf8).write(to: source)
    defer { try? FileManager.default.removeItem(at: source) }
    let draft = try await fixture.drafts.importAttachment(
        draftId: nil, sessionId: "history-session",
        source: NativeDraftAttachmentImport(sourceLocation: source.absoluteString,
            displayName: "fixture.txt", mediaType: "text/plain", previewSourceLocation: nil))
    let saved = try #require(try await fixture.drafts.saveText(draftId: draft.id, sessionId: draft.sessionId, text: text))
    return try await fixture.drafts.acceptSend(draftId: saved.id, expectedRevision: saved.revision,
        mintKey: "fixture-mint", surfaceId: "fixture-device")
}
