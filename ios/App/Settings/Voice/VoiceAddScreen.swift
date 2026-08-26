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

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: VoiceAddViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Add Voice", screenId: "settings-voice-add") {
            noticeBanner
            DesignSegmentedPicker(
                title: "Sample source",
                options: modeOptions,
                selection: Binding(get: { vm.mode }, set: { vm.selectMode($0) }),
                isEnabled: !vm.submitting
            )
            .accessibilityIdentifier("settings-voice-add-mode")
            captureSection
            if vm.audioData != nil {
                AsyncNotice(kind: .success, title: "Clip ready")
                    .accessibilityIdentifier("settings-voice-add-clip-ready")
            }
            formSection
            submitButton
        }
        .onChange(of: vm.done) { _, done in if done { onBack() } }
        .onDisappear { vm.teardown() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio]) { result in
            vm.handlePicked(result)
        }
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
        DesignPane(title: "Voice sample", detail: "WAV, FLAC, OGG, or MP3") {
            DesignActionButton(
                title: vm.uploadedName == nil ? "Choose file" : "Replace file",
                role: .quiet,
                state: vm.submitting ? .disabled : .normal,
                accessibilityId: "settings-voice-add-upload",
                action: { importing = true }
            )
            if let uploadedName = vm.uploadedName {
                Text(uploadedName)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
                    .lineLimit(2)
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
            VoiceTagField(tags: vm.tags, disabled: vm.submitting, onChange: { vm.tags = $0 })
        }
    }

    private var submitButton: some View {
        DesignActionButton(
            title: "Create voice",
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
