import Foundation
import MobileData
import Testing
@testable import SentientApp

@MainActor
struct VoiceSurfaceTests {
    @Test func microphoneDeniedUsesFakeWithoutRequestingOrRecording() {
        let recorder = FakeVoiceRecorder()
        let permission = FakeVoicePermission(status: .denied)
        let vm = makeAddViewModel(recorder: recorder, permission: permission)

        vm.onRecordTapped()

        #expect(vm.recordState == .denied)
        #expect(permission.requestCount == 0)
        #expect(recorder.startCount == 0)
    }

    @Test func undeterminedPermissionWaitsForInjectedDecision() async {
        let recorder = FakeVoiceRecorder()
        let permission = FakeVoicePermission(status: .undetermined)
        let vm = makeAddViewModel(recorder: recorder, permission: permission)

        vm.onRecordTapped()
        #expect(permission.requestCount == 1)
        #expect(recorder.startCount == 0)

        permission.resolve(granted: false)
        await Task.yield()
        #expect(vm.recordState == .denied)
        #expect(recorder.startCount == 0)
    }

    @Test func fakeRecordingMovesToReviewAndNeverPlaysAutomatically() {
        let recorder = FakeVoiceRecorder(data: Data([1, 2, 3]))
        let player = FakeVoicePlayer()
        let vm = makeAddViewModel(recorder: recorder, player: player)

        vm.onRecordTapped()
        #expect(vm.recordState == .recording)
        vm.stopRecording()

        #expect(vm.recordState == .review)
        #expect(vm.audioData?.count == 3)
        #expect(player.playDataCount == 0)
    }

    @Test func switchingCaptureModeCancelsFakeRecordingAndClearsClip() {
        let recorder = FakeVoiceRecorder(data: Data([1]))
        let vm = makeAddViewModel(recorder: recorder)
        vm.onRecordTapped()
        vm.stopRecording()

        vm.selectMode(.upload)

        #expect(vm.mode == .upload)
        #expect(vm.recordState == .idle)
        #expect(vm.audioData == nil)
        #expect(recorder.discardCount == 1)
    }

    @Test func uploadValidationAcceptsOnlySupportedNonContentExtensions() {
        for name in ["sample.wav", "sample.FLAC", "sample.ogg", "sample.mp3"] {
            #expect(VoiceUploadValidation.accepts(fileName: name))
        }
        #expect(!VoiceUploadValidation.accepts(fileName: "sample.m4a"))
        #expect(!VoiceUploadValidation.accepts(fileName: "sample"))
    }

    @Test func fieldCapsAndSafeDiagnosticsNeverRetainPrivateContent() {
        let privateName = "Private Family Name"
        let privateTag = "private-tag"
        let vm = makeAddViewModel()
        vm.setName(String(repeating: "n", count: VoiceCaps.nameMax + 1))
        vm.setDescription(String(repeating: "d", count: VoiceCaps.descriptionMax + 1))

        #expect(vm.name.count == VoiceCaps.nameMax)
        #expect(vm.description.count == VoiceCaps.descriptionMax)
        let diagnostic = VoiceSafeDiagnostics.mutation(
            audioBytes: 42, name: privateName, tags: [privateTag], language: "private-language"
        )
        #expect(!diagnostic.contains(privateName))
        #expect(!diagnostic.contains(privateTag))
        #expect(!diagnostic.contains("private-language"))
        #expect(diagnostic == "bytes=42 nameLen=19 tags=1 hasLanguage=true")
    }

    @Test func libraryFiltersIntersectSearchSourceLanguageAndAllTags() {
        let voices = [
            voice(id: "a", name: "Warm narrator", tags: ["warm", "calm"], language: "en", source: "user"),
            voice(id: "b", name: "Warm narrator", tags: ["warm"], language: "en", source: "user"),
            voice(id: "c", name: "Warm narrator", tags: ["warm", "calm"], language: "zh", source: "builtin"),
        ]

        let result = VoiceLibraryFiltering.apply(
            voices, query: "NARRATOR", source: "user", selectedTags: ["warm", "calm"], language: "en"
        )

        #expect(result.map(\.voiceId) == ["a"])
    }

    @Test func fishFiltersSortsAndDeduplicatesPagination() {
        let first = fish(id: "a", title: "Zulu", tags: ["Female", "Young", "Calm"], language: "en", createdAt: "2026-01-01")
        let second = fish(id: "b", title: "Alpha", tags: ["Male", "Old", "Bright"], language: "zh", createdAt: "2026-02-01")
        let filtered = VoiceFishFiltering.apply(
            [first, second], query: "calm", language: "en", genders: ["Female"], ages: ["Young"], vibes: ["Calm"], sort: .az
        )
        #expect(filtered.map(\.id) == ["a"])

        let page = VoiceFishFiltering.appendingUnique([first, second], to: [first])
        #expect(page.map(\.id) == ["a", "b"])
    }

    @Test func longContentLayoutUsesFoundationMinimumTargetAndIntentionalLimits() {
        #expect(DesignMetrics.minimumTarget >= 44)
        #expect(VoiceSurfaceLayout.visibleTagLimit == 4)
    }

    private func makeAddViewModel(
        recorder: FakeVoiceRecorder? = nil,
        player: FakeVoicePlayer? = nil,
        permission: FakeVoicePermission? = nil
    ) -> VoiceAddViewModel {
        VoiceAddViewModel(
            recorder: recorder ?? FakeVoiceRecorder(),
            player: player ?? FakeVoicePlayer(),
            permission: permission ?? FakeVoicePermission(status: .granted),
            settingsOpener: FakeVoiceSettingsOpener()
        )
    }

    private func voice(
        id: String, name: String, tags: [String], language: String, source: String
    ) -> VoiceSummary {
        VoiceSummary(
            voiceId: id, name: name, description: "", tags: tags, language: language,
            source: source, createdAt: 0, refDurationMs: 0
        )
    }

    private func fish(
        id: String, title: String, tags: [String], language: String, createdAt: String
    ) -> FishVoiceEntry {
        FishVoiceEntry(
            id: id, title: title, description: "", languages: [language], tags: tags,
            coverImageUrl: nil, previewAudioUrl: nil, visibility: "public", taskCount: 0, createdAt: createdAt
        )
    }
}

@MainActor
private final class FakeVoiceRecorder: VoiceRecording {
    private let data: Data?
    private(set) var startCount = 0
    private(set) var discardCount = 0

    init(data: Data? = nil) { self.data = data }
    func start() throws { startCount += 1 }
    func stop() -> URL? { nil }
    func recordedData() -> Data? { data }
    func discard() { discardCount += 1 }
}

@MainActor
private final class FakeVoicePlayer: VoiceSamplePlaying {
    var onFinished: (@MainActor () -> Void)?
    private(set) var playDataCount = 0
    func playData(_ data: Data) throws { playDataCount += 1 }
    func playRemote(_ url: URL) {}
    func stop() {}
}

@MainActor
private final class FakeVoicePermission: VoicePermissionProviding {
    private let value: VoiceMicrophonePermission
    private var completion: ((Bool) -> Void)?
    private(set) var requestCount = 0

    init(status: VoiceMicrophonePermission) { value = status }
    func status() -> VoiceMicrophonePermission { value }
    func request(_ completion: @escaping (Bool) -> Void) {
        requestCount += 1
        self.completion = completion
    }
    func resolve(granted: Bool) { completion?(granted) }
}

@MainActor
private struct FakeVoiceSettingsOpener: VoiceSettingsOpening {
    func openMicrophoneSettings() {}
}
