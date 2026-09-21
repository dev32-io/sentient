package io.sentient.mobiledata.draft

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class IosDraftPathTest {
    private val draftId = "11111111-1111-4111-8111-111111111111"
    private val attachmentId = "22222222-2222-4222-8222-222222222222"

    @Test
    fun persisted_attachment_path_survives_sandbox_container_relocation() {
        val relative = "files/$draftId/$attachmentId"
        val staleAbsolute = "/old-container/Application Support/SentientDrafts/$relative"

        assertEquals("/new-root/$relative", resolveIosDraftFilePath(relative, "/new-root"))
        assertEquals("/new-root/$relative", resolveIosDraftFilePath(staleAbsolute, "/new-root"))
    }

    @Test
    fun persisted_attachment_path_cannot_escape_draft_storage() {
        assertFailsWith<IosNativeDraftStorageException> {
            resolveIosDraftFilePath("files/$draftId/../outside", "/new-root")
        }
    }
}
