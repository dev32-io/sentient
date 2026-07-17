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

private let modeOptions: [SegmentOption] = [
    SegmentOption(id: "record", label: "Record"),
    SegmentOption(id: "upload", label: "Upload"),
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
            RowSegmented(
                options: modeOptions,
                selectedId: vm.mode.rawValue,
                accessibilityId: "settings-voice-add-mode",
                onSelect: { vm.mode = VoiceAddViewModel.Mode(rawValue: $0) ?? .record }
            )
            captureSection
            if vm.audioData != nil {
                Text("Clip ready.")
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.sage)
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
        VStack(alignment: .leading, spacing: Space.xs) {
            Button { importing = true } label: {
                HStack(spacing: Space.xs) {
                    Image(systemName: "folder")
                    Text(vm.uploadedName == nil ? "Choose file" : "Replace file")
                        .font(Typo.ui(TypeScale.sm, .semibold))
                }
                .foregroundStyle(DuskColors.ink)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(vm.submitting)
            .accessibilityIdentifier("settings-voice-add-upload")
            Text(vm.uploadedName ?? "WAV, FLAC, OGG, or MP3.")
                .font(Typo.ui(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
        }
    }

    private var formSection: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            field(label: "Name") {
                TextField("e.g. Dad", text: Binding(get: { vm.name }, set: { vm.setName($0) }))
                    .textFieldStyle(.plain)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                    .accessibilityIdentifier("settings-voice-add-name")
            }
            field(label: "Description") {
                TextField(
                    "Optional — how this voice sounds",
                    text: Binding(get: { vm.description }, set: { vm.setDescription($0) }),
                    axis: .vertical
                )
                .lineLimit(2...4)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("settings-voice-add-description")
            }
            RowSelect(
                label: "Language",
                options: VoiceLanguages.formOptions.map { SelectOption(id: $0.code, label: $0.label) },
                selectedId: vm.language,
                accessibilityId: "settings-voice-add-language",
                onSelect: { vm.language = $0 }
            )
            VoiceTagField(tags: vm.tags, disabled: vm.submitting, onChange: { vm.tags = $0 })
        }
    }

    private var submitButton: some View {
        Button { vm.submit() } label: {
            Text(vm.submitting ? "Creating…" : "Create voice")
                .font(.system(size: TypeScale.base, weight: .semibold))
                .foregroundStyle(vm.canSubmit ? DuskColors.bg : DuskColors.ink4)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.sm)
                .background(vm.canSubmit ? DuskColors.accent : DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.md))
        }
        .buttonStyle(.plain)
        .disabled(!vm.canSubmit)
        .accessibilityIdentifier("settings-voice-add-submit")
    }

    private func field(label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            content()
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
        }
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = vm.notice {
            Button { vm.notice = nil } label: {
                Text(notice)
                    .font(Typo.ui(TypeScale.xs, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.sm)
                    .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-voice-add-notice")
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
