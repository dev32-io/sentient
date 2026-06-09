// ---------------------------------------------------------------------------
// Connector — the boundary contract between the SDK and app-registered
// connectors. Mirrors the ROLE of web-sdk's `Connector` (connector-types.ts):
// a capability-scoped unit that receives gateway frames and filters internally.
//
// web-sdk connectors register per-type handlers via `onMessage(type, handler)`
// and the SDK pre-routes by type. The mobile-sdk collapses that to a single
// `handle(msg)` entry point: the MessageRouter broadcasts EVERY decoded frame
// to EVERY connector, and each connector switches on the sealed [ServerMessage]
// internally (an exhaustive `when`, idiomatic for the Kotlin sealed hierarchy)
// — the same broadcast-and-filter dispatch model, expressed Kotlin-side.
//
// Defined in C3 so the router can compile; C4 IMPLEMENTS this interface for the
// concrete connectors (transcript, assistant-message, audio, task, etc.).
// Do NOT redefine it in C4 — extend usage only.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage

/**
 * A capability-scoped consumer of gateway frames.
 *
 * The router hands every decoded [ServerMessage] to [handle]; the connector
 * inspects the sealed type and reacts only to the frames it owns, ignoring the
 * rest. Binary audio frames bypass [handle] entirely — they reach only the
 * connector wired as the router's audio connector, via [handleBinary].
 */
interface Connector {
    /**
     * Capability string this connector represents (e.g. "assistant.audio.response").
     * Matches the capability advertised in `session.configure` and referenced by
     * `connector.cancelled`.
     */
    val capability: String

    /** Handle a decoded control frame. Filter internally; ignore unowned types. */
    fun handle(msg: ServerMessage)

    /**
     * Handle a raw binary audio frame. Only the connector wired as the router's
     * audio connector receives these. Default no-op so non-audio connectors need
     * not implement it.
     */
    fun handleBinary(bytes: ByteArray) {}
}
