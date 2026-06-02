package io.sentient.mobilesdk.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.SerializersModule

/**
 * Wire JSON: lenient on unknown server fields, discriminator key is "type" (matches gateway).
 * ServerMessage.Unknown is registered as the polymorphic default deserializer so any
 * unrecognised frame decodes gracefully without throwing.
 */
object WireJson {
    val instance: Json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        serializersModule = SerializersModule {
            polymorphicDefaultDeserializer(ServerMessage::class) { ServerMessage.Unknown.serializer() }
        }
    }
}
