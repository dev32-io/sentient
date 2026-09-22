package io.sentient.mobiledata.draft

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import io.sentient.mobiledata.draft.db.DraftDatabase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class NativeDraftStorePersistenceTest {
    @Test
    fun `native copy preserves bytes and stops beyond configured source bound`() = runBlocking {
        val root = Files.createTempDirectory("sentient-native-copy-").toFile()
        try {
            val bytes = ByteArray(5) { it.toByte() }
            val store = AndroidNativeDraftFileStore(root, { ByteArrayInputStream(bytes) }, maximumSourceBytes = 5)
            val draftId = "11111111-1111-4111-8111-111111111111"
            val attachmentId = "22222222-2222-4222-8222-222222222222"
            val path = store.path(draftId, attachmentId)
            assertEquals(5, store.copy("fixture", path).sizeBytes)
            assertContentEquals(bytes, File(path).readBytes())

            val rejectedId = "33333333-3333-4333-8333-333333333333"
            val rejectedPath = store.path(draftId, rejectedId)
            val limited = AndroidNativeDraftFileStore(root, { ByteArrayInputStream(bytes) }, maximumSourceBytes = 4)
            assertFailsWith<NativeDraftSourceTooLargeException> { limited.copy("fixture", rejectedPath) }
            assertTrue(!File(rejectedPath).exists())
            assertTrue(!File("$rejectedPath.partial").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `explicit preview source is copied into draft ownership and cleaned with original`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            val imported = opened.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport(
                    "fixture",
                    "fixture.livephoto.zip",
                    LIVE_PHOTO_MEDIA_TYPE,
                    previewSourceLocation = "selected-still",
                ),
            )
            val attachment = imported.attachments.single()
            val previewPath = File("${attachment.localPath}.preview")
            assertEquals(listOf("selected-still"), fixture.previewSources)
            assertTrue(previewPath.exists())
            opened.close()

            val reopened = fixture.open()
            val restored = reopened.store.list().drafts.single().attachments.single()
            assertEquals(attachment, restored)
            assertTrue(previewPath.exists())
            assertContentEquals(byteArrayOf(1, 2, 3), previewPath.readBytes())

            reopened.store.remove(imported.id, imported.revision)
            assertTrue(!File(attachment.localPath).exists())
            assertTrue(!previewPath.exists())
            reopened.close()
        }
    }

    @Test
    fun `preview resolves only account scoped image identity`() = runBlocking {
        fixture().use { fixture ->
            val owner = fixture.open("account-a")
            val draft = owner.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            val attachment = owner.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.jpg", "image/jpeg"),
            ).attachments.single()

            assertContentEquals(fixture.bytes, owner.store.previewAttachment(attachment.id, 320)!!)
            assertEquals(1, fixture.previewPaths.size)
            owner.close()

            val other = fixture.open("account-b")
            assertEquals(null, other.store.previewAttachment(attachment.id, 320))
            assertEquals(1, fixture.previewPaths.size)
            other.close()
        }
    }

    @Test
    fun `held preview does not block removal and cannot return removed attachment`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val coordinator = NativeDraftCoordinator(opened.store)
            val draft = opened.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            val attachment = opened.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.jpg", "image/jpeg"),
            ).attachments.single()
            val callerThread = Thread.currentThread()
            fixture.holdPreview = true

            val preview = async { coordinator.previewAttachment(attachment.id, 320) }
            withTimeout(2_000) { fixture.previewStarted.await() }
            assertTrue(fixture.previewThread != callerThread, "preview work must leave the caller dispatcher")

            val removed = withTimeout(2_000) { coordinator.removeAttachment(draft.id, attachment.id) }
            assertTrue(removed.attachments.isEmpty(), "draft mutation must not wait for preview work")
            fixture.releasePreview.complete(Unit)

            assertEquals(null, withTimeout(2_000) { preview.await() })
            assertTrue(coordinator.snapshot.value.drafts.single().attachments.isEmpty())
            opened.close()
        }
    }

    @Test
    fun `close during held preview prevents later database access and publication`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open("account-a")
            val coordinator = NativeDraftCoordinator(opened.store, opened.driver)
            val draft = opened.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            val attachment = opened.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.jpg", "image/jpeg"),
            ).attachments.single()
            fixture.holdPreview = true

            val preview = async { coordinator.previewAttachment(attachment.id, 320) }
            withTimeout(2_000) { fixture.previewStarted.await() }
            withTimeout(2_000) { coordinator.close() }
            withTimeout(2_000) { coordinator.close() }
            assertEquals(null, coordinator.previewAttachment(attachment.id, 320))

            val successor = fixture.open("account-b")
            assertEquals(null, successor.store.previewAttachment(attachment.id, 320))
            fixture.releasePreview.complete(Unit)

            assertEquals(null, withTimeout(2_000) { preview.await() })
            assertEquals(1, fixture.previewPaths.size)
            assertTrue(successor.store.list().drafts.isEmpty())
            successor.close()
        }
    }

    @Test
    fun `fixture drafts and copied bytes survive reopen and stay account scoped`() = runBlocking {
        fixture().use { fixture ->
            val first = fixture.open("account-a")
            val existing = first.store.save(
                NativeDraftWrite(sessionId = "session-1", text = "existing", attachments = emptyList()),
                null,
            )
            first.store.importAttachment(
                existing.id,
                existing.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            first.store.save(NativeDraftWrite(text = "new one", attachments = emptyList()), null)
            first.store.save(NativeDraftWrite(text = "new two", attachments = emptyList()), null)
            assertFailsWith<NativeDraftConflictException> {
                first.store.save(
                    NativeDraftWrite(sessionId = "session-1", text = "duplicate", attachments = emptyList()),
                    null,
                )
            }
            first.close()

            val reopened = fixture.open("account-a")
            val restored = reopened.store.list()
            assertEquals(3, restored.drafts.size)
            val storedFile = File(restored.drafts.first { it.sessionId == "session-1" }.attachments.single().localPath)
            assertContentEquals(fixture.bytes, storedFile.readBytes())
            reopened.close()

            val other = fixture.open("account-b")
            assertTrue(other.store.list().drafts.isEmpty())
            other.close()
        }
    }

    @Test
    fun `first send receipt binds newer edits to authoritative session across reopen`() = runBlocking {
        fixture().use { fixture ->
            val first = fixture.open()
            val draft = first.store.save(NativeDraftWrite(text = "send this", attachments = emptyList()), null)
            val pending = first.store.beginSend(draft.id, draft.revision, "d_anchor", "surface-a")
            first.close()

            val reopened = fixture.open()
            assertEquals(pending, reopened.store.beginSend(draft.id, draft.revision, "d_anchor", "surface-a"))
            val coordinator = NativeDraftCoordinator(reopened.store)
            coordinator.restore()
            coordinator.saveText(draft.id, null, "newer edit")
            val receipt = coordinator.acknowledge(pending.pendingId, "accepted-session")
            assertTrue(receipt.found)
            assertEquals("accepted-session", receipt.restoredDraft?.sessionId)
            assertTrue(coordinator.snapshot.value.pendingSends.isEmpty())
            coordinator.saveText(draft.id, null, "latest edit")
            reopened.close()

            val restored = fixture.open()
            assertEquals("accepted-session", restored.store.list().drafts.single().sessionId)
            assertEquals("latest edit", restored.store.list().drafts.single().text)
            restored.close()
        }
    }

    @Test
    fun `receipt for wrong known session leaves pending and draft unchanged`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(
                NativeDraftWrite(sessionId = "original-session", text = "send this", attachments = emptyList()),
                null,
            )
            val pending = opened.store.beginSend(draft.id, draft.revision, "d_anchor", "surface-a")

            val receipt = opened.store.reconcileSend(
                pending.pendingId,
                NativeSendReconciliation.ACKNOWLEDGED,
                acknowledgedSessionId = "wrong-session",
            )

            assertTrue(!receipt.found)
            assertEquals(listOf(pending), opened.store.list().pendingSends)
            assertEquals("original-session", opened.store.list().drafts.single().sessionId)
            opened.close()
        }
    }

    @Test
    fun `discarded visible draft cannot be recreated by late navigation save`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val coordinator = NativeDraftCoordinator(opened.store)
            val draft = coordinator.saveText(null, "existing-session", "unsent")!!

            assertTrue(coordinator.discard(draft.id))
            assertEquals(null, coordinator.saveText(draft.id, "existing-session", "unsent"))
            assertTrue(coordinator.restore().drafts.isEmpty())
            opened.close()
        }
    }

    @Test
    fun `discard fences late attachment import and next edit gets a new draft`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val coordinator = NativeDraftCoordinator(opened.store)
            val draft = coordinator.saveText(null, "existing-session", "old edit")!!
            val discarded = async { coordinator.discardedDrafts.first() }

            assertTrue(coordinator.discard(draft.id))
            assertEquals(draft.id, discarded.await())
            assertFailsWith<NativeDraftDiscardedException> {
                coordinator.importAttachment(
                    draft.id,
                    "existing-session",
                    NativeDraftAttachmentImport("fixture", "late.txt", "text/plain"),
                )
            }
            assertEquals(null, coordinator.saveText(draft.id, "existing-session", "late save"))

            val replacement = coordinator.saveText(null, "existing-session", "new edit")!!
            assertTrue(replacement.id != draft.id)
            assertEquals(listOf(replacement), coordinator.restore().drafts)
            opened.close()
        }
    }

    @Test
    fun `discard conflict preserves frozen pending draft and copied bytes across reopen`() = runBlocking {
        fixture().use { fixture ->
            val first = fixture.open()
            val draft = first.store.save(NativeDraftWrite(text = "frozen", attachments = emptyList()), null)
            val attached = first.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            val pending = first.store.beginSend(attached.id, attached.revision, "d_anchor", "surface-a")
            val localFile = File(attached.attachments.single().localPath)
            val coordinator = NativeDraftCoordinator(first.store)
            coordinator.restore()

            assertFailsWith<NativePendingSendConflictException> { coordinator.discard(attached.id) }
            assertTrue(localFile.exists())
            first.close()

            val reopened = fixture.open()
            val snapshot = reopened.store.list()
            assertEquals(listOf(pending), snapshot.pendingSends)
            assertEquals(attached, snapshot.drafts.single())
            assertContentEquals(fixture.bytes, localFile.readBytes())
            reopened.close()
        }
    }

    @Test
    fun `local delete discards frozen send newer edits and copied bytes across reopen`() = runBlocking {
        fixture().use { fixture ->
            val first = fixture.open()
            val draft = first.store.save(
                NativeDraftWrite(sessionId = "session-delete", text = "unsent", attachments = emptyList()),
                null,
            )
            val attached = first.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            val localFile = File(attached.attachments.single().localPath)
            first.store.beginSend(attached.id, attached.revision, "d_anchor", "surface-a")
            first.store.save(
                NativeDraftWrite(attached.id, "session-delete", "newer edit", attached.attachments),
                attached.revision,
            )
            val intent = first.store.saveDeleteIntent("session-delete")
            assertTrue(!localFile.exists())
            first.close()

            val reopened = fixture.open()
            val snapshot = reopened.store.list()
            assertTrue(snapshot.drafts.isEmpty())
            assertTrue(snapshot.pendingSends.isEmpty())
            assertEquals(listOf(intent), snapshot.deleteIntents)
            assertFailsWith<NativeConversationPendingDeleteException> {
                reopened.store.save(
                    NativeDraftWrite(sessionId = "session-delete", text = "resurrect", attachments = emptyList()),
                    null,
                )
            }
            reopened.close()
        }
    }

    @Test
    fun `Edit Remove targets thawed frozen file while preserving newer edit and existing conversation`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(
                NativeDraftWrite(sessionId = "session-edit", text = "frozen", attachments = emptyList()),
                null,
            )
            val attached = opened.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            val pending = opened.store.beginSend(attached.id, attached.revision, "d_anchor", "surface-a")
            opened.store.save(
                NativeDraftWrite(attached.id, "session-edit", "newer edit", emptyList()),
                attached.revision,
            )

            val coordinator = NativeDraftCoordinator(opened.store)
            coordinator.restore()
            val restored = checkNotNull(coordinator.notCommitted(pending.pendingId))
            assertEquals(pending.draftId, restored.id)
            assertEquals("session-edit", restored.sessionId)
            assertEquals(listOf("fixture.txt"), restored.attachments.map { it.displayName })

            val edited = coordinator.removeAttachment(restored.id, restored.attachments.single().id)
            assertTrue(edited.attachments.isEmpty())
            val snapshot = coordinator.snapshot.value
            assertEquals(setOf("frozen", "newer edit"), snapshot.drafts.map { it.text }.toSet())
            assertEquals("session-edit", snapshot.drafts.single { it.text == "frozen" }.sessionId)
            assertEquals(null, snapshot.drafts.single { it.text == "newer edit" }.sessionId)
            assertTrue(snapshot.drafts.single { it.text == "newer edit" }.attachments.isEmpty())
            assertTrue(snapshot.pendingSends.isEmpty())

            val revised = coordinator.beginSend(edited.id, "d_revised", "surface-a")
            assertTrue(revised.pendingId != pending.pendingId, "revised Send must mint a fresh pending identity")
            opened.close()
        }
    }

    @Test
    fun `confirmed uncommitted send restores cleared draft for editing`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(NativeDraftWrite(text = "frozen", attachments = emptyList()), null)
            val attached = opened.store.importAttachment(
                draft.id, draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            val pending = opened.store.beginSend(attached.id, attached.revision, "d_anchor", "surface-a")
            val cleared = opened.store.save(NativeDraftWrite(attached.id, null, "", emptyList()), attached.revision)

            assertEquals(
                cleared.id,
                opened.store.reconcileSend(pending.pendingId, NativeSendReconciliation.NOT_COMMITTED).restoredDraft?.id,
            )

            val restored = opened.store.list().drafts.single()
            assertEquals(cleared.id, restored.id)
            assertEquals("frozen", restored.text)
            assertEquals(listOf("fixture.txt"), restored.attachments.map { it.displayName })
            opened.close()
        }
    }

    @Test
    fun `remote delete after beginSend before clear keeps one unchanged detached draft`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(
                NativeDraftWrite(sessionId = "session-delete", text = "send this", attachments = emptyList()),
                null,
            )
            val attached = opened.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            opened.store.beginSend(attached.id, attached.revision, "d_anchor", "surface-a")

            opened.store.detachDeletedSession("session-delete")

            val snapshot = opened.store.list()
            assertEquals(1, snapshot.drafts.size)
            assertEquals(attached.id, snapshot.drafts.single().id)
            assertEquals(null, snapshot.drafts.single().sessionId)
            assertEquals("send this", snapshot.drafts.single().text)
            assertEquals(listOf("fixture.txt"), snapshot.drafts.single().attachments.map { it.displayName })
            assertTrue(snapshot.pendingSends.isEmpty())
            opened.close()
        }
    }

    @Test
    fun `remote delete atomically thaws pending text and attachments`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(
                NativeDraftWrite(sessionId = "session-delete", text = "send this", attachments = emptyList()),
                null,
            )
            val attached = opened.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            val localFile = File(attached.attachments.single().localPath)
            opened.store.beginSend(attached.id, attached.revision, "d_anchor", "surface-a")
            opened.store.save(
                NativeDraftWrite(attached.id, "session-delete", "", emptyList()),
                attached.revision,
            )

            opened.store.detachDeletedSession("session-delete")

            val snapshot = opened.store.list()
            assertEquals(listOf("send this"), snapshot.drafts.map { it.text })
            assertEquals(listOf("fixture.txt"), snapshot.drafts.single().attachments.map { it.displayName })
            assertTrue(localFile.exists())
            assertTrue(snapshot.drafts.single().sessionId == null)
            assertTrue(snapshot.pendingSends.isEmpty())
            assertTrue(snapshot.deleteIntents.isEmpty())
            opened.close()
        }
    }

    @Test
    fun `failed partial picker copy leaves no owned file or picker reference`() = runBlocking {
        fixture(failingCopy = true).use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            assertFailsWith<AndroidNativeDraftStorageException> {
                opened.store.importAttachment(
                    draft.id,
                    draft.revision,
                    NativeDraftAttachmentImport("ephemeral-picker-uri", "fixture.txt", "text/plain"),
                )
            }
            assertTrue(fixture.root.walkTopDown().none { it.name.endsWith(".partial") })
            val snapshot = opened.store.list()
            assertTrue(snapshot.drafts.single().attachments.isEmpty())
            assertTrue("ephemeral-picker-uri" !in snapshot.toString())
            opened.close()
        }
    }

    @Test
    fun `copy followed by revision conflict deletes tracked bytes`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(NativeDraftWrite(text = "before", attachments = emptyList()), null)
            fixture.onCopy = {
                opened.database.draftDatabaseQueries.updateDraft(
                    null, "concurrent", draft.revision + 1L, 1235L,
                    "account-a", "wss|example.test|443|api/v1/ws", draft.id,
                )
            }
            assertFailsWith<NativeDraftConflictException> {
                opened.store.importAttachment(
                    draft.id,
                    draft.revision,
                    NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
                )
            }
            assertTrue(opened.store.list().drafts.single().attachments.isEmpty())
            assertTrue(fixture.ownedFiles().isEmpty())
            opened.close()
        }
    }

    @Test
    fun `draft deletion during copy deletes tracked bytes`() = runBlocking {
        fixture().use { fixture ->
            val opened = fixture.open()
            val draft = opened.store.save(NativeDraftWrite(text = "before", attachments = emptyList()), null)
            fixture.onCopy = {
                opened.database.transaction {
                    opened.database.draftDatabaseQueries.deleteDraftAttachments(
                        "account-a", "wss|example.test|443|api/v1/ws", draft.id,
                    )
                    opened.database.draftDatabaseQueries.deleteDraft(
                        "account-a", "wss|example.test|443|api/v1/ws", draft.id,
                    )
                }
            }
            assertFailsWith<NativeDraftConflictException> {
                opened.store.importAttachment(
                    draft.id,
                    draft.revision,
                    NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
                )
            }
            assertTrue(opened.store.list().drafts.isEmpty())
            assertTrue(fixture.ownedFiles().isEmpty())
            opened.close()
        }
    }

    @Test
    fun `staged copied bytes are cleaned after reopen`() = runBlocking {
        fixture().use { fixture ->
            val first = fixture.open()
            val draft = first.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            val attachmentId = "11111111-1111-4111-8111-111111111111"
            val path = first.files.path(draft.id, attachmentId)
            first.database.draftDatabaseQueries.insertFileCleanup(path)
            first.files.copy("fixture", path)
            assertTrue(File(path).exists())
            first.close()

            val reopened = fixture.open()
            reopened.store.list()
            assertTrue(!File(path).exists())
            assertTrue(reopened.database.draftDatabaseQueries.fileCleanupPaths().executeAsList().isEmpty())
            reopened.close()
        }
    }

    @Test
    fun `failed unlink retains cleanup intent for retry after reopen`() = runBlocking {
        fixture().use { fixture ->
            val first = fixture.open()
            val draft = first.store.save(NativeDraftWrite(text = "", attachments = emptyList()), null)
            val attached = first.store.importAttachment(
                draft.id,
                draft.revision,
                NativeDraftAttachmentImport("fixture", "fixture.txt", "text/plain"),
            )
            val path = attached.attachments.single().localPath
            val coordinator = NativeDraftCoordinator(first.store)
            coordinator.restore()
            fixture.failDelete = true
            assertTrue(coordinator.discard(attached.id))
            assertTrue(coordinator.snapshot.value.drafts.isEmpty())
            assertTrue(File(path).exists())
            assertEquals(listOf(path), first.database.draftDatabaseQueries.fileCleanupPaths().executeAsList())
            first.close()

            fixture.failDelete = false
            val reopened = fixture.open()
            reopened.store.list()
            assertTrue(!File(path).exists())
            assertTrue(reopened.database.draftDatabaseQueries.fileCleanupPaths().executeAsList().isEmpty())
            reopened.close()
        }
    }

    private fun fixture(failingCopy: Boolean = false) = Fixture(failingCopy)

    private class Fixture(private val failingCopy: Boolean) : AutoCloseable {
        val root = Files.createTempDirectory("sentient-native-drafts-").toFile()
        val bytes = "synthetic fixture".encodeToByteArray()
        private val database = File(root, "drafts.sqlite")
        private var created = false
        var failDelete = false
        var holdPreview = false
        var onCopy: (() -> Unit)? = null
        val previewPaths = mutableListOf<String>()
        val previewSources = mutableListOf<String>()
        val previewStarted = CompletableDeferred<Unit>()
        val releasePreview = CompletableDeferred<Unit>()
        var previewThread: Thread? = null

        fun open(account: String = "account-a"): Opened {
            val driver = JdbcSqliteDriver("jdbc:sqlite:${database.absolutePath}")
            if (!created) {
                DraftDatabase.Schema.create(driver)
                created = true
            }
            val delegate = AndroidNativeDraftFileStore(root, openSource = {
                onCopy?.invoke()
                onCopy = null
                if (failingCopy) FailingInputStream() else ByteArrayInputStream(bytes)
            })
            val files = object : NativeDraftFileStore {
                override fun path(draftId: String, attachmentId: String) = delegate.path(draftId, attachmentId)
                override suspend fun copy(sourceLocation: String, localPath: String) =
                    delegate.copy(sourceLocation, localPath)
                override suspend fun delete(localPath: String) {
                    if (failDelete) throw IOException("synthetic unlink failure")
                    delegate.delete(localPath)
                    File("$localPath.preview").delete()
                }
                override suspend fun preparePreview(
                    sourceLocation: String,
                    localPath: String,
                    maxPixelSize: Int,
                ): Boolean {
                    previewSources += sourceLocation
                    File("$localPath.preview").writeBytes(byteArrayOf(1, 2, 3))
                    return true
                }
                override suspend fun preview(localPath: String, maxPixelSize: Int, mediaType: String): ByteArray {
                    previewThread = Thread.currentThread()
                    previewPaths += localPath
                    if (holdPreview) {
                        previewStarted.complete(Unit)
                        releasePreview.await()
                    }
                    return bytes
                }
            }
            val draftDatabase = DraftDatabase(driver)
            val store = SqlDelightNativeDraftStore(
                draftDatabase,
                files,
                NativeDraftScope(account, "wss|example.test|443|api/v1/ws"),
                now = { 1234L },
            )
            return Opened(driver, draftDatabase, files, store)
        }

        fun ownedFiles(): List<File> = File(root, "SentientDrafts/files").walkTopDown()
            .filter(File::isFile).toList()

        override fun close() {
            root.deleteRecursively()
        }
    }

    private data class Opened(
        val driver: JdbcSqliteDriver,
        val database: DraftDatabase,
        val files: NativeDraftFileStore,
        val store: SqlDelightNativeDraftStore,
    ) {
        fun close() = driver.close()
    }

    private class FailingInputStream : InputStream() {
        private var reads = 0
        override fun read(): Int {
            if (reads++ > 2) throw IOException("synthetic disk boundary failure")
            return 'x'.code
        }
    }
}
