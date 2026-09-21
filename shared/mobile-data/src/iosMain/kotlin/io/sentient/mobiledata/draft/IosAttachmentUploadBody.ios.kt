@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobiledata.draft

import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.writeFully
import io.sentient.mobilesdk.attachments.AttachmentUploadBody
import kotlinx.cinterop.refTo
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileSize
import platform.Foundation.NSNumber
import platform.posix.O_RDONLY
import platform.posix.close
import platform.posix.open
import platform.posix.read

class IosAttachmentUploadBody(localPath: String) : AttachmentUploadBody {
    private val resolvedPath = resolveIosDraftFilePath(localPath, currentIosDraftRoot())
    override val size: Long =
        (NSFileManager.defaultManager.attributesOfItemAtPath(resolvedPath, null)?.get(NSFileSize) as? NSNumber)
            ?.longLongValue ?: throw IosNativeDraftStorageException()

    override suspend fun writeTo(channel: ByteWriteChannel) {
        val descriptor = open(resolvedPath, O_RDONLY)
        if (descriptor < 0) throw IosNativeDraftStorageException()
        val buffer = ByteArray(CHUNK_SIZE)
        try {
            while (true) {
                val count = read(descriptor, buffer.refTo(0), buffer.size.toULong()).toInt()
                if (count == 0) break
                if (count < 0) throw IosNativeDraftStorageException()
                channel.writeFully(buffer, 0, count)
            }
        } finally {
            close(descriptor)
        }
    }

    private companion object { const val CHUNK_SIZE = 64 * 1024 }
}
