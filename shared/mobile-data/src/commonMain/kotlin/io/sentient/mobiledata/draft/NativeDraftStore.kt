package io.sentient.mobiledata.draft

import app.cash.sqldelight.db.SqlDriver
import io.sentient.mobiledata.draft.db.DraftDatabase
import io.sentient.mobiledata.draft.db.Native_delete_intent
import io.sentient.mobiledata.draft.db.Native_draft
import io.sentient.mobiledata.draft.db.Native_draft_attachment
import io.sentient.mobiledata.draft.db.Native_pending_attachment
import io.sentient.mobiledata.draft.db.Native_pending_send
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.coroutineContext
import kotlin.time.Clock
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/** Authenticated account plus already-normalized gateway identity. */
data class NativeDraftScope(
    val accountId: String,
    val normalizedGatewayId: String,
) {
    init {
        require(accountId.isNotBlank())
        require(normalizedGatewayId.isNotBlank())
    }
}

data class NativeDraftAttachment(
    val id: String,
    val displayName: String,
    val mediaType: String,
    val sizeBytes: Long,
    /** App-private owned path returned by [NativeDraftFileStore]. Never a picker URI. */
    val localPath: String,
)

data class NativeDraft(
    val id: String,
    val sessionId: String?,
    val text: String,
    val attachments: List<NativeDraftAttachment>,
    val revision: Long,
    val createdAt: Long,
    val updatedAt: Long,
)

data class NativeDraftWrite(
    val id: String? = null,
    val sessionId: String? = null,
    val text: String,
    val attachments: List<NativeDraftAttachment>,
)

data class NativePendingSend(
    val pendingId: String,
    val mintKey: String,
    val surfaceId: String,
    val draftId: String,
    val draftRevision: Long,
    val sessionId: String?,
    val text: String,
    val attachments: List<NativeDraftAttachment>,
    val createdAt: Long,
)

data class NativeDeleteIntent(
    val sessionId: String,
    val createdAt: Long,
    val updatedAt: Long,
    val failureCode: String?,
)

data class NativeDraftSnapshot(
    val drafts: List<NativeDraft>,
    val pendingSends: List<NativePendingSend>,
    val deleteIntents: List<NativeDeleteIntent>,
)

enum class NativeSendReconciliation { ACKNOWLEDGED, NOT_COMMITTED }

data class NativeSendReconciliationResult(
    val found: Boolean,
    val draftId: String? = null,
    val sessionId: String? = null,
    val restoredDraft: NativeDraft? = null,
)

const val NATIVE_ATTACHMENT_MAX_SOURCE_BYTES: Long = 512L * 1024L * 1024L
const val NATIVE_ATTACHMENT_PREVIEW_MAX_PIXEL_SIZE: Int = 640
const val LIVE_PHOTO_MEDIA_TYPE: String = "application/vnd.sentient.live-photo+zip"
private const val NATIVE_DRAFT_LOCAL_CLEANUP_TIMEOUT_MILLIS = 30_000L

data class NativeDraftAttachmentImport(
    /** Ephemeral picker location consumed only during copy. */
    val sourceLocation: String,
    val displayName: String,
    val mediaType: String,
    /** Optional selected-still source. Consumed during import; never persisted as picker authority. */
    val previewSourceLocation: String? = null,
)

data class NativeDraftCopiedFile(
    val localPath: String,
    val sizeBytes: Long,
)

/** Platform boundary that copies picker bytes into durable app-private ownership. */
interface NativeDraftFileStore {
    fun path(draftId: String, attachmentId: String): String
    suspend fun copy(sourceLocation: String, localPath: String): NativeDraftCopiedFile
    suspend fun delete(localPath: String)
    /** Creates an optional bounded sidecar owned and cleaned with [localPath]. */
    suspend fun preparePreview(sourceLocation: String, localPath: String, maxPixelSize: Int): Boolean = false
    /** Returns encoded, bounded preview bytes without exposing the protected original path. */
    suspend fun preview(localPath: String, maxPixelSize: Int, mediaType: String): ByteArray? = null
}

class NativeDraftSourceTooLargeException : IllegalArgumentException("attachment exceeds source byte limit")
class NativeDraftConflictException(val current: NativeDraft?) : IllegalStateException("draft revision conflict")
class NativeDraftDiscardedException(val draftId: String) :
    IllegalStateException("draft was discarded")
class NativeSendAnchorUnavailableException(
    val reason: String = "outbound anchor unavailable",
) : IllegalStateException(reason)
class NativePendingSendConflictException(val pending: NativePendingSend) :
    IllegalStateException("draft already has a pending send")
class NativeConversationPendingDeleteException(val sessionId: String) :
    IllegalStateException("conversation has a pending delete intent")

interface NativeDraftStore {
    suspend fun list(): NativeDraftSnapshot
    suspend fun save(write: NativeDraftWrite, expectedRevision: Long?): NativeDraft
    /** Copies and appends one attachment, increments revision, and returns replacement draft state. */
    suspend fun importAttachment(
        draftId: String,
        expectedRevision: Long,
        source: NativeDraftAttachmentImport,
    ): NativeDraft
    suspend fun remove(draftId: String, expectedRevision: Long)
    suspend fun previewAttachment(attachmentId: String, maxPixelSize: Int): ByteArray?
    suspend fun beginSend(
        draftId: String,
        expectedRevision: Long,
        mintKey: String,
        surfaceId: String,
    ): NativePendingSend
    suspend fun reconcileSend(
        pendingId: String,
        result: NativeSendReconciliation,
        acknowledgedSessionId: String? = null,
    ): NativeSendReconciliationResult
    suspend fun detachDeletedSession(sessionId: String)
    suspend fun saveDeleteIntent(sessionId: String, failureCode: String? = null): NativeDeleteIntent
    suspend fun removeDeleteIntent(sessionId: String)
    suspend fun closeStore(close: () -> Unit) = close()
}

/** SQLDelight persistence boundary. Platform composition supplies protected database and file storage. */
class SqlDelightNativeDraftStore internal constructor(
    private val database: DraftDatabase,
    private val files: NativeDraftFileStore,
    private val scope: NativeDraftScope,
    private val now: () -> Long,
) : NativeDraftStore {
    constructor(
        database: DraftDatabase,
        files: NativeDraftFileStore,
        scope: NativeDraftScope,
    ) : this(database, files, scope, { Clock.System.now().toEpochMilliseconds() })

    private val queries = database.draftDatabaseQueries
    private val writes = Mutex()
    private val previews = Semaphore(2)
    private var closed = false

    override suspend fun list(): NativeDraftSnapshot = writes.withLock {
        drainFileCleanup()
        database.transactionWithResult {
            NativeDraftSnapshot(
                drafts = queries.draftsForScope(scope.accountId, scope.normalizedGatewayId)
                    .executeAsList().map(::draft),
                pendingSends = queries.pendingSendsForScope(scope.accountId, scope.normalizedGatewayId)
                    .executeAsList().map(::pending),
                deleteIntents = queries.deleteIntentsForScope(scope.accountId, scope.normalizedGatewayId)
                    .executeAsList().map(::deleteIntent),
            )
        }
    }

    override suspend fun save(write: NativeDraftWrite, expectedRevision: Long?): NativeDraft = writes.withLock {
        validateWrite(write)
        val draftId = write.id ?: uuid()
        val removedPaths = mutableListOf<String>()
        val saved = database.transactionWithResult {
            val current = queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()
            if (current?.revision != expectedRevision) throw NativeDraftConflictException(current?.let(::draft))
            if (write.sessionId != null) {
                if (queries.deleteIntentForSession(scope.accountId, scope.normalizedGatewayId, write.sessionId)
                        .executeAsOneOrNull() != null
                ) {
                    throw NativeConversationPendingDeleteException(write.sessionId)
                }
                val other = queries.draftForSession(scope.accountId, scope.normalizedGatewayId, write.sessionId)
                    .executeAsOneOrNull()
                if (other != null && other.draft_id != draftId) throw NativeDraftConflictException(draft(other))
            }

            val timestamp = now()
            val revision = (current?.revision ?: 0L) + 1L
            if (current == null) {
                queries.insertDraft(
                    scope.accountId, scope.normalizedGatewayId, draftId, write.sessionId, write.text,
                    revision, timestamp, timestamp,
                )
            } else {
                queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, draftId).executeAsList()
                    .mapTo(removedPaths) { it.local_path }
                queries.updateDraft(
                    session_id = write.sessionId,
                    text = write.text,
                    revision = revision,
                    updated_at = timestamp,
                    account_id = scope.accountId,
                    gateway_id = scope.normalizedGatewayId,
                    draft_id = draftId,
                )
                queries.deleteDraftAttachments(scope.accountId, scope.normalizedGatewayId, draftId)
            }
            write.attachments.forEachIndexed { index, attachment -> insertDraftAttachment(draftId, attachment, index) }
            enqueueUnreferenced(removedPaths)
            draft(queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOne())
        }
        drainFileCleanup()
        saved
    }

    override suspend fun importAttachment(
        draftId: String,
        expectedRevision: Long,
        source: NativeDraftAttachmentImport,
    ): NativeDraft = writes.withLock {
        requireUuid(draftId, "draftId")
        require(source.sourceLocation.isNotBlank())
        require(source.displayName.isNotBlank())
        require(source.mediaType.isNotBlank())
        val attachmentId = uuid()
        val localPath = files.path(draftId, attachmentId)
        check(localPath.isNotBlank())
        database.transaction {
            val current = queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()
            if (current?.revision != expectedRevision) throw NativeDraftConflictException(current?.let(::draft))
            queries.insertFileCleanup(localPath)
        }
        try {
            val copied = files.copy(source.sourceLocation, localPath)
            coroutineContext.ensureActive()
            check(copied.localPath == localPath && copied.sizeBytes >= 0L)
            if (copied.sizeBytes > NATIVE_ATTACHMENT_MAX_SOURCE_BYTES) throw NativeDraftSourceTooLargeException()
            source.previewSourceLocation?.let {
                files.preparePreview(it, localPath, NATIVE_ATTACHMENT_PREVIEW_MAX_PIXEL_SIZE)
                coroutineContext.ensureActive()
            }
            coroutineContext.ensureActive()
            database.transactionWithResult {
                val current = queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()
                if (current?.revision != expectedRevision) throw NativeDraftConflictException(current?.let(::draft))
                val attachment = NativeDraftAttachment(
                    attachmentId, source.displayName, source.mediaType, copied.sizeBytes, localPath,
                )
                insertDraftAttachment(draftId, attachment, currentAttachmentCount(draftId))
                queries.updateDraft(
                    current.session_id, current.text, current.revision + 1L, now(),
                    scope.accountId, scope.normalizedGatewayId, draftId,
                )
                queries.deleteFileCleanup(localPath)
                draft(queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOne())
            }
        } catch (failure: Throwable) {
            withContext(NonCancellable) {
                try {
                    if (queries.pathReferenceCount(localPath, localPath).executeAsOne() != 0L) {
                        queries.deleteFileCleanup(localPath)
                    } else {
                        val deleted = withTimeoutOrNull(NATIVE_DRAFT_LOCAL_CLEANUP_TIMEOUT_MILLIS) {
                            files.delete(localPath)
                            true
                        } == true
                        if (deleted) queries.deleteFileCleanup(localPath)
                    }
                } catch (_: Throwable) {
                    // Keep durable cleanup intent for next drain/relaunch.
                }
            }
            throw failure
        }
    }

    override suspend fun remove(draftId: String, expectedRevision: Long) = writes.withLock {
        database.transaction {
            val current = queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()
            if (current?.revision != expectedRevision) throw NativeDraftConflictException(current?.let(::draft))
            queries.pendingSendForDraft(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()?.let {
                throw NativePendingSendConflictException(pending(it))
            }
            val owned = queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, draftId)
                .executeAsList().map { it.local_path }
            queries.deleteDraftAttachments(scope.accountId, scope.normalizedGatewayId, draftId)
            queries.deleteDraft(scope.accountId, scope.normalizedGatewayId, draftId)
            enqueueUnreferenced(owned)
        }
        drainFileCleanup()
    }

    override suspend fun previewAttachment(attachmentId: String, maxPixelSize: Int): ByteArray? {
        requireUuid(attachmentId, "attachment id")
        require(maxPixelSize in 64..1024)
        val source = writes.withLock { if (closed) null else previewSource(attachmentId) } ?: return null
        val preview = previews.withPermit {
            withContext(Dispatchers.Default) {
                files.preview(source.localPath, maxPixelSize, source.mediaType)
            }
        } ?: return null
        return writes.withLock { preview.takeIf { !closed && previewSource(attachmentId) == source } }
    }

    override suspend fun beginSend(
        draftId: String,
        expectedRevision: Long,
        mintKey: String,
        surfaceId: String,
    ): NativePendingSend = writes.withLock {
        require(mintKey.isNotBlank())
        require(surfaceId.isNotBlank())
        database.transactionWithResult {
            val row = queries.draftForId(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()
            if (row?.revision != expectedRevision) throw NativeDraftConflictException(row?.let(::draft))
            queries.pendingSendForDraft(scope.accountId, scope.normalizedGatewayId, draftId).executeAsOneOrNull()?.let {
                val current = pending(it)
                if (current.surfaceId == surfaceId && current.draftRevision == expectedRevision) {
                    return@transactionWithResult current
                }
                throw NativePendingSendConflictException(current)
            }
            val pendingId = uuid()
            queries.insertPendingSend(
                scope.accountId, scope.normalizedGatewayId, pendingId, mintKey, surfaceId, draftId,
                row.revision, row.session_id, row.text, now(),
            )
            queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, draftId).executeAsList()
                .forEach { insertPendingAttachment(pendingId, it) }
            pending(queries.pendingSendForId(scope.accountId, scope.normalizedGatewayId, pendingId).executeAsOne())
        }
    }

    override suspend fun reconcileSend(
        pendingId: String,
        result: NativeSendReconciliation,
        acknowledgedSessionId: String?,
    ): NativeSendReconciliationResult = writes.withLock {
        val paths = mutableListOf<String>()
        val reconciliation = database.transactionWithResult {
            val send = queries.pendingSendForId(scope.accountId, scope.normalizedGatewayId, pendingId)
                .executeAsOneOrNull() ?: return@transactionWithResult NativeSendReconciliationResult(false)
            if (result == NativeSendReconciliation.ACKNOWLEDGED &&
                (acknowledgedSessionId.isNullOrBlank() ||
                    send.session_id != null && send.session_id != acknowledgedSessionId)
            ) return@transactionWithResult NativeSendReconciliationResult(false)
            val pendingAttachments = queries.pendingAttachments(scope.accountId, scope.normalizedGatewayId, pendingId)
                .executeAsList()
            pendingAttachments.mapTo(paths) { it.local_path }
            val current = queries.draftForId(scope.accountId, scope.normalizedGatewayId, send.draft_id)
                .executeAsOneOrNull()
            var restored: NativeDraft? = null
            if (result == NativeSendReconciliation.ACKNOWLEDGED) {
                if (current?.revision == send.draft_revision) {
                    queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, send.draft_id)
                        .executeAsList()
                        .mapTo(paths) { it.local_path }
                    queries.deleteDraftAttachments(scope.accountId, scope.normalizedGatewayId, send.draft_id)
                    queries.deleteDraft(scope.accountId, scope.normalizedGatewayId, send.draft_id)
                } else if (current != null) {
                    queries.updateDraft(
                        acknowledgedSessionId, current.text, current.revision, current.updated_at,
                        scope.accountId, scope.normalizedGatewayId, send.draft_id,
                    )
                    restored = draft(
                        queries.draftForId(scope.accountId, scope.normalizedGatewayId, send.draft_id).executeAsOne(),
                    )
                }
            } else {
                val currentAttachments = current?.let {
                    queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, send.draft_id)
                        .executeAsList()
                }.orEmpty()
                if (current != null && current.revision != send.draft_revision &&
                    (current.text.isNotBlank() || currentAttachments.isNotEmpty())
                ) {
                    val detachedId = uuid()
                    val timestamp = now()
                    queries.insertDraft(
                        scope.accountId, scope.normalizedGatewayId, detachedId, null, current.text,
                        1L, timestamp, timestamp,
                    )
                    currentAttachments.forEachIndexed { index, attachment ->
                        insertDraftAttachment(detachedId, attachment(attachment), index)
                    }
                }
                if (current == null) {
                    val timestamp = now()
                    queries.insertDraft(
                        scope.accountId, scope.normalizedGatewayId, send.draft_id, send.session_id, send.text,
                        1L, timestamp, timestamp,
                    )
                } else if (current.revision != send.draft_revision) {
                    queries.deleteDraftAttachments(scope.accountId, scope.normalizedGatewayId, send.draft_id)
                    queries.updateDraft(
                        send.session_id, send.text, current.revision + 1L, now(),
                        scope.accountId, scope.normalizedGatewayId, send.draft_id,
                    )
                }
                pendingAttachments.forEachIndexed { index, attachment ->
                    if (current?.revision != send.draft_revision) {
                        insertDraftAttachment(send.draft_id, attachment(attachment), index)
                    }
                }
                restored = draft(queries.draftForId(scope.accountId, scope.normalizedGatewayId, send.draft_id).executeAsOne())
            }
            queries.deletePendingAttachments(scope.accountId, scope.normalizedGatewayId, pendingId)
            queries.deletePendingSend(scope.accountId, scope.normalizedGatewayId, pendingId)
            enqueueUnreferenced(paths)
            NativeSendReconciliationResult(
                found = true,
                draftId = send.draft_id,
                sessionId = acknowledgedSessionId ?: send.session_id,
                restoredDraft = restored,
            )
        }
        drainFileCleanup()
        reconciliation
    }

    override suspend fun detachDeletedSession(sessionId: String) = writes.withLock {
        require(sessionId.isNotBlank())
        database.transaction { detachSessionDraft(sessionId) }
    }

    override suspend fun saveDeleteIntent(sessionId: String, failureCode: String?): NativeDeleteIntent =
        writes.withLock {
            require(sessionId.isNotBlank())
            val intent = database.transactionWithResult {
                val current = queries.deleteIntentForSession(scope.accountId, scope.normalizedGatewayId, sessionId)
                    .executeAsOneOrNull()
                val timestamp = now()
                queries.upsertDeleteIntent(
                    scope.accountId, scope.normalizedGatewayId, sessionId,
                    current?.created_at ?: timestamp, timestamp, failureCode,
                )
                discardSessionDraft(sessionId)
                deleteIntent(
                    queries.deleteIntentForSession(scope.accountId, scope.normalizedGatewayId, sessionId)
                        .executeAsOne(),
                )
            }
            drainFileCleanup()
            intent
        }

    override suspend fun removeDeleteIntent(sessionId: String) = writes.withLock {
        queries.deleteDeleteIntent(scope.accountId, scope.normalizedGatewayId, sessionId)
        Unit
    }

    override suspend fun closeStore(close: () -> Unit) = writes.withLock {
        if (!closed) {
            closed = true
            close()
        }
    }

    private fun discardSessionDraft(sessionId: String) {
        val row = queries.draftForSession(scope.accountId, scope.normalizedGatewayId, sessionId)
            .executeAsOneOrNull() ?: return
        val paths = queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, row.draft_id)
            .executeAsList().map { it.local_path }.toMutableList()
        queries.pendingSendForDraft(scope.accountId, scope.normalizedGatewayId, row.draft_id)
            .executeAsOneOrNull()?.let { send ->
                queries.pendingAttachments(scope.accountId, scope.normalizedGatewayId, send.pending_id)
                    .executeAsList().mapTo(paths) { it.local_path }
                queries.deletePendingAttachments(scope.accountId, scope.normalizedGatewayId, send.pending_id)
                queries.deletePendingSend(scope.accountId, scope.normalizedGatewayId, send.pending_id)
            }
        queries.deleteDraftAttachments(scope.accountId, scope.normalizedGatewayId, row.draft_id)
        queries.deleteDraft(scope.accountId, scope.normalizedGatewayId, row.draft_id)
        enqueueUnreferenced(paths)
    }

    /** Detach editable content and thaw any frozen send into its own explicit-send draft. */
    private fun detachSessionDraft(sessionId: String) {
        val row = queries.draftForSession(scope.accountId, scope.normalizedGatewayId, sessionId)
            .executeAsOneOrNull() ?: return
        val send = queries.pendingSendForDraft(scope.accountId, scope.normalizedGatewayId, row.draft_id)
            .executeAsOneOrNull()
        val isUnchangedDraft = send != null && row.revision == send.draft_revision
        val isSendClearedDraft = send != null && row.revision == send.draft_revision + 1L && row.text.isBlank()
        if (send != null) {
            val pendingAttachments = queries.pendingAttachments(
                scope.accountId, scope.normalizedGatewayId, send.pending_id,
            ).executeAsList()
            if (!isUnchangedDraft && !isSendClearedDraft && (send.text.isNotBlank() || pendingAttachments.isNotEmpty())) {
                val detachedId = uuid()
                val timestamp = now()
                queries.insertDraft(
                    scope.accountId, scope.normalizedGatewayId, detachedId, null, send.text,
                    1L, timestamp, timestamp,
                )
                pendingAttachments.forEachIndexed { index, attachment ->
                    insertDraftAttachment(detachedId, attachment(attachment), index)
                }
            }
            if (isSendClearedDraft) {
                pendingAttachments.forEachIndexed { index, attachment ->
                    insertDraftAttachment(row.draft_id, attachment(attachment), index)
                }
            }
            queries.deletePendingAttachments(scope.accountId, scope.normalizedGatewayId, send.pending_id)
            queries.deletePendingSend(scope.accountId, scope.normalizedGatewayId, send.pending_id)
        }
        queries.updateDraft(
            null, if (isSendClearedDraft) send.text else row.text, row.revision + 1L, now(),
            scope.accountId, scope.normalizedGatewayId, row.draft_id,
        )
    }

    private fun draft(row: Native_draft): NativeDraft = NativeDraft(
        id = row.draft_id,
        sessionId = row.session_id,
        text = row.text,
        attachments = queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, row.draft_id)
            .executeAsList().map(::attachment),
        revision = row.revision,
        createdAt = row.created_at,
        updatedAt = row.updated_at,
    )

    private fun pending(row: Native_pending_send): NativePendingSend = NativePendingSend(
        pendingId = row.pending_id,
        mintKey = row.mint_key,
        surfaceId = row.surface_id,
        draftId = row.draft_id,
        draftRevision = row.draft_revision,
        sessionId = row.session_id,
        text = row.text,
        attachments = queries.pendingAttachments(scope.accountId, scope.normalizedGatewayId, row.pending_id)
            .executeAsList().map(::attachment),
        createdAt = row.created_at,
    )

    private fun attachment(row: Native_draft_attachment) = NativeDraftAttachment(
        row.attachment_id, row.display_name, row.media_type, row.size_bytes, row.local_path,
    )

    private fun attachment(row: Native_pending_attachment) = NativeDraftAttachment(
        row.attachment_id, row.display_name, row.media_type, row.size_bytes, row.local_path,
    )

    private fun deleteIntent(row: Native_delete_intent) = NativeDeleteIntent(
        row.session_id, row.created_at, row.updated_at, row.failure_code,
    )

    private fun insertDraftAttachment(draftId: String, attachment: NativeDraftAttachment, order: Int) {
        queries.insertDraftAttachment(
            scope.accountId, scope.normalizedGatewayId, draftId, attachment.id, attachment.displayName,
            attachment.mediaType, attachment.sizeBytes, attachment.localPath, order.toLong(),
        )
    }

    private fun insertPendingAttachment(pendingId: String, row: Native_draft_attachment) {
        queries.insertPendingAttachment(
            scope.accountId, scope.normalizedGatewayId, pendingId, row.attachment_id, row.display_name,
            row.media_type, row.size_bytes, row.local_path, row.sort_order,
        )
    }

    private fun currentAttachmentCount(draftId: String): Int =
        queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, draftId).executeAsList().size

    private fun previewSource(attachmentId: String): PreviewSource? {
        val draftAttachment = queries.draftsForScope(scope.accountId, scope.normalizedGatewayId)
            .executeAsList().asSequence()
            .flatMap { queries.attachmentsForDraft(scope.accountId, scope.normalizedGatewayId, it.draft_id).executeAsList() }
            .firstOrNull { it.attachment_id == attachmentId }
        if (draftAttachment != null) {
            return draftAttachment.takeIf {
                it.media_type.startsWith("image/") || it.media_type == LIVE_PHOTO_MEDIA_TYPE
            }?.let { PreviewSource(it.local_path, it.media_type) }
        }
        return queries.pendingSendsForScope(scope.accountId, scope.normalizedGatewayId)
            .executeAsList().asSequence()
            .flatMap { queries.pendingAttachments(scope.accountId, scope.normalizedGatewayId, it.pending_id).executeAsList() }
            .firstOrNull {
                it.attachment_id == attachmentId &&
                    (it.media_type.startsWith("image/") || it.media_type == LIVE_PHOTO_MEDIA_TYPE)
            }?.let { PreviewSource(it.local_path, it.media_type) }
    }

    private data class PreviewSource(val localPath: String, val mediaType: String)

    private fun enqueueUnreferenced(paths: Iterable<String>) {
        paths.toSet().forEach { path ->
            if (queries.pathReferenceCount(path, path).executeAsOne() == 0L) queries.insertFileCleanup(path)
        }
    }

    private suspend fun drainFileCleanup() {
        queries.fileCleanupPaths().executeAsList().forEach { path ->
            if (queries.pathReferenceCount(path, path).executeAsOne() != 0L) {
                queries.deleteFileCleanup(path)
            } else {
                try {
                    files.delete(path)
                    queries.deleteFileCleanup(path)
                } catch (_: Throwable) {
                    // Mutation already committed. Keep cleanup intent for next drain/relaunch.
                }
            }
        }
    }

    private fun validateWrite(write: NativeDraftWrite) {
        write.id?.let { requireUuid(it, "draft id") }
        write.sessionId?.let { require(it.isNotBlank()) }
        require(write.attachments.map { it.id }.toSet().size == write.attachments.size)
        write.attachments.forEach {
            requireUuid(it.id, "attachment id")
            require(it.displayName.isNotBlank() && it.mediaType.isNotBlank())
            require(it.sizeBytes >= 0L && it.localPath.isNotBlank())
        }
    }

    @OptIn(ExperimentalUuidApi::class)
    private fun uuid(): String = Uuid.random().toString()

    private fun requireUuid(value: String, field: String) {
        require(UUID.matches(value)) { "$field must be a UUID" }
    }

    private companion object {
        val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    }
}

/** Composition seam: caller retains driver lifecycle ownership. */
fun createNativeDraftStore(
    driver: SqlDriver,
    files: NativeDraftFileStore,
    scope: NativeDraftScope,
): NativeDraftStore = SqlDelightNativeDraftStore(DraftDatabase(driver), files, scope)
