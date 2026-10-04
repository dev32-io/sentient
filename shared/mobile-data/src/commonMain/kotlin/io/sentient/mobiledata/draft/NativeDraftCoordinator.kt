package io.sentient.mobiledata.draft

import app.cash.sqldelight.db.SqlDriver
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi

/** Thin stateful facade over the authenticated account's durable draft store. */
@OptIn(ExperimentalAtomicApi::class)
class NativeDraftCoordinator(
    private val store: NativeDraftStore,
    private val driver: SqlDriver? = null,
) {
    private val operations = Mutex()
    private val retiredEditors = AtomicReference<Set<String>>(emptySet())

    /** Synchronous retirement fences queued writes before a successor editor is installed. */
    fun retireEditor(editorId: String) {
        do {
            val current = retiredEditors.load()
            if (editorId in current) return
        } while (!retiredEditors.compareAndSet(current, current + editorId))
    }

    @Throws(Exception::class, CancellationException::class)
    suspend fun saveEditorText(editorId: String, draftId: String?, sessionId: String?, text: String): NativeDraft? =
        operations.withLock {
            if (editorId in retiredEditors.load()) return@withLock null
            saveTextLocked(draftId, sessionId, text)
        }

    /** Explicit lifecycle actions fence late UI saves during this authenticated lifetime. */
    private val discardedDraftIds = mutableSetOf<String>()
    private val detachedSessionIds = mutableSetOf<String>()
    private val _snapshot = MutableStateFlow(NativeDraftSnapshot(emptyList(), emptyList(), emptyList()))
    val snapshot: StateFlow<NativeDraftSnapshot> = _snapshot.asStateFlow()
    /** Emits explicit discard identities so live route owners can invalidate stale work. */
    private val _discardedDrafts = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 16)
    val discardedDrafts: SharedFlow<String> = _discardedDrafts.asSharedFlow()

    suspend fun restore(): NativeDraftSnapshot = operations.withLock { refresh() }

    suspend fun saveText(draftId: String?, sessionId: String?, text: String): NativeDraft? =
        operations.withLock { saveTextLocked(draftId, sessionId, text) }

    private suspend fun saveTextLocked(draftId: String?, sessionId: String?, text: String): NativeDraft? {
        if (draftId != null && draftId in discardedDraftIds) return null
        val current = currentDraft(draftId, sessionId)
        if (text.isBlank() && current != null && current.attachments.isEmpty() &&
            _snapshot.value.pendingSends.none { it.draftId == current.id }
        ) {
            store.remove(current.id, current.revision)
            refresh()
            return null
        }
        if (text.isBlank() && current == null) return null
        val saved = store.save(
            NativeDraftWrite(
                id = current?.id ?: draftId,
                sessionId = current?.sessionId ?: sessionId?.takeUnless { it in detachedSessionIds },
                text = text,
                attachments = current?.attachments ?: emptyList(),
            ),
            current?.revision,
        )
        refresh()
        return saved
    }

    @Throws(
        NativeDraftDiscardedException::class,
        NativeDraftConflictException::class,
        NativeDraftSourceTooLargeException::class,
        NativeConversationPendingDeleteException::class,
        CancellationException::class,
    )
    suspend fun importAttachment(
        draftId: String?,
        sessionId: String?,
        source: NativeDraftAttachmentImport,
    ): NativeDraft = operations.withLock { importAttachmentLocked(draftId, sessionId, source) }

    private suspend fun importAttachmentLocked(
        draftId: String?, sessionId: String?, source: NativeDraftAttachmentImport,
    ): NativeDraft {
        if (draftId != null && draftId in discardedDraftIds) {
            throw NativeDraftDiscardedException(draftId)
        }
        val current = currentDraft(draftId, sessionId) ?: store.save(
            NativeDraftWrite(id = draftId, sessionId = sessionId, text = "", attachments = emptyList()),
            null,
        )
        return store.importAttachment(current.id, current.revision, source).also { refresh() }
    }

    /** Check editor authority inside the mutex, before resolving the current revision. */
    @Throws(Exception::class, CancellationException::class)
    suspend fun importEditorAttachment(
        editorId: String,
        draftId: String?,
        sessionId: String?,
        source: NativeDraftAttachmentImport,
    ): NativeDraft = operations.withLock {
        if (editorId in retiredEditors.load()) throw CancellationException("Editor retired")
        importAttachmentLocked(draftId, sessionId, source)
    }

    suspend fun removeAttachment(draftId: String, attachmentId: String): NativeDraft = operations.withLock {
        val current = currentDraft(draftId, null) ?: throw IllegalArgumentException("draft not found")
        val saved = store.save(
            NativeDraftWrite(
                id = current.id,
                sessionId = current.sessionId,
                text = current.text,
                attachments = current.attachments.filterNot { it.id == attachmentId },
            ),
            current.revision,
        )
        refresh()
        saved
    }

    suspend fun previewAttachment(attachmentId: String, maxPixelSize: Int): ByteArray? =
        store.previewAttachment(attachmentId, maxPixelSize)

    suspend fun beginSend(draftId: String, mintKey: String, surfaceId: String): NativePendingSend =
        operations.withLock {
            val draft = _snapshot.value.drafts.firstOrNull { it.id == draftId }
                ?: refresh().drafts.first { it.id == draftId }
            val pending = store.beginSend(draft.id, draft.revision, mintKey, surfaceId)
            refresh()
            pending
        }

    @Throws(Exception::class, CancellationException::class)
    suspend fun markAttempted(pendingId: String) = operations.withLock {
        store.markAttempted(pendingId)
        refresh()
        Unit
    }

    @Throws(Exception::class, CancellationException::class)
    suspend fun acceptSend(draftId: String, expectedRevision: Long, mintKey: String, surfaceId: String): NativePendingSend =
        operations.withLock {
            if (draftId in discardedDraftIds) throw NativeDraftDiscardedException(draftId)
            store.acceptSend(draftId, expectedRevision, mintKey, surfaceId).also { refresh() }
        }

    suspend fun clearSubmittedDraft(draftId: String): NativeDraft = operations.withLock {
        val current = currentDraft(draftId, null) ?: throw IllegalArgumentException("draft not found")
        store.save(
            NativeDraftWrite(id = current.id, sessionId = current.sessionId, text = "", attachments = emptyList()),
            current.revision,
        ).also { refresh() }
    }

    suspend fun acknowledge(pendingId: String, sessionId: String): NativeSendReconciliationResult =
        operations.withLock {
            val result = store.reconcileSend(
                pendingId,
                NativeSendReconciliation.ACKNOWLEDGED,
                acknowledgedSessionId = sessionId,
            )
            if (!result.found) return@withLock result.also { refresh() }
            val snapshot = refresh()
            snapshot.drafts.firstOrNull {
                it.id == result.draftId && it.text.isBlank() && it.attachments.isEmpty() &&
                    snapshot.pendingSends.none { pending -> pending.draftId == it.id }
            }?.let { store.remove(it.id, it.revision) }
            refresh()
            result
        }

    @Throws(Exception::class, CancellationException::class)
    suspend fun notCommittedIfEmpty(pendingId: String): NativeDraft? = operations.withLock {
        val pending = refresh().pendingSends.firstOrNull { it.pendingId == pendingId } ?: return@withLock null
        val editor = currentDraft(pending.draftId, null)
        if (editor != null && (editor.text.isNotBlank() || editor.attachments.isNotEmpty())) {
            throw NativeDraftConflictException(editor)
        }
        store.reconcileSend(pendingId, NativeSendReconciliation.NOT_COMMITTED).restoredDraft.also { refresh() }
    }

    @Throws(Exception::class, CancellationException::class)
    suspend fun preserveRestoredDraft(editorId: String, draftId: String, expectedRevision: Long, nextText: String): NativeDraft? = operations.withLock {
        if (editorId in retiredEditors.load()) return@withLock null
        store.preserveRestoredDraft(draftId, expectedRevision, nextText).also { refresh() }
    }

    suspend fun notCommitted(pendingId: String): NativeDraft? = operations.withLock {
        val restored = store.reconcileSend(pendingId, NativeSendReconciliation.NOT_COMMITTED).restoredDraft
        refresh()
        restored
    }

    suspend fun discard(draftId: String): Boolean = operations.withLock {
        val draft = _snapshot.value.drafts.firstOrNull { it.id == draftId }
            ?: refresh().drafts.firstOrNull { it.id == draftId }
            ?: return@withLock false
        store.remove(draft.id, draft.revision)
        discardedDraftIds += draft.id
        refresh()
        _discardedDrafts.emit(draft.id)
        true
    }

    suspend fun detachDeletedSession(sessionId: String) = operations.withLock {
        store.detachDeletedSession(sessionId)
        detachedSessionIds += sessionId
        refresh()
        Unit
    }

    suspend fun persistDelete(sessionId: String): NativeDeleteIntent = operations.withLock {
        val intent = store.saveDeleteIntent(sessionId)
        refresh()
        intent
    }

    suspend fun markDeleteFailure(sessionId: String, failureCode: String) = operations.withLock {
        store.saveDeleteIntent(sessionId, failureCode)
        refresh()
        Unit
    }

    suspend fun completeDelete(sessionId: String) = operations.withLock {
        store.removeDeleteIntent(sessionId)
        refresh()
        Unit
    }

    suspend fun close() = operations.withLock { store.closeStore { driver?.close() } }

    private suspend fun refresh(): NativeDraftSnapshot = store.list().also { _snapshot.value = it }

    private suspend fun currentDraft(draftId: String?, sessionId: String?): NativeDraft? {
        val snapshot = _snapshot.value.takeIf { it.drafts.isNotEmpty() || it.pendingSends.isNotEmpty() || it.deleteIntents.isNotEmpty() }
            ?: refresh()
        return if (draftId != null) snapshot.drafts.firstOrNull { it.id == draftId }
        else if (sessionId != null) snapshot.drafts.firstOrNull { it.sessionId == sessionId }
        else null
    }
}
