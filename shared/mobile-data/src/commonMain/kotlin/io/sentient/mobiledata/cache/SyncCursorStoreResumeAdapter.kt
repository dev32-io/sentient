// ---------------------------------------------------------------------------
// SyncCursorStoreResumeAdapter — bridges the SDK's ResumeCursorStore (the durable
// persistence boundary the orchestrator seeds/saves/clears against) to mobile-data's
// SyncCursorStore (the multiplatform-settings-backed store, Task 4.4).
//
// DEPENDENCY INVERSION (Task 4.7): the SDK (mobile-sdk, lowest layer) DEFINES the
// ResumeCursorStore interface; this adapter (mobile-data, which depends on mobile-sdk)
// IMPLEMENTS it. The SDK never imports mobile-data — the platform owner wires this
// adapter INTO the SDK at construction, so the dependency arrow stays mobile-data →
// mobile-sdk.
//
// The two layers each own a CursorSnapshot {epoch, lastSeq} (the SDK's
// transport.CursorSnapshot is the wire/in-memory shape; mobile-data's cache layer
// works in epoch/lastSeq longs). This adapter maps between them at the boundary.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache

import io.sentient.mobilesdk.transport.CursorSnapshot
import io.sentient.mobilesdk.transport.ResumeCursorStore

/**
 * [ResumeCursorStore] backed by a [SyncCursorStore]. Round-trips the SDK's
 * [CursorSnapshot] through the durable epoch/lastSeq store, keyed by conversation id.
 */
class SyncCursorStoreResumeAdapter(
    private val store: SyncCursorStore,
) : ResumeCursorStore {

    override fun load(conversationId: String): CursorSnapshot? =
        store.get(conversationId)?.let { CursorSnapshot(epoch = it.epoch, lastSeq = it.lastSeq) }

    override fun save(conversationId: String, snapshot: CursorSnapshot) =
        store.set(conversationId, epoch = snapshot.epoch, lastSeq = snapshot.lastSeq)

    override fun clear(conversationId: String) = store.clear(conversationId)
}
