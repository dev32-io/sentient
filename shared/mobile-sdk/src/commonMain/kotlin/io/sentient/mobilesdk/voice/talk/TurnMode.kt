package io.sentient.mobilesdk.voice.talk

/**
 * Turn authority carried on `audio.start` (design spec §4). Mirrors the OPTIONAL web-sdk
 * `turnMode` field (schema parity added in S2) — mobile-sdk never invents its own frames.
 *
 * Wire values: `"manual"` | `"semantic"`; ABSENT ⇒ semantic. Old clients + webui keep
 * sending nothing, so the gateway default preserves today's behavior end-to-end.
 *
 *  - [Manual]   — user interaction is the turn authority (hold-to-talk). Smart-Turn v3 is
 *                 bypassed server-side; the client's `audio.end` (release) finalizes the turn.
 *  - [Semantic] — Smart-Turn v3 is the turn authority (continuous / toggle-to-talk). Today's
 *                 full-duplex path, unchanged.
 */
enum class TurnMode(val wireValue: String) {
    Manual("manual"),
    Semantic("semantic"),
}
