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
    /**
     * A decoded control frame (TEXT → [ServerMessage] via WireJson).
     *
     * [seq] / [epoch] are the gateway's resume stamps peeled from the raw JSON
     * (0 / null when absent). The SDK feeds them to the [ResumeCursor] for
     * replay dedup — read generically off the wire so they need not be added to
     * every [ServerMessage] variant.
     */
    data class Control(val message: ServerMessage, val seq: Long = 0, val epoch: Long? = null) : WsEvent

    /**
     * A raw binary audio frame, header already peeled by [WsTransport].
     *
     * [bytes] is the PAYLOAD ONLY (the 9-byte seq+type header is stripped before
     * delivery) so the audio connector hands clean Opus bytes to the pipeline.
     * [seq] is the frame's gateway sequence number (0 when the frame carried no
     * seq); the SDK feeds it to the [ResumeCursor] for replay dedup.
     *
     * equals/hashCode use structural ByteArray comparison so ordering tests can
     * assert on the byte payload (Kotlin's data-class default would use
     * reference identity on the array).
     */
    data class Audio(val bytes: ByteArray, val seq: Long = 0) : WsEvent {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Audio) return false
            return seq == other.seq && bytes.contentEquals(other.bytes)
        }

        override fun hashCode(): Int = 31 * bytes.contentHashCode() + seq.hashCode()
    }
}
