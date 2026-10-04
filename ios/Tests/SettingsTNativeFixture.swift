// Standalone production-leaf host. Never compiled into the configured app.
#if T_SETTINGS_FIXTURE
import SwiftUI
import MobileData

@main final class SettingsTNativeFixtureDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Settings T isolated", sessionRole: session.role)
        configuration.delegateClass = SettingsTNativeFixtureSceneDelegate.self
        return configuration
    }
}

final class SettingsTNativeFixtureSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let bounds = scene.screen.bounds
        // A real narrow UIWindow also constrains native presentation containers;
        // a SwiftUI panel alone would leave sheets at the simulator's 393pt width.
        window.frame = CGRect(x: 0, y: 0, width: ProcessInfo.processInfo.environment["T_WIDTH"] == "320" ? 320 : bounds.width, height: bounds.height)
        window.rootViewController = UIHostingController(rootView: SettingsTHost().duskTheme())
        self.window = window
        window.makeKeyAndVisible()
    }
}

@MainActor @Observable final class SettingsTDriver {
    enum Outcome { case restarting, failed, ready, alreadyApplying }
    var writes = 0
    var backs = 0
    var presented = false
    var sheetBusy = false
    var sheetError: String?
    var phase = "idle"
    var refreshFails = false
    var submittedContextMatches = true
    var recordingCalls = 0
    private var pending: CheckedContinuation<Outcome, Never>?
    var profile = ProfileV1(
        schemaVersion: 1, userId: "fixture", model: ProfileModelRef(provider: "custom", id: "chat-default"),
        voice: ProfileVoiceRef(provider: "builtin", id: "fixture"), audio: ProfileAudio(ttsEnabled: true, channel: "voice"),
        persona: ProfilePersona(template: "default", overrides: ""), tools: ProfileTools(permissions: nil, toolsets: []),
        compression: ProfileCompression(threshold: 0.8),
        advanced: ProfileAdvanced(extraSystemPrompt: "", maxTokens: 2048, reasoningEffort: "minimal"),
        auxiliaryModels: ProfileAuxiliaryModels(title: nil, dreamer: nil, attachmentVision: ProfileModelRef(provider: "custom", id: "unknown-vision-override")),
        memory: ProfileMemory(spark: true, dreaming: true)
    )
    var documents = ["memory": "# Shared notes\n\nDisposable **Markdown** with `code`.\n\n[Safe link](https://example.invalid)\n\n![External image stays alt-only](https://example.invalid/image.png)", "user": "# About you\n\nDisposable preferences."]
    var soul = "# System instructions\n\nDisposable **Markdown**, `code` and [safe link](https://example.invalid).\n\n![No fetch authority](https://example.invalid/image.png)"
    static let failure = SentientError.Unknown(userMessage: "Disposable mutation failure", cause: nil)
    let fishEntry = FishVoiceEntry(id: "fixture-fish", title: "Disposable narrator", description: "Synthetic voice metadata only", languages: ["en"], tags: ["Calm"], coverImageUrl: nil, previewAudioUrl: nil, visibility: "public", taskCount: 0, createdAt: "2026-01-01")

    @ObservationIgnored lazy var audio = AudioViewModel(loadProfile: { [unowned self] in SentientResultSuccess(data: self.profile) }, applyProfile: applyProfile)
    @ObservationIgnored lazy var advanced = AdvancedViewModel(loadProfile: { [unowned self] in SentientResultSuccess(data: self.profile) }, applyProfile: applyProfile, applyOnly: { [unowned self] receive in await self.apply(receive, commit: {}) })
    @ObservationIgnored lazy var model = ModelViewModel(loadProfile: { [unowned self] in SentientResultSuccess(data: self.profile) }, loadModels: { SentientResultSuccess(data: ModelCatalog(models: Self.models, stale: false)) }, applyProfile: applyProfile, applyOnly: { [unowned self] receive in await self.apply(receive, commit: {}) })
    @ObservationIgnored lazy var tools = ToolsViewModel(loadProfile: { [unowned self] in SentientResultSuccess(data: self.profile) }, loadCatalog: { SentientResultSuccess(data: Self.catalog) }, applyProfile: applyProfile, applyOnly: { [unowned self] receive in await self.apply(receive, commit: {}) })
    @ObservationIgnored lazy var memory = MemoryViewModel(loadMemory: { [unowned self] slot in
        if self.refreshFails && slot == .memory && self.writes > 0 { return Self.failedResult() }
        return SentientResultSuccess(data: MemoryDoc(content: self.documents[slot == .memory ? "memory" : "user"]!, lastModified: nil, charLimit: 4000))
    }, applyMemory: { [unowned self] slot, content, receive in
        await self.apply(receive) { self.documents[slot == .memory ? "memory" : "user"] = content }
    })
    @ObservationIgnored lazy var prompt = SystemPromptViewModel(loadSoul: { [unowned self] in SentientResultSuccess(data: SoulDoc(content: self.soul, lastModified: nil)) }, loadDefault: { Self.failedResult() }, applySoul: { [unowned self] content, receive in
        await self.apply(receive) { self.soul = content }
    })
    @ObservationIgnored lazy var secrets = SecretsViewModel(loadStatus: { SentientResultSuccess(data: Self.status) }, writeKey: { [unowned self] provider, value, url in
        self.submittedContextMatches = provider == "openrouter" && value != nil && url == nil || provider == "custom" && value == nil && url != nil
        return await self.mutate() ? SentientResultSuccess(data: KotlinUnit.shared) : (Self.failedResult())
    }, writeActive: { [unowned self] _ in await self.mutate() ? SentientResultSuccess(data: KotlinUnit.shared) : (Self.failedResult()) })
    @ObservationIgnored lazy var voice = VoiceAddViewModel(recorder: SettingsTRecorder(driver: self), player: SettingsTPlayer(), permission: SettingsTPermission(), settingsOpener: SettingsTOpener(), createVoice: { [unowned self] name, _, _, _, _ in
        self.submittedContextMatches = name == "Disposable voice"
        return await self.mutate() ? SentientResultSuccess(data: VoiceCreateResult(voiceId: "fixture", name: "Disposable voice", warning: nil)) : (Self.failedResult())
    })
    @ObservationIgnored lazy var fish = VoiceFishViewModel(browse: { [unowned self] _, _ in FishResultSuccess(value: FishVoicePage(voices: [self.fishEntry], hasMore: false, stale: false)) }, cloneVoice: { [unowned self] id, request in
        self.submittedContextMatches = id == self.fishEntry.id && request.name == "Disposable narrator"
        return await self.mutate() ? FishResultSuccess(value: CloneFromFishResult(voiceId: "fixture", name: "Disposable narrator", warning: nil)) : (Self.failedFishResult())
    }, player: SettingsTPlayer())

    static func failedResult<T: AnyObject>() -> SentientResult<T> {
        // Kotlin Nothing is covariant; Swift's imported generic is invariant.
        let erased: Any = SentientResultFailure(error: failure)
        return erased as! SentientResult<T>
    }
    static func failedFishResult() -> FishResult<CloneFromFishResult> {
        let erased: Any = FishResultFailure(error: AuthError.Network(cause: "fixture"))
        return erased as! FishResult<CloneFromFishResult>
    }
    var applyProfile: (ProfileMutationPutProfile, (any ApplyState) async -> Void) async -> Void {
        { [unowned self] mutation, receive in
            await self.apply(receive) {
                let next = mutation.next
                self.profile = ProfileV1(schemaVersion: next.schemaVersion, userId: next.userId, model: next.model, voice: next.voice, audio: next.audio, persona: next.persona, tools: ProfileTools(permissions: nil, toolsets: next.tools.toolsets), compression: next.compression, advanced: next.advanced, auxiliaryModels: next.auxiliaryModels, memory: next.memory)
            }
        }
    }
    func apply(_ receive: (any ApplyState) async -> Void, commit: () -> Void) async {
        writes += 1
        phase = "saving"
        await receive(ApplyStateSaving.shared)
        var outcome = await hold()
        if outcome == .restarting {
            phase = "restarting"
            await receive(ApplyStateRestarting.shared)
            outcome = await hold()
        }
        switch outcome {
        case .ready: commit(); phase = "applied"; await receive(ApplyStateReady(elapsedMs: 0))
        case .alreadyApplying: phase = "alreadyApplying"; await receive(ApplyStateAlreadyApplying.shared)
        default: phase = "failed"; await receive(ApplyStateFailed(error: Self.failure))
        }
    }
    func mutate() async -> Bool {
        writes += 1
        phase = "saving"
        let outcome = await hold()
        phase = outcome == .ready ? "applied" : "failed"
        return outcome == .ready
    }
    private func hold() async -> Outcome { await withCheckedContinuation { pending = $0 } }
    func resolve(_ outcome: Outcome) { let current = pending; pending = nil; current?.resume(returning: outcome) }
    func submitSheet(_ name: String, _ pin: String) async -> Bool {
        sheetBusy = true; sheetError = nil
        defer { sheetBusy = false }
        let succeeded = await mutate()
        if !succeeded { sheetError = "Disposable mutation failure" }
        return succeeded
    }
    func back() { backs += 1 }
    var telemetry: String {
        "writes=\(writes);backs=\(backs);phase=\(phase);context=\(submittedContextMatches);memoryDirty=\(memory.isDirty);promptDirty=\(prompt.isDirty);editor=\(editorName);recordings=\(recordingCalls);sheet=\(presented)"
    }
    private var editorName: String {
        switch secrets.editing { case .none: "none"; case .key(let p): p.rawValue; case .customBaseUrl: "url" }
    }
    static var models: [ModelEntry] {
        [("chat-default", "custom", false), ("vision-candidate", "custom", true), ("text-candidate", "custom", false), ("foreign-vision", "openrouter", true)].map { id, provider, vision in
            ModelEntry(id: id, provider: provider, name: id, description: "Disposable catalog metadata", contextLength: 128000, pricingPer1mPrompt: Kotlinx_serialization_jsonJsonNull.shared, pricingPer1mCompletion: Kotlinx_serialization_jsonJsonNull.shared, supportsTools: true, supportsVision: vision)
        }
    }
    static var catalog: McpCatalogView {
        let tool = McpToolView(name: "turn_on", description: "Disposable capability", tier: .confirm, permission: .ask, settable: true, dispatch: ToolDispatchView(kind: .mcp, serverName: "fixture"))
        return McpCatalogView(groups: ["home-assistant": ProductToolGroupView(tools: [tool], wildcardPermission: nil, defaultExposure: .standard, description: "Disposable smart-home metadata")], wildcardPermissionKey: "*", hermesBuiltins: [])
    }
    static var status: SecretsStatus {
        let presence = LlmProviderStatus(hasKey: false, hasBaseUrl: false)
        return SecretsStatus(llm: LlmSecretsStatus(active: "openrouter", ollamaCloud: presence, openrouter: presence, custom: presence), homeAssistant: HomeAssistantStatus(url: nil, observeToken: TokenPresence(hasToken: false), mcpServerToken: TokenPresence(hasToken: false)), musicAssistant: MusicAssistantStatus(url: nil, hasToken: false))
    }
}

@MainActor private struct SettingsTHost: View {
    @State private var driver = SettingsTDriver()
    @State private var path: [String] = []
    @Environment(\.accessibilityReduceMotion) private var reduced
    @Environment(\.colorSchemeContrast) private var contrast
    private let configuration = ProcessInfo.processInfo.environment
    private var scenario: String { configuration["T_SCENARIO"] ?? "prompt" }
    private var size: DynamicTypeSize {
        switch configuration["T_SIZE"] { case "AX3": .accessibility3; case "AX5": .accessibility5; default: .large }
    }
    var body: some View {
        NavigationStack(path: $path) {
            Button("Open Settings leaf") { path.append(scenario) }
                .accessibilityIdentifier("t-open")
                .navigationDestination(for: String.self) { route in leaf(route) }
        }
        .overlay(alignment: .topTrailing) { probe }
        .environment(\.dynamicTypeSize, size)
        .frame(width: configuration["T_WIDTH"] == "320" ? 320 : nil)
        .frame(maxWidth: .infinity)
        .background(DuskColors.bg)
        .preferredColorScheme(.dark)
    }
    private var probe: some View {
            Menu {
                Button("Restart phase") { driver.resolve(.restarting) }
                Button("Fail write") { driver.resolve(.failed) }
                Button("Finish write") { driver.resolve(.ready) }
                Button("Already applying") { driver.resolve(.alreadyApplying) }
                Button("Dismiss keyboard") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                Button("Dirty both slots") {
                    Task { await driver.memory.loadIfNeeded(.memory); await driver.memory.loadIfNeeded(.user); driver.memory.setDraft("Memory draft", for: .memory); driver.memory.setDraft("User draft", for: .user) }
                }
                Button("Fail memory refresh") { driver.refreshFails = true }
                Button("Attempt blocked VM edits") {
                    driver.secrets.cancelEdit(); driver.secrets.startEditBaseUrl(); driver.secrets.startEditKey(.custom)
                    driver.voice.selectMode(.upload); driver.voice.setName("Blocked"); driver.voice.submit()
                    driver.fish.cancelSelect(); driver.fish.setCloneName("Blocked"); driver.fish.clone()
                }
            } label: { Image(systemName: "testtube.2").frame(width: 44, height: 44) }
            .accessibilityLabel("Fixture controls")
            .accessibilityIdentifier("t-probe")
            .accessibilityValue(driver.telemetry + ";motion=\(reduced ? "reduced" : "normal");contrast=\(contrast == .increased ? "increased" : "standard")")
            .padding(.trailing, 8)
    }
    private func back() { driver.back(); if !path.isEmpty { path.removeLast() } }
    @ViewBuilder private func leaf(_ route: String) -> some View {
        switch route {
        case "audio": AudioScreen(viewModel: driver.audio, onBack: back)
        case "advanced": AdvancedScreen(viewModel: driver.advanced, onBack: back)
        case "model": ModelScreen(viewModel: driver.model, onBack: back)
        case "auxiliary": ModelScreen(viewModel: driver.model, auxiliaryOnly: true, onBack: back)
        case "tools": ToolsScreen(viewModel: driver.tools, onBack: back)
        case "memory": MemoryScreen(viewModel: driver.memory, onBack: back)
        case "secrets": SecretsScreen(viewModel: driver.secrets, onBack: back)
        case "voice": VoiceAddScreen(viewModel: driver.voice, onBack: back)
        case "fish": VoiceFishScreen(viewModel: driver.fish, onBack: back, editorEntry: driver.fishEntry)
        case "pin", "member", "personality":
            Button("Present native sheet") { driver.presented = true }
                .accessibilityIdentifier("t-present")
                .sheet(isPresented: $driver.presented) {
                    Group {
                    if route == "pin" { ChangePinSheet(saving: driver.sheetBusy, error: driver.sheetError, onSubmit: driver.submitSheet) }
                    else if route == "member" { AddMemberSheet(adding: driver.sheetBusy, error: driver.sheetError, onSubmit: driver.submitSheet) }
                    else { PersonalityCreateSheet(isBusy: driver.sheetBusy, error: driver.sheetError) { name, body in if await driver.submitSheet(name, body) { driver.presented = false } } }
                    }
                    .environment(\.dynamicTypeSize, size)
                    .overlay(alignment: .bottomTrailing) { probe }
                }
        default: SystemPromptScreen(viewModel: driver.prompt, onBack: back)
        }
    }
}

@MainActor private final class SettingsTRecorder: VoiceRecording {
    let driver: SettingsTDriver
    init(driver: SettingsTDriver) { self.driver = driver }
    func start() throws { driver.recordingCalls += 1 }
    func stop() -> URL? { nil }
    func recordedData() -> Data? { Data([1, 2, 3]) }
    func discard() {}
}
@MainActor private final class SettingsTPlayer: VoiceSamplePlaying {
    var onFinished: (@MainActor () -> Void)?
    func playData(_ data: Data) throws {}
    func playRemote(_ url: URL) { preconditionFailure("No network sample playback authorized") }
    func stop() {}
}
@MainActor private struct SettingsTPermission: VoicePermissionProviding {
    func status() -> VoiceMicrophonePermission { .granted }
    func request(_ completion: @escaping (Bool) -> Void) { preconditionFailure("No microphone prompt authorized") }
}
@MainActor private struct SettingsTOpener: VoiceSettingsOpening { func openMicrophoneSettings() {} }
#endif
