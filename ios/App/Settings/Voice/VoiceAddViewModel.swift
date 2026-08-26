// ---------------------------------------------------------------------------
// VoiceAddViewModel — state + logic for the Add Voice page: record OR upload a
// clip, a name/description/tags/language form, and a multipart `create` over
// `settings.voices`. Mirrors the webui AddVoiceModal (record/upload modes,
// review-before-submit, field caps).
//
// Mic permission is requested AT POINT OF USE via `MicPermission` (the app's
// shared AVAudioApplication gate); a denial routes to the rationale + settings-
// bounce. Recording uses `VoiceRecorder` (scoped `.record` session); the review
// playback and file bytes never leave this VM. NEVER logs audio content.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class VoiceAddViewModel {
    enum Mode: String, CaseIterable { case record, upload }
    enum RecordState: Equatable { case idle, recording, review, denied }

    /// Soft minimum before "Use recording" enables — the TTS service hard floor is
    /// >5s (mirrors webui VoiceCapture.MIN_RECORDING_SECONDS).
    static let minRecordingSeconds: Double = 6

    var mode: Mode = .record
    private(set) var recordState: RecordState = .idle
    private(set) var elapsedSeconds: Double = 0
    private(set) var previewingTake = false

    // Form fields (name/description hard-capped; over-cap input can't be typed).
    var name = ""
    var description = ""
    var tags: [String] = []
    var language = ""

    private(set) var audioData: Data?
    private(set) var uploadedName: String?
    private(set) var submitting = false
    var notice: String?
    private(set) var done = false

    private let settings: SettingsComponent?
    private let recorder: any VoiceRecording
    private let player: any VoiceSamplePlaying
    private let permission: any VoicePermissionProviding
    private let settingsOpener: any VoiceSettingsOpening
    private var timerTask: Task<Void, Never>?
    private var startedAt: Date?
    private let log = AppLog("settings", "voice-add-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
        self.recorder = VoiceRecorder()
        self.player = VoiceSamplePlayer()
        self.permission = SystemVoicePermissionProvider()
        self.settingsOpener = SystemVoiceSettingsOpener()
        player.onFinished = { [weak self] in self?.previewingTake = false }
    }

    /// Audio-free seam used by state tests and static previews. Supplying fakes never
    /// touches AVFoundation, the microphone permission prompt, or UIApplication.
    init(
        recorder: any VoiceRecording,
        player: any VoiceSamplePlaying,
        permission: any VoicePermissionProviding,
        settingsOpener: any VoiceSettingsOpening
    ) {
        self.settings = nil
        self.recorder = recorder
        self.player = player
        self.permission = permission
        self.settingsOpener = settingsOpener
        player.onFinished = { [weak self] in self?.previewingTake = false }
    }

    var canFinishRecording: Bool { elapsedSeconds >= Self.minRecordingSeconds }
    var canSubmit: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && audioData != nil && !submitting }

    /// Cap name input at the field limit so an over-cap name can't be entered.
    func setName(_ value: String) { name = String(value.prefix(VoiceCaps.nameMax)) }
    func setDescription(_ value: String) { description = String(value.prefix(VoiceCaps.descriptionMax)) }

    // ── Record flow ──

    func selectMode(_ next: Mode) {
        guard mode != next else { return }
        timerTask?.cancel()
        recorder.discard()
        player.stop()
        previewingTake = false
        recordState = .idle
        elapsedSeconds = 0
        audioData = nil
        uploadedName = nil
        mode = next
    }

    /// Record tapped from idle: gate mic permission, then begin capture.
    func onRecordTapped() {
        switch permission.status() {
        case .granted:
            beginRecording()
        case .denied:
            recordState = .denied
            log.warn("record.denied")
        case .undetermined:
            log.info("record.request-permission")
            permission.request { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted { self.beginRecording() } else { self.recordState = .denied }
                }
            }
        }
    }

    private func beginRecording() {
        do {
            try recorder.start()
            audioData = nil
            elapsedSeconds = 0
            startedAt = Date()
            recordState = .recording
            startTimer()
        } catch {
            notice = "Couldn't start recording"
            recordState = .idle
            log.warn("record.start.failed code=audio-session")
        }
    }

    /// Stop capture, load the take into `audioData`, and enter review.
    func stopRecording() {
        timerTask?.cancel()
        recorder.stop()
        audioData = recorder.recordedData()
        if audioData?.isEmpty == false {
            recordState = .review
            log.info("record.review bytes=\(audioData?.count ?? 0)")
        } else {
            audioData = nil
            recordState = .idle
            notice = "Couldn't finish recording"
            log.warn("record.review.failed code=empty-clip")
        }
    }

    func reRecord() {
        player.stop()
        previewingTake = false
        recorder.discard()
        audioData = nil
        recordState = .idle
    }

    /// Play / stop the recorded take for the review check.
    func toggleTakePreview() {
        guard let audioData else { return }
        if previewingTake {
            player.stop()
            previewingTake = false
            return
        }
        do {
            try player.playData(audioData)
            previewingTake = true
        } catch {
            notice = "Couldn't play the take"
            log.warn("review.play.failed code=transport")
        }
    }

    /// Open Settings so the user can grant mic access after a denial.
    func openAppSettings() {
        settingsOpener.openMicrophoneSettings()
    }

    // ── Upload flow ──

    func handlePicked(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            copyPickedFile(url)
        case .failure:
            log.warn("upload.pick.failed code=file-picker")
        }
    }

    /// Copy the security-scoped picked file into a tmp copy we own, then read it.
    private func copyPickedFile(_ url: URL) {
        guard VoiceUploadValidation.accepts(fileName: url.lastPathComponent) else {
            notice = VoiceUploadValidation.unsupportedMessage
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("upload-\(UUID().uuidString)-\(url.lastPathComponent)")
            try? FileManager.default.removeItem(at: tmp)
            defer { try? FileManager.default.removeItem(at: tmp) }
            try FileManager.default.copyItem(at: url, to: tmp)
            let data = try Data(contentsOf: tmp)
            guard !data.isEmpty else {
                notice = VoiceUploadValidation.emptyMessage
                return
            }
            audioData = data
            uploadedName = url.lastPathComponent
            notice = nil
            log.info("upload.picked bytes=\(data.count)")
        } catch {
            notice = "Couldn't read that file"
            log.warn("upload.read.failed code=file-read")
        }
    }

    // ── Submit ──

    func submit() {
        guard canSubmit, let audioData, let settings else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        submitting = true
        player.stop()
        previewingTake = false
        log.info("create.request \(VoiceSafeDiagnostics.mutation(audioBytes: audioData.count, name: trimmed, tags: tags, language: language))")
        Task {
            defer { submitting = false }
            do {
                let result = try await settings.voices.create(
                    name: trimmed,
                    audioWav: audioData.toKotlinByteArray(),
                    description: description.trimmingCharacters(in: .whitespaces),
                    tags: tags,
                    language: language
                )
                switch onEnum(of: result) {
                case .success(let s):
                    log.info("create.ok warning=\(s.data.warning != nil)")
                    NotificationCenter.default.post(name: .voiceLibraryChanged, object: nil)
                    done = true
                case .failure(let f):
                    notice = "Couldn't create voice"
                    log.warn("create.failed kind=\(f.error.kind.name)")
                case .loading:
                    break
                }
            } catch {
                notice = "Couldn't create voice"
                log.warn("create.threw code=transport")
            }
        }
    }

    func teardown() {
        timerTask?.cancel()
        recorder.discard()
        player.stop()
        previewingTake = false
    }

    private func startTimer() {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, let start = self.startedAt else { return }
                self.elapsedSeconds = Date().timeIntervalSince(start)
            }
        }
    }
}
