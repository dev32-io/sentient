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

    /** Full-screen blocking gate routed AHEAD of the authed destination on a mandatory update. */
    const val FORCE_UPDATE = "force-update"

    /** Build a concrete chat route. Null sessionId → new chat (no query value). */
    fun chat(sessionId: String?): String =
        if (sessionId == null) "chat" else "chat?$ARG_SESSION_ID=$sessionId"
}
