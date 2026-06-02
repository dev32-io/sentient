package io.sentient.mobilesdk.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.SerializersModule

/**
 * Wire JSON: lenient on unknown server fields, discriminator key is "type" (matches gateway).
 * ServerMessage.Unknown is registered as the polymorphic default deserializer so any
 * unrecognised frame decodes gracefully without throwing.
 *
 * coerceInputValues=true is graceful-degradation defense-in-depth: a non-nullable
 * property that carries a default coerces an explicit `null` literal in the input to
 * that default instead of throwing. This is how a malformed conversation-feed frame
 * with `ts:null` decodes to the UNKNOWN_TS sentinel (ConversationFeedItem.ts default)
 * rather than crashing WsTransport decode. A missing key already falls back to the
 * default natively; this covers the explicit-null case too.
 */
object WireJson {
    val instance: Json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        coerceInputValues = true
        serializersModule = SerializersModule {
            polymorphicDefaultDeserializer(ServerMessage::class) { ServerMessage.Unknown.serializer() }
        }
    }
}
