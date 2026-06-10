// ---------------------------------------------------------------------------
// SyncCursorStore — durable per-conversation resume cursor {epoch, lastSeq}.
//
// Slice 3's SDK ResumeCursor (transport/ResumeCursor.kt) is in-memory: it dies
// with the process. This store persists the cursor across an app restart so that
// — within the gateway's 30-min replay-buffer TTL — a relaunched app can seed the
// SDK cursor and `stream.resume` lands on recovered:true (replay the gap) instead
// of recovered:false (reset + full REST refetch).
//
// Backed by multiplatform-settings' `Settings` interface — an injectable boundary
// the platform owner (UserSessionManager / IosUserSession) constructs concretely
// (SharedPreferencesSettings / NSUserDefaultsSettings) and threads through
// ChatComponent. commonMain stays pure: it only touches the `Settings` interface,
// never a platform API. Tests inject `MapSettings` (in-memory).
//
// Advance semantics: set() WRITES THROUGH unconditionally — it does not guard
// against regressing lastSeq. The caller owns advance/monotonicity: the SDK
// ResumeCursor already enforces seq > lastSeq before advancing, and the wiring
// (Slice 4.7) only persists the SDK's monotonic snapshot. Keeping the store dumb
// avoids duplicating that invariant in two places.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.cache

import com.russhwolf.settings.Settings
import io.sentient.mobilesdk.log.createLogger

/** Immutable persisted resume position for one conversation. */
data class CursorSnapshot(
    /** Gateway epoch the [lastSeq] belongs to. */
    val epoch: Long,
    /** Highest seq the client had applied in that epoch. */
    val lastSeq: Long,
)

/**
 * Durable per-conversation resume cursor over a multiplatform-settings [Settings].
 *
 * Keys are namespaced per conversation: `cursor.<id>.epoch` / `cursor.<id>.lastSeq`.
 * Both halves are always written/cleared together, so a present epoch implies a
 * present lastSeq (and vice versa); [get] treats a missing epoch as "no cursor".
 */
class SyncCursorStore(private val settings: Settings) {
    private val log = createLogger("data", "sync-cursor-store")

    /**
     * The persisted cursor for [conversationId], or null if none has been stored
     * (or it was cleared). Reads the epoch key as the presence sentinel.
     */
    fun get(conversationId: String): CursorSnapshot? {
        val epoch = settings.getLongOrNull(epochKey(conversationId)) ?: return null
        val lastSeq = settings.getLongOrNull(seqKey(conversationId)) ?: return null
        return CursorSnapshot(epoch = epoch, lastSeq = lastSeq)
    }

    /**
     * Persist [epoch] + [lastSeq] for [conversationId], overwriting any prior value.
     * Writes through unconditionally — advance/monotonicity is the caller's job
     * (see the file header). Both keys are written so [get] stays consistent.
     */
    fun set(conversationId: String, epoch: Long, lastSeq: Long) {
        settings.putLong(epochKey(conversationId), epoch)
        settings.putLong(seqKey(conversationId), lastSeq)
        log.debug(
            "set",
            mapOf("conversationId" to conversationId, "epoch" to epoch, "lastSeq" to lastSeq),
        )
    }

    /**
     * Remove the stored cursor for [conversationId]. Called on a recovered:false
     * resume (the buffer expired — start fresh) or a conversation delete.
     */
    fun clear(conversationId: String) {
        settings.remove(epochKey(conversationId))
        settings.remove(seqKey(conversationId))
        log.debug("clear", mapOf("conversationId" to conversationId))
    }

    private fun epochKey(conversationId: String): String = "$KEY_PREFIX$conversationId$EPOCH_SUFFIX"

    private fun seqKey(conversationId: String): String = "$KEY_PREFIX$conversationId$SEQ_SUFFIX"

    private companion object {
        /** Namespace for all cursor keys, so they don't collide with other prefs. */
        const val KEY_PREFIX = "cursor."
        const val EPOCH_SUFFIX = ".epoch"
        const val SEQ_SUFFIX = ".lastSeq"
    }
}
