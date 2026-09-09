// ---------------------------------------------------------------------------
// VoiceAddScreen — Voice sub-page "Add Voice", pushed from VoiceScreen. Record OR
// upload a clip (mode segmented), a review check, then a name/description/tags/
// language form + multipart create over `settings.voices`. Mirrors the webui
// AddVoiceModal. On success the VM posts `.voiceLibraryChanged` (VoiceScreen
// refetches) and this page pops.
//
// Screen-level view: owns its `VoiceAddViewModel` (rebuilt per route entry), reads
// state, dispatches actions. `onBack` pops; the host / Route.swift are untouched.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData
import UniformTypeIdentifiers

private let modeOptions: [(value: VoiceAddViewModel.Mode, label: String)] = [
    (.record, "Record"),
    (.upload, "Upload"),
]

struct VoiceAddScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: VoiceAddViewModel
    @State private var importing = false
    @State private var stage: CreationStage = .sample
    @State private var tagDraft = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum CreationStage: Int {
        case sample = 1, details, create

        var title: String {
            switch self {
            case .sample: "Sample"
            case .details: "Details"
            case .create: "Create"
            }
        }
    }

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: VoiceAddViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Add Voice", screenId: "settings-voice-add",
            onBack: onBack, backAccessibilityId: "settings-voice-add-back"
        ) {
            noticeBanner
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Step \(stage.rawValue) of 3 · \(stage.title)")
                    .designText(.body)
                    .fontWeight(.semibold)
                    .foregroundStyle(DuskColors.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Review a sample, add details, then create your voice.")
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink2)
            }
            stageContent
                .animation(
                    DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
                    value: stage
                )
        }
        .onChange(of: vm.done) { _, done in if done { onBack() } }
        .onDisappear { vm.teardown() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio]) { result in
            vm.handlePicked(result)
        }
    }

    @ViewBuilder
    private var stageContent: some View {
        switch stage {
        case .sample:
            DesignSegmentedPicker(
                title: "Sample source",
                options: modeOptions,
                selection: Binding(get: { vm.mode }, set: { vm.selectMode($0) }),
                isEnabled: !vm.submitting
            )
            .accessibilityIdentifier("settings-voice-add-mode")
            captureSection
            DesignActionButton(
                title: "Continue to details",
                state: vm.audioData != nil && !vm.submitting ? .normal : .disabled,
                accessibilityId: "settings-voice-add-continue-details"
            ) {
                if vm.previewingTake { vm.toggleTakePreview() }
                stage = .details
            }
        case .details:
            sampleSummary
            formSection
            DesignActionButton(
                title: "Review voice",
                state: vm.canSubmit ? .normal : .disabled,
                accessibilityId: "settings-voice-add-continue-review"
            ) { stage = .create }
            DesignTextButton(title: "Back to sample", state: vm.submitting ? .disabled : .normal) {
                stage = .sample
            }
        case .create:
            sampleSummary
            DesignPane(title: vm.name, detail: vm.language.isEmpty ? "No language" : VoiceLanguages.label(for: vm.language)) {
                if !vm.description.isEmpty {
                    Text(vm.description).designText(.body).foregroundStyle(DuskColors.ink2)
                }
                if !vm.tags.isEmpty {
                    Text(vm.tags.joined(separator: " · "))
                        .designText(.caption).foregroundStyle(DuskColors.ink2)
                }
                Text("Create adds this sample and its details to your voice library.")
                    .designText(.body).foregroundStyle(DuskColors.ink2)
            }
            submitButton
            DesignTextButton(title: "Edit details", state: vm.submitting ? .disabled : .normal) {
                stage = .details
            }
        }
    }

    private var sampleSummary: some View {
        AsyncNotice(
            kind: .success,
            title: "Sample ready",
            detail: vm.uploadedName ?? String(format: "Recording · %.1f seconds", vm.elapsedSeconds)
        )
        .accessibilityIdentifier("settings-voice-add-clip-ready")
    }

    @ViewBuilder
    private var captureSection: some View {
        if vm.mode == .record {
            VoiceRecordSection(
                state: vm.recordState,
                elapsedSeconds: vm.elapsedSeconds,
                canFinish: vm.canFinishRecording,
                previewingTake: vm.previewingTake,
                disabled: vm.submitting,
                onRecordTapped: { vm.onRecordTapped() },
                onStopRecording: { vm.stopRecording() },
                onReRecord: { vm.reRecord() },
                onTogglePreview: { vm.toggleTakePreview() },
                onOpenSettings: { vm.openAppSettings() }
            )
        } else {
            uploadSection
        }
    }

    private var uploadSection: some View {
        DesignPane(title: "Voice sample", detail: ".wav, .flac, .ogg, or .mp3 audio") {
            DesignActionButton(
                title: vm.uploadedName == nil ? "Choose file" : "Replace file",
                role: .quiet,
                state: vm.submitting ? .disabled : .normal,
                accessibilityId: "settings-voice-add-upload",
                action: { importing = true }
            )
            if let uploadedName = vm.uploadedName {
                Text(uploadedName)
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var formSection: some View {
        DesignPane(title: "Voice details") {
            DesignField(
                title: "Name", prompt: "e.g. Dad",
                text: Binding(get: { vm.name }, set: { vm.setName($0) }),
                accessibilityId: "settings-voice-add-name",
                isEnabled: !vm.submitting
            )
            DesignMultilineEditor(
                title: "Description",
                text: Binding(get: { vm.description }, set: { vm.setDescription($0) }),
                accessibilityId: "settings-voice-add-description",
                isEnabled: !vm.submitting
            )
            DesignSelect(
                title: "Language",
                options: VoiceLanguages.formOptions.map { (value: $0.code, label: $0.label) },
                selection: $vm.language,
                isEnabled: !vm.submitting
            )
            .accessibilityIdentifier("settings-voice-add-language")
            VoiceTagField(tags: vm.tags, disabled: vm.submitting, onChange: { vm.tags = $0 }, draft: $tagDraft)
        }
    }

    private var submitButton: some View {
        DesignActionButton(
            title: "Create voice",
            loadingTitle: "Creating voice…",
            state: vm.submitting ? .loading : vm.canSubmit ? .normal : .disabled,
            accessibilityId: "settings-voice-add-submit",
            action: vm.submit
        )
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = vm.notice {
            DesignDismissibleNotice(
                kind: .error,
                title: notice,
                accessibilityId: "settings-voice-add-notice",
                onDismiss: { vm.notice = nil }
            )
        }
    }
}

#Preview {
    NavigationStack {
        Text("VoiceAddScreen requires a live SettingsComponent")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
