// ---------------------------------------------------------------------------
// MemberDefaults — the default ProfileBody sent when an admin adds a household
// member from mobile.
//
// The gateway POST /admin/users requires a full profile (ProfileV1 minus
// userId/schemaVersion); the webui collects it via a 4-step wizard (model/voice
// pickers). Per the mobile-settings-parity plan, mobile's Add-member flow is the
// lean name + PIN dialog, so we send the SAME initial defaults the webui wizard
// starts from (AccountWizard INITIAL_DRAFT) and let the new member reconfigure
// model/voice from their own settings after first login. The gateway then runs
// applyProfileDefaults (seeds tools/toolsets) on top.
//
// Mirrors android/.../settings/members/MemberDefaults.kt field-for-field. A
// STATIC template — never the admin's own live profile (that was a review-flagged
// architecture violation: MembersViewModel must not depend on ProfileRepository).
// ---------------------------------------------------------------------------
import Foundation
import MobileData

private let defaultModelProvider = "ollama-cloud"
private let defaultVoiceProvider = "local-tts"
private let defaultVoiceId = "default"
private let defaultPersonaTemplate = "default"
private let defaultAudioChannel = "voice"
private let defaultCompressionThreshold = 0.5
private let defaultMaxTokens: Int32 = 1024
private let defaultReasoningEffort = "minimal"

/// Mirrors webui AccountWizard INITIAL_DRAFT.profile; gateway applyProfileDefaults fills tools.
func defaultMemberProfile() -> ProfileBody {
    ProfileBody(
        model: ProfileModelRef(provider: defaultModelProvider, id: ""),
        voice: ProfileVoiceRef(provider: defaultVoiceProvider, id: defaultVoiceId),
        audio: ProfileAudio(ttsEnabled: true, channel: defaultAudioChannel),
        persona: ProfilePersona(template: defaultPersonaTemplate, overrides: ""),
        tools: ProfileTools(enabled: [:], toolsets: nil),
        compression: ProfileCompression(threshold: defaultCompressionThreshold),
        advanced: ProfileAdvanced(
            extraSystemPrompt: "",
            maxTokens: defaultMaxTokens,
            reasoningEffort: defaultReasoningEffort
        )
    )
}
