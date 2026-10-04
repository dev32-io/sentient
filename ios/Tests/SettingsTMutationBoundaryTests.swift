import Testing
import Foundation
@testable import SentientApp
#if canImport(MobileData)
import MobileData
#endif

struct SettingsTMutationBoundaryTests {
    @Test func sharedApplyAvailabilityAndRetryCopy() {
        for state in [DesignApplyState.saving, .restarting] {
            #expect(!state.canDiscard(isDirty: true))
            #expect(!state.canApply(isDirty: true))
            #expect(state.isBusy)
        }
        for state in [DesignApplyState.idle, .failed("Failure"), .alreadyApplying, .applied] {
            #expect(state.canDiscard(isDirty: true))
            #expect(state.canApply(isDirty: true))
            #expect(!state.canDiscard(isDirty: false))
            #expect(!state.canApply(isDirty: false))
        }
        #expect(DesignApplyState.failed("Failure").actionTitle(isDirty: true) == "Retry")
        #expect(DesignApplyState.alreadyApplying.actionTitle(isDirty: true) == "Retry")
        #expect(DesignApplyState.applied.actionTitle(isDirty: false) == "Applied")
    }

#if canImport(MobileData)
    @Test @MainActor func profileSavesPreserveEveryUneditedFieldIncludingMemory() async {
        for spark in [false, true] {
            for dreaming in [false, true] {
                let original = ProfileV1(
                    schemaVersion: 1, userId: "disposable-profile",
                    model: ProfileModelRef(provider: "custom", id: "chat"),
                    voice: ProfileVoiceRef(provider: "local-tts", id: "voice"),
                    audio: ProfileAudio(ttsEnabled: false, channel: "text"),
                    persona: ProfilePersona(template: "default", overrides: "Disposable persona"),
                    tools: ProfileTools(permissions: ["server": ["tool": ToolPermission.off]], toolsets: ["memory"]),
                    compression: ProfileCompression(threshold: 0.6),
                    advanced: ProfileAdvanced(extraSystemPrompt: "Disposable prompt", maxTokens: 1024, reasoningEffort: "low"),
                    auxiliaryModels: ProfileAuxiliaryModels(
                        title: ProfileModelRef(provider: "custom", id: "title"),
                        dreamer: ProfileModelRef(provider: "custom", id: "dreamer"),
                        attachmentVision: ProfileModelRef(provider: "custom", id: "vision")
                    ),
                    memory: ProfileMemory(spark: spark, dreaming: dreaming)
                )
                let load: () async throws -> SentientResult<ProfileV1> = { SentientResultSuccess(data: original) }
                var writes: [ProfileMutationPutProfile] = []
                let record: (ProfileMutationPutProfile, (any ApplyState) async -> Void) async -> Void = { mutation, _ in
                    writes.append(mutation)
                }
                let audio = AudioViewModel(loadProfile: load, applyProfile: record)
                await audio.load(); audio.ttsEnabled = true; await audio.save()
                let advanced = AdvancedViewModel(loadProfile: load, applyProfile: record, applyOnly: { _ in Issue.record("Unexpected apply-only") })
                await advanced.load(); advanced.maxTokens = 2048; await advanced.save()
                let model = ModelViewModel(loadProfile: load,
                    loadModels: { SentientResultSuccess(data: ModelCatalog(models: [], stale: false)) }, applyProfile: record, applyOnly: { _ in Issue.record("Unexpected apply-only") })
                await model.load(); model.selectAuxiliary(nil, for: .title)
                await model.save()
                let tools = ToolsViewModel(loadProfile: load,
                    loadCatalog: { SentientResultSuccess(data: McpCatalogView(groups: [:], wildcardPermissionKey: "*", hermesBuiltins: [])) },
                    applyProfile: record, applyOnly: { _ in Issue.record("Unexpected apply-only") })
                await tools.load(); tools.setToolPermission("server", "tool", .ask); await tools.save()
                #expect(writes.count == 4)
                for (index, write) in writes.enumerated() {
                    let next = write.next
                    let expected = ProfileV1PutBody(
                        schemaVersion: original.schemaVersion, userId: original.userId,
                        model: original.model, voice: original.voice,
                        audio: index == 0 ? ProfileAudio(ttsEnabled: true, channel: "text") : original.audio,
                        persona: original.persona,
                        tools: ProfileToolsPatch(
                            permissions: ["server": ["tool": index == 3 ? ToolPermission.ask : ToolPermission.off]],
                            toolsets: original.tools.toolsets
                        ),
                        compression: original.compression,
                        advanced: index == 1 ? ProfileAdvanced(extraSystemPrompt: "Disposable prompt", maxTokens: 2048, reasoningEffort: "low") : original.advanced,
                        auxiliaryModels: index == 2 ? ProfileAuxiliaryModels(
                            title: nil,
                            dreamer: original.auxiliaryModels?.dreamer,
                            attachmentVision: original.auxiliaryModels?.attachmentVision
                        ) : original.auxiliaryModels,
                        memory: original.memory
                    )
                    #expect(write.previous.isEqual(original))
                    #expect(next.isEqual(expected), "Profile save \(index) must preserve unrelated fields (\(spark)/\(dreaming))")
                }
            }
        }
    }

    @Test func secretFieldsStayMaskedWhileRetryingOrDisabled() {
        let placeholder = "disposable-placeholder"
        #expect(DesignMaskedField.accessibilityValue(text: placeholder, isEnabled: true, error: nil) == "Value entered")
        #expect(DesignMaskedField.accessibilityValue(text: placeholder, isEnabled: false, error: nil) == "Disabled")
    }

    @Test @MainActor func delayedDocumentWriteRetainsDraftAndRejectsDuplicateAndDiscard() async {
        let gate = SettingsTGate()
        var saved = "Original"
        var calls = 0
        var succeed = false
        let vm = SystemPromptViewModel(
            loadSoul: { SentientResultSuccess(data: SoulDoc(content: saved, lastModified: nil)) },
            loadDefault: { throw SettingsTFault.unavailable },
            applySoul: { content, receive in
                calls += 1
                await receive(ApplyStateSaving.shared)
                await gate.hold()
                await receive(ApplyStateRestarting.shared)
                await gate.hold()
                if succeed {
                    saved = content
                    await receive(ApplyStateReady(elapsedMs: 0))
                } else {
                    await receive(ApplyStateFailed(error: SentientError.Unknown(userMessage: "Failure", cause: nil)))
                }
            }
        )
        await vm.load()
        vm.draft = "Disposable draft"
        vm.discard()
        #expect(vm.draft == "Original")
        #expect(!vm.isDirty)
        vm.draft = "Disposable draft"
        let first = Task { await vm.save() }
        await gate.waitForHold(1)
        #expect(vm.save == .saving)
        vm.discard()
        await vm.save()
        #expect(calls == 1)
        #expect(vm.draft == "Disposable draft")
        gate.release()
        await gate.waitForHold(2)
        #expect(vm.save == .restarting)
        vm.discard()
        #expect(vm.isDirty)
        gate.release()
        await first.value
        #expect(vm.save == .failed("Failure"))
        #expect(vm.draft == "Disposable draft")
        await vm.restoreDefault()
        #expect(vm.draft == "Disposable draft")
        #expect(vm.restoreError != nil)
        #expect(vm.save == .failed("Failure"))
        succeed = true
        let retry = Task { await vm.save() }
        await gate.waitForHold(3)
        gate.release()
        await gate.waitForHold(4)
        gate.release()
        await retry.value
        #expect(calls == 2)
        #expect(vm.save == .applied)
        #expect(!vm.isDirty)
        #expect(vm.draft == saved)
    }

    @Test @MainActor func alreadyApplyingPreservesDocumentRetryTarget() async {
        let vm = SystemPromptViewModel(
            loadSoul: { SentientResultSuccess(data: SoulDoc(content: "Original", lastModified: nil)) },
            loadDefault: { throw SettingsTFault.unavailable },
            applySoul: { _, receive in await receive(ApplyStateAlreadyApplying.shared) }
        )
        await vm.load()
        vm.draft = "Disposable draft"
        await vm.save()
        #expect(vm.save == .alreadyApplying)
        #expect(vm.isDirty)
        #expect(vm.draft == "Disposable draft")
        vm.discard()
        #expect(vm.draft == "Original")
    }

    @Test @MainActor func memoryDiscardResetsBothSlotsAndPartialSuccessCannotBeUndone() async {
        var memory = "Original memory"
        let user = "Original user"
        var reloadFails = false
        var written: [MemorySlot] = []
        let vm = MemoryViewModel(
            loadMemory: { slot in
                if reloadFails && slot == .memory { throw SettingsTFault.unavailable }
                return SentientResultSuccess(data: MemoryDoc(
                    content: slot == .memory ? memory : user, lastModified: nil, charLimit: 4000
                ))
            },
            applyMemory: { slot, content, receive in
                written.append(slot)
                await receive(ApplyStateSaving.shared)
                await receive(ApplyStateRestarting.shared)
                if slot == .memory {
                    memory = content
                    reloadFails = true
                    await receive(ApplyStateReady(elapsedMs: 0))
                } else {
                    await receive(ApplyStateFailed(error: SentientError.Unknown(userMessage: "Failure", cause: nil)))
                }
            }
        )
        await vm.loadIfNeeded(.memory)
        await vm.loadIfNeeded(.user)
        vm.setDraft("Memory draft", for: .memory)
        vm.setDraft("User draft", for: .user)
        vm.discard()
        #expect(vm.state(for: .memory).draft == memory)
        #expect(vm.state(for: .user).draft == user)
        vm.setDraft("Memory draft", for: .memory)
        vm.setDraft("User draft", for: .user)
        await vm.save()
        #expect(written == [.memory])
        #expect(!vm.state(for: .memory).isDirty)
        #expect(vm.state(for: .user).isDirty)
        vm.discard()
        #expect(vm.state(for: .memory).draft == "Memory draft")
        #expect(vm.state(for: .user).draft == user)
        #expect(!vm.isDirty)
    }

    @Test @MainActor func memorySecondSlotFailureRetriesOnlyUnacknowledgedSlot() async {
        var contents = ["memory": "Original memory", "user": "Original user"]
        var written: [MemorySlot] = []
        var failUser = true
        let vm = MemoryViewModel(loadMemory: { slot in
            SentientResultSuccess(data: MemoryDoc(content: contents[slot == .memory ? "memory" : "user"]!, lastModified: nil, charLimit: 4000))
        }, applyMemory: { slot, content, receive in
            written.append(slot)
            if slot == .user && failUser {
                await receive(ApplyStateFailed(error: SentientError.Unknown(userMessage: "Failure", cause: nil)))
            } else {
                contents[slot == .memory ? "memory" : "user"] = content
                await receive(ApplyStateReady(elapsedMs: 0))
            }
        })
        await vm.loadIfNeeded(.memory); await vm.loadIfNeeded(.user)
        vm.setDraft("Memory draft", for: .memory); vm.setDraft("User draft", for: .user)
        await vm.save()
        #expect(written == [.memory, .user])
        #expect(!vm.memoryState.isDirty && vm.userState.isDirty)
        #expect(vm.save == .failed("Failure"))
        failUser = false
        await vm.save()
        #expect(written == [.memory, .user, .user])
        #expect(vm.save == .applied && !vm.isDirty)
    }

    @Test @MainActor func voiceBusyAssignmentsDoNotRecurseOrChangeSubmittedMetadata() async {
        let gate = SettingsTGate()
        var creates = 0
        let player = SettingsTBoundaryPlayer()
        let vm = VoiceAddViewModel(recorder: SettingsTBoundaryRecorder(), player: player,
            permission: SettingsTBoundaryPermission(), settingsOpener: SettingsTBoundaryOpener(),
            createVoice: { name, _, description, tags, language in
                creates += 1
                #expect(name == "Disposable" && description == "Description" && tags == ["Calm"] && language == "en")
                await gate.hold()
                return SentientResultSuccess(data: VoiceCreateResult(voiceId: "fixture", name: name, warning: nil))
            })
        vm.onRecordTapped(); vm.stopRecording()
        vm.name = "Disposable"; vm.description = "Description"; vm.tags = ["Calm"]; vm.language = "en"
        vm.submit(); await gate.waitForHold(1)
        vm.name = "Blocked"; vm.description = "Blocked"; vm.tags = []; vm.language = "zh"
        vm.selectMode(.upload); vm.reRecord(); vm.submit()
        #expect(creates == 1 && vm.name == "Disposable" && vm.description == "Description" && vm.tags == ["Calm"] && vm.language == "en")
        #expect(vm.mode == .record && vm.audioData != nil)
        gate.release()
        let deadline = Date().addingTimeInterval(3)
        while vm.submitting && Date() < deadline { await Task.yield() }
        #expect(!vm.submitting && vm.done)

        var clones = 0
        let fish = VoiceFishViewModel(browse: { _, _ in FishResultSuccess(value: FishVoicePage(voices: [], hasMore: false, stale: false)) },
            cloneVoice: { _, request in
                clones += 1
                #expect(request.name == "Disposable" && request.language == "en")
                await gate.hold()
                return FishResultSuccess(value: CloneFromFishResult(voiceId: "fixture", name: request.name, warning: nil))
            }, player: player)
        let entry = FishVoiceEntry(id: "fixture", title: "Disposable", description: "", languages: ["en"], tags: [], coverImageUrl: nil, previewAudioUrl: nil, visibility: "public", taskCount: 0, createdAt: "2026-01-01")
        fish.select(entry); fish.clone(); await gate.waitForHold(2)
        fish.cloneName = "Blocked"; fish.cloneLanguage = "zh"; fish.cancelSelect(); fish.clone()
        #expect(clones == 1 && fish.cloneName == "Disposable" && fish.cloneLanguage == "en" && fish.selected === entry)
        gate.release()
        let cloneDeadline = Date().addingTimeInterval(3)
        while fish.cloning && Date() < cloneDeadline { await Task.yield() }
        #expect(!fish.cloning && fish.done)
    }

    @Test @MainActor func secretsFreezeSubmittedEditorAndRetryWithoutDuplicateOrUnrelatedClose() async {
        let gate = SettingsTGate()
        var calls = 0
        var succeed = false
        let vm = SecretsViewModel(
            loadStatus: { throw SettingsTFault.unavailable },
            writeKey: { _, _, _ in
                calls += 1
                await gate.hold()
                if !succeed { throw SettingsTFault.unavailable }
                return SentientResultSuccess(data: KotlinUnit.shared)
            },
            writeActive: { _ in SentientResultSuccess(data: KotlinUnit.shared) }
        )
        vm.startEditKey(.openrouter)
        let first = Task { await vm.saveKey(.openrouter, value: "disposable-placeholder") }
        await gate.waitForHold(1)
        #expect(vm.isSavingKey)
        vm.cancelEdit()
        vm.startEditBaseUrl()
        vm.startEditKey(.custom)
        await vm.saveKey(.openrouter, value: "disposable-placeholder")
        await vm.saveBaseUrl("https://example.invalid")
        await vm.setActive(.custom)
        #expect(calls == 1)
        #expect(vm.editing == .key(.openrouter))
        gate.release()
        await first.value
        #expect(vm.editing == .key(.openrouter))
        #expect(vm.mutationError != nil)
        #expect(!vm.isSavingKey)
        succeed = true
        let retry = Task { await vm.saveKey(.openrouter, value: "disposable-placeholder") }
        await gate.waitForHold(2)
        gate.release()
        await retry.value
        #expect(calls == 2)
        #expect(vm.editing == .none)
        vm.startEditBaseUrl()
        await vm.setActive(.custom)
        #expect(vm.editing == .customBaseUrl)
        await vm.saveKey(.openrouter, value: "disposable-placeholder")
        #expect(calls == 2)
    }
#endif
}

#if canImport(MobileData)
private enum SettingsTFault: Error { case unavailable }

@MainActor
private final class SettingsTGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var holdCount = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func hold() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            holdCount += 1
            let ready = waiters.filter { $0.0 <= holdCount }
            waiters.removeAll { $0.0 <= holdCount }
            ready.forEach { $0.1.resume() }
        }
    }

    func waitForHold(_ count: Int) async {
        guard holdCount < count else { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }

    func release() {
        let current = continuation
        continuation = nil
        current?.resume()
    }
}
#endif

#if canImport(MobileData)
@MainActor private final class SettingsTBoundaryRecorder: VoiceRecording {
    func start() throws {}
    func stop() -> URL? { nil }
    func recordedData() -> Data? { Data([1]) }
    func discard() {}
}
@MainActor private final class SettingsTBoundaryPlayer: VoiceSamplePlaying {
    var onFinished: (@MainActor () -> Void)?
    func playData(_ data: Data) throws {}
    func playRemote(_ url: URL) { preconditionFailure("Network not authorized") }
    func stop() {}
}
@MainActor private struct SettingsTBoundaryPermission: VoicePermissionProviding {
    func status() -> VoiceMicrophonePermission { .granted }
    func request(_ completion: @escaping (Bool) -> Void) { preconditionFailure("Microphone prompt not authorized") }
}
@MainActor private struct SettingsTBoundaryOpener: VoiceSettingsOpening { func openMicrophoneSettings() {} }
#endif

#if canImport(MobileData)
/// Actual native consumer -> shared ApplyProfileChangeUseCase -> synthetic repository.
/// Unlike document/UI fixtures, PUT commits before Restarting, regardless of Apply outcome.
struct ProfileApplyPersistenceTests {
    @Test(arguments: ["failed", "429", "network"])
    @MainActor func advancedDiscardNeverRollsBackCommittedProfile(outcome: String) async {
        let boundary = ProfileApplyBoundary(outcome)
        let vm = AdvancedViewModel(loadProfile: boundary.read, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load()
        vm.maxTokens = 2048
        await vm.save()
        #expect(boundary.fixture.stored.advanced.maxTokens == 2048)
        let failure = vm.save
        vm.discard()
        #expect(vm.maxTokens == 2048)
        #expect(vm.save == failure && vm.hasPendingApply)
        // No edit/save/discard may use the stale original, even if refetch fails.
        boundary.fixture.failRead = true
        await vm.load(); vm.discard(); await vm.save(); await vm.retryApply()
        #expect(boundary.fixture.putCalls == 1 && boundary.fixture.applyCalls == 1)
        #expect(vm.save == failure)
        boundary.fixture.failRead = false
        await vm.load()
        #expect(vm.maxTokens == 2048 && !vm.isDirty)
        vm.maxTokens = 3072
        vm.discard()
        #expect(vm.maxTokens == 2048 && vm.save == failure)
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        await vm.retryApply()
        #expect(vm.save == .applied && !vm.hasPendingApply)
        #expect(boundary.fixture.putCalls == 1 && boundary.fixture.applyCalls == 2)
    }

    @Test(arguments: ["failed", "429", "network"])
    @MainActor func modelAndAuxiliaryDiscardUseConfirmedBaseline(outcome: String) async {
        let boundary = ProfileApplyBoundary(outcome)
        let vm = ModelViewModel(loadProfile: boundary.read,
            loadModels: { SentientResultSuccess(data: ModelCatalog(models: [], stale: false)) },
            applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load()
        vm.select(ProfileApplyBoundary.model("new-chat"))
        vm.selectAuxiliary(ProfileApplyBoundary.model("new-title"), for: .title)
        await vm.save()
        let failure = vm.save
        vm.discard()
        #expect(vm.draftModelId == "new-chat" && vm.titleModel?.id == "new-title")
        #expect(vm.save == failure && vm.hasPendingApply)
        boundary.fixture.failRead = true
        await vm.load(); vm.discard(); await vm.save()
        #expect(boundary.fixture.putCalls == 1)
        boundary.fixture.failRead = false
        await vm.load()
        vm.select(ProfileApplyBoundary.model("uncommitted"))
        vm.selectAuxiliary(nil, for: .title)
        vm.discard()
        #expect(vm.draftModelId == "new-chat" && vm.titleModel?.id == "new-title")
        #expect(vm.save == failure && !vm.isDirty)
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        await vm.retryApply()
        #expect(vm.save == .applied && boundary.fixture.putCalls == 1 && boundary.fixture.applyCalls == 2)
    }

    @Test(arguments: ["failed", "429", "network"])
    @MainActor func toolsDiscardCannotHidePersistedAllowOrWriteRollback(outcome: String) async {
        let boundary = ProfileApplyBoundary(outcome)
        let vm = ToolsViewModel(loadProfile: boundary.read, loadCatalog: boundary.catalog,
                                applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load()
        vm.setToolPermission("synthetic", "tool", .allow)
        vm.setCubePermission("tool", .allow)
        await vm.save()
        #expect(boundary.fixture.stored.tools.permissions?["synthetic"]?["tool"] == .allow)
        #expect(boundary.fixture.stored.tools.permissions?["cube"]?["tool"] == .allow)
        let failure = vm.save
        vm.discard()
        #expect(boundary.displayedPermission(vm) == .allow)
        #expect(vm.cubePermission("tool") == .allow)
        #expect(vm.save == failure)
        boundary.fixture.failRead = true
        await vm.load(); vm.discard(); await vm.save()
        #expect(boundary.fixture.putCalls == 1)
        boundary.fixture.failRead = false
        boundary.failCatalog = true
        await vm.load(); vm.discard(); await vm.save()
        #expect(boundary.fixture.putCalls == 1 && vm.save == failure)
        boundary.failCatalog = false
        await vm.load()
        #expect(!vm.isDirty && boundary.displayedPermission(vm) == .allow)
        vm.setToolPermission("synthetic", "tool", .allow)
        await vm.save()
        #expect(!vm.isDirty && vm.save == failure && boundary.fixture.putCalls == 1)
        vm.setToolPermission("synthetic", "tool", .off)
        vm.setCubePermission("tool", .off)
        vm.discard()
        #expect(boundary.displayedPermission(vm) == .allow && vm.cubePermission("tool") == .allow)
        #expect(vm.save == failure && boundary.fixture.putCalls == 1)
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        await vm.retryApply()
        #expect(vm.save == .applied && boundary.fixture.putCalls == 1 && boundary.fixture.applyCalls == 2)
    }

    @Test @MainActor func nextAdvancedEditUsesCommittedBaselineNotPrePUTOriginal() async {
        let boundary = ProfileApplyBoundary("failed")
        let vm = AdvancedViewModel(loadProfile: boundary.read, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load(); vm.maxTokens = 2048; await vm.save(); await vm.load()
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        vm.extraSystemPrompt = "Synthetic new edit"
        await vm.save()
        #expect(boundary.mutations[1].previous.advanced.maxTokens == 2048)
        #expect(boundary.fixture.stored.advanced.maxTokens == 2048)
        #expect(boundary.fixture.stored.advanced.extraSystemPrompt == "Synthetic new edit")
        #expect(boundary.fixture.putCalls == 2 && boundary.fixture.applyCalls == 2 && vm.save == .applied)
    }

    @Test @MainActor func nextModelEditPreservesCommittedChatAndAuxiliarySelection() async {
        let boundary = ProfileApplyBoundary("429")
        let vm = ModelViewModel(loadProfile: boundary.read,
            loadModels: { SentientResultSuccess(data: ModelCatalog(models: [], stale: false)) },
            applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load(); vm.select(ProfileApplyBoundary.model("committed-chat"))
        vm.selectAuxiliary(ProfileApplyBoundary.model("committed-title"), for: .title)
        await vm.save(); await vm.load()
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        vm.selectAuxiliary(ProfileApplyBoundary.model("new-dreamer"), for: .dreamer)
        await vm.save()
        #expect(boundary.mutations[1].previous.model.id == "committed-chat")
        #expect(boundary.fixture.stored.model.id == "committed-chat")
        #expect(boundary.fixture.stored.auxiliaryModels?.title?.id == "committed-title")
        #expect(boundary.fixture.stored.auxiliaryModels?.dreamer?.id == "new-dreamer")
        #expect(boundary.fixture.putCalls == 2 && boundary.fixture.applyCalls == 2 && vm.save == .applied)
    }

    @Test @MainActor func nextToolsEditPreservesCommittedAllowWithoutImplicitPermissionWrite() async {
        let boundary = ProfileApplyBoundary("network")
        let vm = ToolsViewModel(loadProfile: boundary.read, loadCatalog: boundary.catalog,
                                applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load(); vm.setToolPermission("synthetic", "tool", .allow)
        await vm.save(); await vm.load()
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        vm.toggleToolset("memory"); await vm.save()
        #expect(boundary.mutations[1].previous.tools.permissions?["synthetic"]?["tool"] == .allow)
        #expect(boundary.fixture.stored.tools.permissions?["synthetic"]?["tool"] == .allow)
        #expect(boundary.fixture.stored.tools.permissions?["cube"]?["tool"] == .off)
        #expect(boundary.fixture.stored.tools.toolsets == ["memory"])
        #expect(boundary.fixture.putCalls == 2 && boundary.fixture.applyCalls == 2 && vm.save == .applied)
    }

    @Test @MainActor func untouchedNullableToolsDoNotInventPendingWrites() async {
        let base = ProfileApplyBoundary("failed").fixture.stored
        let profile = ProfileV1(schemaVersion: base.schemaVersion, userId: base.userId,
            model: base.model, voice: base.voice, audio: base.audio, persona: base.persona,
            tools: ProfileTools(permissions: nil, toolsets: nil), compression: base.compression,
            advanced: base.advanced, auxiliaryModels: base.auxiliaryModels, memory: base.memory)
        let vm = ToolsViewModel(loadProfile: { SentientResultSuccess(data: profile) },
            loadCatalog: { SentientResultSuccess(data: McpCatalogView(groups: [:], wildcardPermissionKey: "*", hermesBuiltins: [])) },
            applyProfile: { _, _ in Issue.record("Untouched tools must not write") },
            applyOnly: { _ in Issue.record("No unresolved Apply") })
        await vm.load(); await vm.save()
        #expect(!vm.isDirty && vm.save == .idle)
        vm.toggleToolset("memory"); vm.toggleToolset("memory")
        #expect(!vm.isDirty)
        vm.setGroupMaster("synthetic", ["tool"], true)
        #expect(vm.isDirty, "Explicit null clear remains a real permission patch")
        vm.discard()
        #expect(!vm.isDirty)
    }

    @Test @MainActor func failedPutCanDiscardWithoutClaimingCommittedChange() async {
        let boundary = ProfileApplyBoundary("failed")
        boundary.fixture.failPut = true
        let vm = AdvancedViewModel(loadProfile: boundary.read, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load(); vm.maxTokens = 2048; await vm.save(); vm.discard()
        #expect(vm.maxTokens == 1024 && vm.save == .idle && !vm.hasPendingApply)
        #expect(boundary.fixture.putCalls == 1 && boundary.fixture.applyCalls == 0)
    }

    @Test @MainActor func cancellationAfterCommitRejectsLateReadyAndStaleDiscard() async {
        let boundary = ProfileApplyBoundary("failed")
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        let gate = SettingsTGate()
        boundary.afterRestart = { await gate.hold() }
        let vm = AdvancedViewModel(loadProfile: boundary.read, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load(); vm.maxTokens = 2048
        let task = Task { await vm.save() }
        await gate.waitForHold(1)
        #expect(boundary.fixture.putCalls == 1 && boundary.fixture.stored.advanced.maxTokens == 2048)
        vm.discard(); await vm.save(); await vm.load()
        #expect(vm.save == .restarting && boundary.fixture.putCalls == 1)
        task.cancel(); gate.release(); await task.value
        vm.discard()
        #expect(vm.save != .idle && vm.save != .applied && vm.hasPendingApply)
        #expect(vm.maxTokens == 2048 && boundary.fixture.putCalls == 1)
        await vm.load(); vm.maxTokens = 3072; vm.discard()
        #expect(vm.maxTokens == 2048 && vm.hasPendingApply)
    }

    @Test @MainActor func retiredModelConsumerCannotClearUnresolvedApplyOrAffectFreshLifetime() async {
        let boundary = ProfileApplyBoundary("failed")
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        let gate = SettingsTGate()
        boundary.afterRestart = { await gate.hold() }
        let models: () async throws -> SentientResult<ModelCatalog> = { SentientResultSuccess(data: ModelCatalog(models: [], stale: false)) }
        let old = ModelViewModel(loadProfile: boundary.read, loadModels: models, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await old.load(); old.select(ProfileApplyBoundary.model("committed"))
        let task = Task { await old.save() }
        await gate.waitForHold(1)
        old.select(ProfileApplyBoundary.model("blocked")); old.discard(); await old.save()
        #expect(old.draftModelId == "committed" && boundary.fixture.putCalls == 1)
        task.cancel()
        let fresh = ModelViewModel(loadProfile: boundary.read, loadModels: models, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await fresh.load(); fresh.select(ProfileApplyBoundary.model("fresh-edit"))
        gate.release(); await task.value
        old.discard()
        #expect(old.hasPendingApply && old.save != .applied)
        #expect(fresh.draftModelId == "fresh-edit" && fresh.isDirty && fresh.save == .idle)
        #expect(boundary.fixture.putCalls == 1)
    }

    @Test @MainActor func retiredToolsConsumerCannotResetPermissionsOrAffectFreshLifetime() async {
        let boundary = ProfileApplyBoundary("failed")
        boundary.fixture.outcome = ApplyResult.Ready(elapsedMs: 1)
        let gate = SettingsTGate()
        boundary.afterRestart = { await gate.hold() }
        let old = ToolsViewModel(loadProfile: boundary.read, loadCatalog: boundary.catalog, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await old.load(); old.setToolPermission("synthetic", "tool", .allow); old.setCubePermission("tool", .allow)
        let task = Task { await old.save() }
        await gate.waitForHold(1)
        old.setToolPermission("synthetic", "tool", .off); old.setCubePermission("tool", .off)
        old.discard(); await old.save()
        #expect(boundary.displayedPermission(old) == .allow && old.cubePermission("tool") == .allow)
        task.cancel()
        let fresh = ToolsViewModel(loadProfile: boundary.read, loadCatalog: boundary.catalog, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await fresh.load(); fresh.setToolPermission("synthetic", "tool", .off)
        gate.release(); await task.value
        old.discard()
        #expect(old.hasPendingApply && old.save != .applied)
        #expect(boundary.displayedPermission(fresh) == .off && fresh.isDirty && fresh.save == .idle)
        #expect(boundary.fixture.putCalls == 1)
    }

    @Test @MainActor func cancelledRefetchCannotPublishStaleResultIntoNewEdits() async {
        let boundary = ProfileApplyBoundary("429")
        let gate = SettingsTGate()
        var delay = false
        let vm = AdvancedViewModel(loadProfile: {
            let result = boundary.fixture.read()
            if delay { await gate.hold() }
            return result
        }, applyProfile: boundary.apply, applyOnly: boundary.applyOnly)
        await vm.load(); vm.maxTokens = 2048; await vm.save()
        delay = true
        let task = Task { await vm.load() }
        await gate.waitForHold(1)
        vm.discard(); await vm.save()
        task.cancel(); gate.release(); await task.value
        #expect(vm.save == .alreadyApplying && vm.maxTokens == 2048)
        #expect(boundary.fixture.putCalls == 1)
        delay = false
        await vm.load(); vm.maxTokens = 4096
        #expect(vm.isDirty)
        vm.discard()
        #expect(vm.maxTokens == 2048 && vm.save == .alreadyApplying)
    }
}

@MainActor private final class ProfileApplyBoundary {
    let fixture = ProfileApplyBridgeFixture(initial: ProfileV1(
        schemaVersion: 1, userId: "synthetic-profile", model: ProfileModelRef(provider: "custom", id: "chat"),
        voice: ProfileVoiceRef(provider: "local-tts", id: "voice"), audio: ProfileAudio(ttsEnabled: false, channel: "text"),
        persona: ProfilePersona(template: "default", overrides: ""),
        tools: ProfileTools(permissions: ["synthetic": ["tool": .ask], "cube": ["tool": .off]], toolsets: []),
        compression: ProfileCompression(threshold: 0.6),
        advanced: ProfileAdvanced(extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "low"),
        auxiliaryModels: nil, memory: ProfileMemory(spark: false, dreaming: false)))
    var mutations: [ProfileMutationPutProfile] = []
    var afterRestart: (() async -> Void)?
    var failCatalog = false
    init(_ outcome: String) {
        if outcome == "429" { fixture.outcome = ApplyResult.InProgress.shared }
        if outcome == "network" { fixture.outcome = ApplyResult.Network(cause: "Synthetic network failure") }
    }
    func read() async throws -> SentientResult<ProfileV1> { fixture.read() }
    func apply(_ mutation: ProfileMutationPutProfile, _ receive: (any ApplyState) async -> Void) async {
        mutations.append(mutation)
        for await state in fixture.useCase.invoke(mutation: mutation) {
            await receive(state)
            if case .restarting = onEnum(of: state) {
                #expect(fixture.putCalls == Int32(mutations.count))
                #expect(fixture.stored.advanced.isEqual(mutation.next.advanced))
                await afterRestart?()
            }
        }
    }
    func applyOnly(_ receive: (any ApplyState) async -> Void) async {
        for await state in fixture.useCase.applyOnly() { await receive(state) }
    }
    var tool: McpToolView {
        McpToolView(name: "tool", description: "Synthetic", tier: .confirm,
                    permission: fixture.stored.tools.permissions?["synthetic"]?["tool"] ?? .ask,
                    settable: true, dispatch: ToolDispatchView(kind: .mcp, serverName: "synthetic"))
    }
    func displayedPermission(_ vm: ToolsViewModel) -> ToolPermission {
        // Same catalog snapshot as ToolsScreen, not a newly read synthetic tool.
        vm.toolPermission("synthetic", vm.catalog!.groups["synthetic"]!.tools[0])
    }
    func catalog() async throws -> SentientResult<McpCatalogView> {
        if failCatalog { throw SettingsTFault.unavailable }
        return SentientResultSuccess(data: McpCatalogView(groups: ["synthetic": ProductToolGroupView(
            tools: [tool], wildcardPermission: nil, defaultExposure: .standard, description: "Synthetic")],
            wildcardPermissionKey: "*", hermesBuiltins: []))
    }
    static func model(_ id: String) -> ModelEntry {
        ModelEntry(id: id, provider: "custom", name: id, description: "Synthetic", contextLength: 1000,
                   pricingPer1mPrompt: Kotlinx_serialization_jsonJsonNull.shared,
                   pricingPer1mCompletion: Kotlinx_serialization_jsonJsonNull.shared, supportsTools: true, supportsVision: true)
    }
}
#endif
