// ---------------------------------------------------------------------------
// Routes — the closed set of navigation destinations.
//
// A chat is a route PARAMETERIZED by sessionId (optional; absent = new chat), so
// switching conversation is a navigation that recreates the chat ViewModel → clean
// per-conversation state. Settings + history are destinations / overlays reached
// from chat. The splash route is the entry decision point (setup / login / chat).
// ---------------------------------------------------------------------------
package io.sentient.android.nav

/** Query-param key carried by the chat route. */
const val ARG_SESSION_ID = "sessionId"

object Routes {
    const val SPLASH = "splash"
    const val SETUP = "setup"
    const val LOGIN = "login"

    /** Chat is parameterized by an optional sessionId; omit for a new chat. */
    const val CHAT = "chat?$ARG_SESSION_ID={$ARG_SESSION_ID}"

    const val SETTINGS = "settings"

    // ── Settings category pages (flat routes; one composable() each in AppNavHost) ──
    const val SETTINGS_MEMORY = "settings/memory"
    const val SETTINGS_PERSONALITIES = "settings/personalities"
    const val SETTINGS_VOICE = "settings/voice"
    const val SETTINGS_VOICE_ADD = "settings/voice/add"
    const val SETTINGS_VOICE_FISH = "settings/voice/fish"
    const val SETTINGS_AUDIO = "settings/audio"
    const val SETTINGS_MODEL = "settings/model"
    const val SETTINGS_TOOLS = "settings/tools"
    const val SETTINGS_SYSTEM_PROMPT = "settings/system-prompt"
    const val SETTINGS_ADVANCED = "settings/advanced"
    const val SETTINGS_ACCOUNT = "settings/account"
    const val SETTINGS_DEVICES = "settings/devices"
    const val SETTINGS_MEMBERS = "settings/members"
    const val SETTINGS_SECRETS = "settings/secrets"
    const val SETTINGS_DIAGNOSTICS = "settings/diagnostics"

    /** Full-screen blocking gate routed AHEAD of the authed destination on a mandatory update. */
    const val FORCE_UPDATE = "force-update"

    /** Build a concrete chat route. Null sessionId → new chat (no query value). */
    fun chat(sessionId: String?): String =
        if (sessionId == null) "chat" else "chat?$ARG_SESSION_ID=$sessionId"
}
