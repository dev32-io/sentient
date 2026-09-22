@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobiledata.draft

import platform.Foundation.NSURL
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class IosAttachmentDownloadFilenameTest {
    private val directory = "/tmp/SentientAttachments/session/att_0123456789abcdef0123456789abcdef"

    @Test
    fun empty_and_reserved_names_fall_back_inside_download_directory() {
        listOf("", ".", "..", "/tmp/.", "/tmp/..", "/").forEach { displayName ->
            val path = resolveIosAttachmentDownloadPath(directory, displayName)
            assertEquals("attachment", NSURL(fileURLWithPath = path).lastPathComponent)
            assertTrue(path.startsWith("$directory/"))
        }
    }

    @Test
    fun valid_basename_and_extension_are_preserved_after_canonicalization() {
        val path = resolveIosAttachmentDownloadPath(directory, "../report.pdf")
        assertEquals("report.pdf", NSURL(fileURLWithPath = path).lastPathComponent)
        assertEquals("$directory/report.pdf", path)
        assertEquals("$directory/photo.jpg", resolveIosAttachmentDownloadPath(directory, "..\\photo.jpg"))
    }
}
