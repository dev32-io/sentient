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
// NOTE: this default lives in the Android UI layer only because this agent's scope
// is the Android settings pages — a shared `defaultMemberProfile()` in mobile-sdk
// would be the tidier long-term home. Flagged in the handover.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.members

import io.sentient.mobilesdk.settings.ProfileAdvanced
import io.sentient.mobilesdk.settings.ProfileAudio
import io.sentient.mobilesdk.settings.ProfileBody
import io.sentient.mobilesdk.settings.ProfileCompression
import io.sentient.mobilesdk.settings.ProfileModelRef
import io.sentient.mobilesdk.settings.ProfilePersona
import io.sentient.mobilesdk.settings.ProfileTools
import io.sentient.mobilesdk.settings.ProfileVoiceRef

private const val DEFAULT_PROVIDER = "ollama-cloud"
private const val DEFAULT_VOICE_PROVIDER = "local-tts"
private const val DEFAULT_VOICE_ID = "default"
private const val DEFAULT_PERSONA = "default"
private const val DEFAULT_COMPRESSION = 0.5
private const val DEFAULT_MAX_TOKENS = 1024
private const val DEFAULT_REASONING = "minimal"

/** Mirrors webui AccountWizard INITIAL_DRAFT.profile; gateway applyProfileDefaults fills tools. */
fun defaultMemberProfile(): ProfileBody = ProfileBody(
    model = ProfileModelRef(provider = DEFAULT_PROVIDER, id = ""),
    voice = ProfileVoiceRef(provider = DEFAULT_VOICE_PROVIDER, id = DEFAULT_VOICE_ID),
    audio = ProfileAudio(ttsEnabled = true, channel = "voice"),
    persona = ProfilePersona(template = DEFAULT_PERSONA, overrides = ""),
    tools = ProfileTools(enabled = emptyMap()),
    compression = ProfileCompression(threshold = DEFAULT_COMPRESSION),
    advanced = ProfileAdvanced(extraSystemPrompt = "", maxTokens = DEFAULT_MAX_TOKENS, reasoningEffort = DEFAULT_REASONING),
)
