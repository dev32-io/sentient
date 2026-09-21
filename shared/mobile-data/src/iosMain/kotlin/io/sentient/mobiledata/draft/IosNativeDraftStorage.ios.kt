@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobiledata.draft

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.native.NativeSqliteDriver
import io.sentient.mobiledata.di.IOS_CALENDAR_FILE_PROTECTION
import io.sentient.mobiledata.draft.db.DraftDatabase
import io.sentient.mobilesdk.attachments.AttachmentDownloadSink
import io.sentient.mobilesdk.attachments.AttachmentsHttpClient
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext
import platform.CoreFoundation.CFDictionaryAddValue
import platform.CoreFoundation.CFDictionaryCreateMutable
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.kCFBooleanTrue
import platform.CoreFoundation.kCFTypeDictionaryKeyCallBacks
import platform.CoreFoundation.kCFTypeDictionaryValueCallBacks
import platform.Foundation.CFBridgingRelease
import platform.Foundation.CFBridgingRetain
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileProtectionKey
import platform.Foundation.NSFileSize
import platform.Foundation.NSNumber
import platform.Foundation.NSProcessInfo
import platform.Foundation.NSUUID
import platform.Foundation.NSURL
import platform.Foundation.NSURLIsExcludedFromBackupKey
import platform.Foundation.NSUserDomainMask
import platform.Foundation.NSTemporaryDirectory
import platform.ImageIO.CGImageSourceCreateThumbnailAtIndex
import platform.ImageIO.CGImageSourceCreateWithURL
import platform.ImageIO.kCGImageSourceCreateThumbnailFromImageAlways
import platform.ImageIO.kCGImageSourceCreateThumbnailWithTransform
import platform.ImageIO.kCGImageSourceThumbnailMaxPixelSize
import platform.UIKit.UIImage
import platform.UIKit.UIImagePNGRepresentation
import platform.posix.fclose
import platform.posix.ferror
import platform.posix.fflush
import platform.posix.fileno
import platform.posix.fopen
import platform.posix.fread
import platform.posix.fsync
import platform.posix.fwrite
import platform.posix.memcpy

/** Content-free platform storage failure suitable for UI error mapping. */
class IosNativeDraftStorageException : IllegalStateException()

/** Protected Application Support driver. Session DI owns and closes returned driver. */
class IosNativeDraftDatabaseDriverFactory {
    fun create(): SqlDriver {
        val manager = NSFileManager.defaultManager
        val root = draftRoot(manager)
        val databasePath = "$root/drafts.sqlite"
        val driver = try {
            NativeSqliteDriver(
                schema = DraftDatabase.Schema,
                name = "drafts.sqlite",
                onConfiguration = { configuration ->
                    configuration.copy(
                        extendedConfig = configuration.extendedConfig.copy(
                            basePath = root,
                            foreignKeyConstraints = true,
                        ),
                    )
                },
            )
        } catch (_: Throwable) {
            throw IosNativeDraftStorageException()
        }
        try {
            driver.executeQuery(null, "SELECT 1", { QueryResult.Value(Unit) }, 0)
            protect(manager, databasePath)
            verifyProtection(manager, databasePath)
        } catch (_: Throwable) {
            driver.close()
            throw IosNativeDraftStorageException()
        }
        return driver
    }

    fun databasePath(): String = "${draftRoot(NSFileManager.defaultManager)}/drafts.sqlite"
}

/** Copies picker files into protected Application Support before returning metadata. */
class IosNativeDraftFileStore : NativeDraftFileStore {
    override fun path(draftId: String, attachmentId: String): String {
        requireSafeId(draftId)
        requireSafeId(attachmentId)
        return "files/$draftId/$attachmentId"
    }

    override suspend fun copy(
        sourceLocation: String,
        localPath: String,
    ): NativeDraftCopiedFile {
        val manager = NSFileManager.defaultManager
        val destination = resolveIosDraftFilePath(localPath, draftRoot(manager))
        val draftDirectory = destination.substringBeforeLast('/')
        ensureDirectory(manager, draftDirectory)
        protect(manager, draftDirectory)

        val temporary = "$destination.partial"
        val source = if (sourceLocation.startsWith("file://")) {
            NSURL(string = sourceLocation)
        } else {
            NSURL(fileURLWithPath = sourceLocation)
        }
        val sourcePath = source.path ?: throw IosNativeDraftStorageException()
        val scoped = source.startAccessingSecurityScopedResource()
        try {
            val sourceSize = (manager.attributesOfItemAtPath(sourcePath, error = null)?.get(NSFileSize) as? NSNumber)
                ?.longLongValue ?: throw IosNativeDraftStorageException()
            if (sourceSize > NATIVE_ATTACHMENT_MAX_SOURCE_BYTES) throw NativeDraftSourceTooLargeException()
            manager.removeItemAtPath(temporary, error = null)
            streamCopy(sourcePath, temporary)
            protect(manager, temporary)
            if (!manager.moveItemAtPath(temporary, destination, error = null)) throw IosNativeDraftStorageException()
            protect(manager, destination)
            val size = (manager.attributesOfItemAtPath(destination, error = null)?.get(NSFileSize) as? NSNumber)
                ?.longLongValue ?: throw IosNativeDraftStorageException()
            return NativeDraftCopiedFile(localPath, size)
        } catch (failure: Throwable) {
            manager.removeItemAtPath(temporary, error = null)
            if (failure is CancellationException || failure is IosNativeDraftStorageException ||
                failure is NativeDraftSourceTooLargeException
            ) throw failure
            throw IosNativeDraftStorageException()
        } finally {
            if (scoped) source.stopAccessingSecurityScopedResource()
        }
    }

    private suspend fun streamCopy(sourcePath: String, destinationPath: String) {
        val source = fopen(sourcePath, "rb") ?: throw IosNativeDraftStorageException()
        val destination = fopen(destinationPath, "wb") ?: run {
            fclose(source)
            throw IosNativeDraftStorageException()
        }
        val buffer = ByteArray(64 * 1024)
        var copied = 0L
        try {
            while (true) {
                coroutineContext.ensureActive()
                val count = buffer.usePinned {
                    fread(it.addressOf(0), 1u, buffer.size.toULong(), source)
                }
                if (count == 0uL) {
                    if (ferror(source) != 0) throw IosNativeDraftStorageException()
                    break
                }
                copied += count.toLong()
                if (copied > NATIVE_ATTACHMENT_MAX_SOURCE_BYTES) throw NativeDraftSourceTooLargeException()
                val written = buffer.usePinned { fwrite(it.addressOf(0), 1u, count, destination) }
                if (written != count) throw IosNativeDraftStorageException()
            }
            if (fflush(destination) != 0 || fsync(fileno(destination)) != 0) {
                throw IosNativeDraftStorageException()
            }
        } finally {
            fclose(source)
            fclose(destination)
        }
    }

    override suspend fun delete(localPath: String) {
        val manager = NSFileManager.defaultManager
        val resolvedPath = resolveIosDraftFilePath(localPath, draftRoot(manager))
        listOf(resolvedPath, "$resolvedPath.partial", "$resolvedPath.preview.png").forEach { path ->
            if (manager.fileExistsAtPath(path) && !manager.removeItemAtPath(path, error = null)) {
                throw IosNativeDraftStorageException()
            }
        }
    }

    override suspend fun preparePreview(
        sourceLocation: String,
        localPath: String,
        maxPixelSize: Int,
    ): Boolean {
        val manager = NSFileManager.defaultManager
        val source = if (sourceLocation.startsWith("file://")) NSURL(string = sourceLocation)
        else NSURL(fileURLWithPath = sourceLocation)
        val sourcePath = source.path ?: return false
        val scoped = source.startAccessingSecurityScopedResource()
        return try {
            val data = renderPreview(sourcePath, maxPixelSize)
            val destination = "${resolveIosDraftFilePath(localPath, draftRoot(manager))}.preview.png"
            manager.removeItemAtPath(destination, null)
            if (!manager.createFileAtPath(destination, data, null)) return false
            protect(manager, destination)
            true
        } catch (failure: CancellationException) {
            throw failure
        } catch (_: Throwable) {
            false
        } finally {
            if (scoped) source.stopAccessingSecurityScopedResource()
        }
    }

    override suspend fun preview(localPath: String, maxPixelSize: Int, mediaType: String): ByteArray? {
        require(maxPixelSize in 64..1024)
        val original = resolveIosDraftFilePath(localPath, draftRoot(NSFileManager.defaultManager))
        val sidecar = "$original.preview.png"
        val path = sidecar.takeIf { NSFileManager.defaultManager.fileExistsAtPath(it) }
            ?: original.takeUnless { mediaType == LIVE_PHOTO_MEDIA_TYPE }
            ?: return null
        val data = renderPreview(path, maxPixelSize)
        return ByteArray(data.length.toInt()).also { bytes ->
            if (bytes.isNotEmpty()) bytes.usePinned { memcpy(it.addressOf(0), data.bytes, data.length) }
        }
    }

    private fun renderPreview(path: String, maxPixelSize: Int): platform.Foundation.NSData {
        require(maxPixelSize in 64..1024)
        val url = CFBridgingRetain(NSURL(fileURLWithPath = path))
            ?: throw IosNativeDraftStorageException()
        val source = try {
            CGImageSourceCreateWithURL(url.reinterpret(), null)
                ?: throw IosNativeDraftStorageException()
        } finally {
            CFBridgingRelease(url)
        }
        val thumbnail = try {
            val options = CFDictionaryCreateMutable(
                null,
                3,
                kCFTypeDictionaryKeyCallBacks.ptr,
                kCFTypeDictionaryValueCallBacks.ptr,
            ) ?: throw IosNativeDraftStorageException()
            val maxSize = CFBridgingRetain(NSNumber(maxPixelSize))
                ?: run {
                    CFRelease(options)
                    throw IosNativeDraftStorageException()
                }
            try {
                CFDictionaryAddValue(options, kCGImageSourceCreateThumbnailFromImageAlways, kCFBooleanTrue)
                CFDictionaryAddValue(options, kCGImageSourceCreateThumbnailWithTransform, kCFBooleanTrue)
                CFDictionaryAddValue(options, kCGImageSourceThumbnailMaxPixelSize, maxSize)
                CGImageSourceCreateThumbnailAtIndex(source, 0uL, options)
                    ?: throw IosNativeDraftStorageException()
            } finally {
                CFRelease(maxSize)
                CFRelease(options)
            }
        } finally {
            CFRelease(source)
        }
        return try {
            UIImagePNGRepresentation(UIImage.imageWithCGImage(thumbnail))
                ?: throw IosNativeDraftStorageException()
        } finally {
            CFRelease(thumbnail)
        }
    }
}

/** Session-owned protected transient originals. Ktor streams chunks directly into each file. */
class IosAttachmentDownloader(private val client: AttachmentsHttpClient) {
    private val manager = NSFileManager.defaultManager
    private val root = "${NSTemporaryDirectory()}SentientAttachments/${NSUUID.UUID().UUIDString}"

    init {
        ensureDirectory(manager, root)
        protect(manager, root)
    }

    suspend fun download(attachmentId: String, displayName: String): String {
        if (!Regex("^att_[0-9a-f]{32}$").matches(attachmentId)) throw IosNativeDraftStorageException()
        val directory = "$root/$attachmentId"
        ensureDirectory(manager, directory)
        protect(manager, directory)
        val destination = resolveIosAttachmentDownloadPath(directory, displayName)
        val partial = "$destination.partial"
        manager.createFileAtPath(partial, null, mapOf(NSFileProtectionKey to IOS_CALENDAR_FILE_PROTECTION))
        val handle = fopen(partial, "wb") ?: throw IosNativeDraftStorageException()
        var closed = false
        try {
            client.download(attachmentId, object : AttachmentDownloadSink {
                override suspend fun write(bytes: ByteArray) {
                    if (bytes.isEmpty()) return
                    val written = bytes.usePinned { fwrite(it.addressOf(0), 1u, bytes.size.toULong(), handle) }
                    if (written != bytes.size.toULong()) throw IosNativeDraftStorageException()
                }
            })
            if (fclose(handle) != 0) throw IosNativeDraftStorageException()
            closed = true
            protect(manager, partial)
            manager.removeItemAtPath(destination, null)
            if (!manager.moveItemAtPath(partial, destination, null)) throw IosNativeDraftStorageException()
            protect(manager, destination)
            return destination
        } catch (failure: Throwable) {
            if (!closed) fclose(handle)
            manager.removeItemAtPath(partial, null)
            throw failure
        }
    }

    fun remove(path: String) {
        if (!path.startsWith("$root/")) return
        manager.removeItemAtPath(path.substringBeforeLast('/'), null)
    }

    fun close() {
        manager.removeItemAtPath(root, null)
    }
}

private const val IOS_ATTACHMENT_FALLBACK_NAME = "attachment"

internal fun sanitizeIosAttachmentName(displayName: String): String {
    val normalized = displayName.replace('\\', '/')
    val textualBasename = normalized.trimEnd('/').substringAfterLast('/')
    val cleanedTextualBasename = textualBasename.filter { it.code > 31 && it.code != 127 }.trim()
    if (cleanedTextualBasename.isEmpty() || cleanedTextualBasename == "." || cleanedTextualBasename == "..") {
        return IOS_ATTACHMENT_FALLBACK_NAME
    }

    val foundationBasename = NSURL(fileURLWithPath = normalized).lastPathComponent
        ?.filter { it.code > 31 && it.code != 127 }
        ?.trim()
    return foundationBasename?.takeIf {
        it.isNotEmpty() && it != "." && it != ".." && '/' !in it && '\\' !in it
    } ?: IOS_ATTACHMENT_FALLBACK_NAME
}

internal fun resolveIosAttachmentDownloadPath(directory: String, displayName: String): String {
    val safeName = sanitizeIosAttachmentName(displayName)
    if (safeName == "." || safeName == ".." || '/' in safeName || '\\' in safeName) {
        throw IosNativeDraftStorageException()
    }
    val canonicalDirectory = standardizedIosPath(directory)
    val canonicalDestination = standardizedIosPath("$directory/$safeName")
    val directoryPrefix = if (canonicalDirectory.endsWith('/')) canonicalDirectory else "$canonicalDirectory/"
    if (canonicalDestination == canonicalDirectory || !canonicalDestination.startsWith(directoryPrefix)) {
        throw IosNativeDraftStorageException()
    }
    return canonicalDestination
}

private fun standardizedIosPath(path: String): String =
    NSURL(fileURLWithPath = path).standardizedURL?.path ?: throw IosNativeDraftStorageException()

internal fun currentIosDraftRoot(): String = draftRoot(NSFileManager.defaultManager)

internal fun resolveIosDraftFilePath(localPath: String, root: String): String {
    val marker = "/files/"
    val relative = when {
        localPath.startsWith("files/") -> localPath
        marker in localPath -> "files/${localPath.substringAfterLast(marker)}"
        else -> throw IosNativeDraftStorageException()
    }
    val ids = relative.removePrefix("files/").split('/')
    if (ids.size != 2 || ids.any(String::isBlank)) throw IosNativeDraftStorageException()
    ids.forEach(::requireSafeId)
    return "$root/$relative"
}

private fun draftRoot(manager: NSFileManager): String {
    val support = manager.URLsForDirectory(NSApplicationSupportDirectory, NSUserDomainMask)
        .mapNotNull { (it as? NSURL)?.path }
        .firstOrNull()?.takeIf(String::isNotBlank)
        ?: throw IosNativeDraftStorageException()
    val root = "$support/SentientDrafts"
    ensureDirectory(manager, root)
    protect(manager, root)
    return root
}

private fun ensureDirectory(manager: NSFileManager, path: String) {
    if (!manager.createDirectoryAtPath(path, true, null, null)) throw IosNativeDraftStorageException()
}

private fun protect(manager: NSFileManager, path: String) {
    listOf(path, "$path-wal", "$path-shm").forEach { candidate ->
        if (!manager.fileExistsAtPath(candidate)) return@forEach
        if (!manager.setAttributes(mapOf(NSFileProtectionKey to IOS_CALENDAR_FILE_PROTECTION), candidate, null)) {
            throw IosNativeDraftStorageException()
        }
        NSURL(fileURLWithPath = candidate).setResourceValue(
            true,
            NSURLIsExcludedFromBackupKey ?: "NSURLIsExcludedFromBackupKey",
            null,
        )
    }
}

private fun verifyProtection(manager: NSFileManager, path: String) {
    if (!manager.fileExistsAtPath(path)) throw IosNativeDraftStorageException()
    if (manager.attributesOfItemAtPath(path, null)?.get(NSFileProtectionKey) == IOS_CALENDAR_FILE_PROTECTION) return
    val environment = NSProcessInfo.processInfo.environment
    if (environment["SIMULATOR_DEVICE_NAME"] == null && environment["SIMULATOR_ROOT"] == null) {
        throw IosNativeDraftStorageException()
    }
}

private fun requireSafeId(value: String) {
    require(Regex("^[0-9a-fA-F-]{36}$").matches(value))
}
