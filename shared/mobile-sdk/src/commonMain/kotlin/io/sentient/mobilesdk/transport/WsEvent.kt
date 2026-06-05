// ---------------------------------------------------------------------------
// WsEvent — one ordered event over the WS receive boundary.
//
// The gateway delivers control (TEXT/JSON) and audio (BINARY) frames on the
// same socket, and their relative order is part of the wire contract: the
// trailing audio frames of a reply arrive BEFORE the `connector.audio.done`
// control frame. Splitting them into two flows drained by two collectors loses
// that cross-stream order — `audio.done` could be processed before the audio it
// terminates, and the AssistantAudioResponseConnector then drops the late audio
// (tail clip on long replies, total silence on short ones).
//
// WsTransport merges both into ONE [WsEvent] stream from its single sequential
// pump, so a single consumer sees frames in EXACT arrival order. This is the
// internal delivery shape only — the wire frames themselves are unchanged.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.protocol.ServerMessage

/**
 * One ordered receive event from the WS transport. Sealed so the single
 * consumer gets exhaustive `when` dispatch (control vs audio).
 */
sealed interface WsEvent {
    /** A decoded control frame (TEXT → [ServerMessage] via WireJson). */
    data class Control(val message: ServerMessage) : WsEvent

    /**
     * A raw binary audio frame.
     *
     * equals/hashCode use structural ByteArray comparison so ordering tests can
     * assert on the byte payload (Kotlin's data-class default would use
     * reference identity on the array).
     */
    data class Audio(val bytes: ByteArray) : WsEvent {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Audio) return false
            return bytes.contentEquals(other.bytes)
        }

        override fun hashCode(): Int = bytes.contentHashCode()
    }
}
