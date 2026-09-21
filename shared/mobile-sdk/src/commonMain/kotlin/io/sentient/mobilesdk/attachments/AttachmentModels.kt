package io.sentient.mobilesdk.attachments

import kotlinx.serialization.Serializable

/** Opaque server metadata. Contains no storage path or authenticated URL. */
@Serializable
data class AttachmentRef(
    val attachmentId: String,
    val displayName: String,
    val contentType: String,
    val mediaKind: String,
    val size: Long,
)
