@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobiledata.draft

import app.cash.sqldelight.Query
import app.cash.sqldelight.driver.native.NativeSqliteDriver
import io.sentient.mobiledata.draft.db.DraftDatabase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import platform.Foundation.NSFileManager
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSUUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class NativeDraftImportCancellationTest {
    @Test
    fun post_commit_listener_failure_never_deletes_referenced_owned_files() = runTest {
        val basePath = "${NSTemporaryDirectory()}sentient-draft-commit-${NSUUID.UUID().UUIDString}"
        val manager = NSFileManager.defaultManager
        assertTrue(manager.createDirectoryAtPath(basePath, true, null, null))
        val driver = NativeSqliteDriver(
            schema = DraftDatabase.Schema,
            name = "drafts.sqlite",
            onConfiguration = { configuration ->
                configuration.copy(extendedConfig = configuration.extendedConfig.copy(basePath = basePath))
            },
        )
        try {
            val database = DraftDatabase(driver)
            val files = ReferencedFileStore()
            val scope = NativeDraftScope("account-a", "wss|example.test|443|api/v1/ws")
            val store = SqlDelightNativeDraftStore(database, files, scope)
            val original = store.save(NativeDraftWrite(text = "before", attachments = emptyList()), null)
            val attachmentQuery = database.draftDatabaseQueries
                .attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, original.id)
            attachmentQuery.addListener(object : Query.Listener {
                override fun queryResultsChanged() = throw PostCommitListenerFailure()
            })

            assertFailsWith<PostCommitListenerFailure> {
                store.importAttachment(
                    original.id,
                    original.revision,
                    NativeDraftAttachmentImport(
                        sourceLocation = "source",
                        displayName = "live-photo.zip",
                        mediaType = LIVE_PHOTO_MEDIA_TYPE,
                        previewSourceLocation = "still",
                    ),
                )
            }

            val committed = attachmentQuery.executeAsList().single()
            assertEquals(original.revision + 1L, database.draftDatabaseQueries
                .draftForId(scope.accountId, scope.normalizedGatewayId, original.id)
                .executeAsOne().revision)
            assertEquals(files.lastPath, committed.local_path)
            assertEquals(setOf(files.lastPath, "${files.lastPath}.preview.png"), files.ownedPaths)
            assertTrue(files.deletedPaths.isEmpty())
            assertTrue(database.draftDatabaseQueries.fileCleanupPaths().executeAsList().isEmpty())
        } finally {
            driver.close()
            manager.removeItemAtPath(basePath, null)
        }
    }

    @Test
    fun cancellation_during_noncooperative_preview_does_not_commit_or_leave_owned_files() = runTest {
        val basePath = "${NSTemporaryDirectory()}sentient-draft-cancel-${NSUUID.UUID().UUIDString}"
        val manager = NSFileManager.defaultManager
        assertTrue(manager.createDirectoryAtPath(basePath, true, null, null))
        val driver = NativeSqliteDriver(
            schema = DraftDatabase.Schema,
            name = "drafts.sqlite",
            onConfiguration = { configuration ->
                configuration.copy(extendedConfig = configuration.extendedConfig.copy(basePath = basePath))
            },
        )
        try {
            val database = DraftDatabase(driver)
            val files = HeldPreviewFileStore()
            val scope = NativeDraftScope("account-a", "wss|example.test|443|api/v1/ws")
            val store = SqlDelightNativeDraftStore(database, files, scope)
            val original = store.save(NativeDraftWrite(text = "before", attachments = emptyList()), null)

            val import = async {
                store.importAttachment(
                    original.id,
                    original.revision,
                    NativeDraftAttachmentImport(
                        sourceLocation = "source",
                        displayName = "live-photo.zip",
                        mediaType = LIVE_PHOTO_MEDIA_TYPE,
                        previewSourceLocation = "still",
                    ),
                )
            }
            files.previewStarted.await()
            import.cancel()
            files.releasePreview.complete(Unit)

            assertFailsWith<CancellationException> { import.await() }
            assertTrue(files.ownedPaths.isEmpty())
            assertTrue(database.draftDatabaseQueries.fileCleanupPaths().executeAsList().isEmpty())
            val unchanged = database.draftDatabaseQueries
                .draftForId(scope.accountId, scope.normalizedGatewayId, original.id)
                .executeAsOne()
            assertEquals(original.revision, unchanged.revision)
            assertTrue(
                database.draftDatabaseQueries
                    .attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, original.id)
                    .executeAsList()
                    .isEmpty(),
            )
        } finally {
            driver.close()
            manager.removeItemAtPath(basePath, null)
        }
    }

    private class PostCommitListenerFailure : IllegalStateException()

    private class ReferencedFileStore : NativeDraftFileStore {
        lateinit var lastPath: String
        val ownedPaths = mutableSetOf<String>()
        val deletedPaths = mutableListOf<String>()

        override fun path(draftId: String, attachmentId: String): String =
            "files/$draftId/$attachmentId".also { lastPath = it }

        override suspend fun copy(sourceLocation: String, localPath: String): NativeDraftCopiedFile {
            ownedPaths += localPath
            return NativeDraftCopiedFile(localPath, 3L)
        }

        override suspend fun preparePreview(sourceLocation: String, localPath: String, maxPixelSize: Int): Boolean {
            ownedPaths += "$localPath.preview.png"
            return true
        }

        override suspend fun delete(localPath: String) {
            deletedPaths += localPath
            ownedPaths -= localPath
            ownedPaths -= "$localPath.preview.png"
        }
    }

    private class HeldPreviewFileStore : NativeDraftFileStore {
        val previewStarted = CompletableDeferred<Unit>()
        val releasePreview = CompletableDeferred<Unit>()
        val ownedPaths = mutableSetOf<String>()

        override fun path(draftId: String, attachmentId: String) = "files/$draftId/$attachmentId"

        override suspend fun copy(sourceLocation: String, localPath: String): NativeDraftCopiedFile {
            ownedPaths += "$localPath.partial"
            ownedPaths += localPath
            ownedPaths -= "$localPath.partial"
            return NativeDraftCopiedFile(localPath, 3L)
        }

        override suspend fun preparePreview(sourceLocation: String, localPath: String, maxPixelSize: Int): Boolean {
            ownedPaths += "$localPath.preview.png"
            ownedPaths += "$localPath.partial"
            previewStarted.complete(Unit)
            withContext(NonCancellable) { releasePreview.await() }
            return true
        }

        override suspend fun delete(localPath: String) {
            ownedPaths -= localPath
            ownedPaths -= "$localPath.partial"
            ownedPaths -= "$localPath.preview.png"
        }
    }
}
