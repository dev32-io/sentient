// ---------------------------------------------------------------------------
// VoiceCaps — the voice create-form field caps, read from the SDK's VoiceFieldCaps
// (mobile-sdk `VoiceModels.kt`, itself a mirror of shared/config ttsConfigSchema).
// Single source of truth; no magic numbers in the form. The gateway TRUNCATES
// over-cap metadata rather than rejecting, so enforcing these client-side is a
// cosmetic fail-fast (matches the webui AddVoiceModal / TagEditor).
// ---------------------------------------------------------------------------
import MobileData

enum VoiceCaps {
    static let nameMax = Int(VoiceFieldCaps.shared.NAME_MAX_LEN)
    static let descriptionMax = Int(VoiceFieldCaps.shared.DESCRIPTION_MAX_LEN)
    static let tagMax = Int(VoiceFieldCaps.shared.TAG_MAX_LEN)
    static let maxTags = Int(VoiceFieldCaps.shared.MAX_TAGS)
}
