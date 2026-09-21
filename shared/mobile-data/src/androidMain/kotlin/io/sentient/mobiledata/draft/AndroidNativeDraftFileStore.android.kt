package io.sentient.mobiledata.draft

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

class AndroidNativeDraftStorageException : IllegalStateException()

/**
 * App-private durable file adapter. Caller supplies ContentResolver/file opening;
 * source URI is consumed during copy and never persisted.
 */
class AndroidNativeDraftFileStore(
    appFilesDirectory: File,
    private val openSource: (String) -> InputStream?,
    private val maximumSourceBytes: Long = NATIVE_ATTACHMENT_MAX_SOURCE_BYTES,
) : NativeDraftFileStore {
    private val root = File(appFilesDirectory, "SentientDrafts/files")

    override fun path(draftId: String, attachmentId: String): String {
        requireSafeId(draftId)
        requireSafeId(attachmentId)
        return File(File(root, draftId), attachmentId).canonicalPath
    }

    override suspend fun copy(
        sourceLocation: String,
        localPath: String,
    ): NativeDraftCopiedFile = withContext(Dispatchers.IO) {
        val destination = ownedFile(localPath)
        val directory = destination.parentFile ?: throw AndroidNativeDraftStorageException()
        if (!directory.mkdirs() && !directory.isDirectory) throw AndroidNativeDraftStorageException()
        val temporary = File("${destination.path}.partial")
        try {
            if (destination.exists() || !temporary.deleteIfPresent()) throw AndroidNativeDraftStorageException()
            val input = openSource(sourceLocation) ?: throw AndroidNativeDraftStorageException()
            input.use { source ->
                FileOutputStream(temporary).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var copied = 0L
                    while (true) {
                        coroutineContext.ensureActive()
                        val count = source.read(buffer)
                        if (count < 0) break
                        copied += count
                        if (copied > maximumSourceBytes) throw NativeDraftSourceTooLargeException()
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            }
            if (!temporary.renameTo(destination)) throw AndroidNativeDraftStorageException()
            NativeDraftCopiedFile(destination.absolutePath, destination.length())
        } catch (failure: Throwable) {
            temporary.delete()
            if (failure is CancellationException || failure is AndroidNativeDraftStorageException ||
                failure is NativeDraftSourceTooLargeException
            ) {
                throw failure
            }
            throw AndroidNativeDraftStorageException()
        }
    }

    override suspend fun delete(localPath: String) = withContext(Dispatchers.IO) {
        val file = ownedFile(localPath)
        if (file.exists() && !file.delete()) throw AndroidNativeDraftStorageException()
        val temporary = File("${file.path}.partial")
        if (temporary.exists() && !temporary.delete()) throw AndroidNativeDraftStorageException()
        Unit
    }

    private fun ownedFile(localPath: String): File = File(localPath).canonicalFile.also {
        if (it.parentFile?.parentFile != root.canonicalFile) throw AndroidNativeDraftStorageException()
    }

    private fun File.deleteIfPresent(): Boolean = !exists() || delete()

    private fun requireSafeId(value: String) {
        require(Regex("^[0-9a-fA-F-]{36}$").matches(value))
    }
}
