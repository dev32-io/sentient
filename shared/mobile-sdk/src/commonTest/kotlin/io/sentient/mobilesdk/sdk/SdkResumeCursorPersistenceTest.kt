// ---------------------------------------------------------------------------
// SdkResumeCursorPersistenceTest — pins the durable resume-cursor lifecycle
// (Task 4.7): SEED on resume-prep, SAVE on cursor advance (coalesced to the turn
// boundary), CLEAR on a non-recovered reset. These are the three hooks the
// orchestrator drives against the injected [ResumeCursorStore].
//
// KEEPER (per .claude/rules/testing.md): the seed/save/clear lifecycle is the wire
// contract that lets a relaunched app `stream.resume` on recovered:true within the
// gateway's replay-buffer TTL instead of recovered:false + a full REST refetch.
// The bug it guards: a fresh launch with an empty in-memory cursor would send NO
// resume (recovered:false → refetch) even though a valid snapshot was on disk.
//
// Drives the REAL orchestrator over a FakeWebSocketEngine under runTest virtual
// time (mirrors SdkResumeReconciliationTest). The cursor advances via SEQ-stamped
// frames; the store records every load/save/clear for assertion.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.transport.CursorSnapshot
import io.sentient.mobilesdk.transport.ResumeCursor
import io.sentient.mobilesdk.transport.ResumeCursorPersistence
import io.sentient.mobilesdk.transport.ResumeCursorStore
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class SdkResumeCursorPersistenceTest {

    private val anchoredUuid = "8f3c1d2e-aaaa-bbbb-cccc-0000000004f7"

    /** Records every load/save/clear; preload via [seed] to simulate a prior app run. */
    private class RecordingResumeCursorStore(
        private val preloaded: MutableMap<String, CursorSnapshot> = mutableMapOf(),
    ) : ResumeCursorStore {
        val loads = mutableListOf<String>()
        val saves = mutableListOf<Pair<String, CursorSnapshot>>()
        val clears = mutableListOf<String>()

        fun seed(conversationId: String, snapshot: CursorSnapshot) {
            preloaded[conversationId] = snapshot
        }

        override fun load(conversationId: String): CursorSnapshot? {
            loads += conversationId
            return preloaded[conversationId]
        }

        override fun save(conversationId: String, snapshot: CursorSnapshot) {
            saves += conversationId to snapshot
            preloaded[conversationId] = snapshot
        }

        override fun clear(conversationId: String) {
            clears += conversationId
            preloaded.remove(conversationId)
        }
    }

    private fun createdFrame(uuid: String) =
        "{\"type\":\"session.created\",\"sessionId\":\"$uuid\",\"ts\":1}"

    private fun turnStartedSeq(seq: Long, turnId: String = "t1") =
        "{\"type\":\"turn.started\",\"turnId\":\"$turnId\",\"trigger\":\"user\",\"seq\":$seq,\"epoch\":3}"

    private fun turnCompletedFrame(turnId: String = "t1") =
        "{\"type\":\"turn.completed\",\"turnId\":\"$turnId\"}"

    private fun streamResumedFrame(recovered: Boolean) =
        "{\"type\":\"stream.resumed\",\"recovered\":$recovered,\"epoch\":3}"

    private fun resumeFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"session.configure\"") && it.contains("\"resume\":") }

    private fun deleteClient(status: HttpStatusCode) = SessionsHttpClient(
        httpClient = HttpClient(MockEngine { respond("{\"code\":\"not_found\"}", status) }),
        gatewayWsUrl = "wss://test/api/v1/ws",
        token = { "token" },
    )

    @Test
    fun reopening_selected_pending_reestablishes_its_identity_on_a_fresh_generation() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val first = "d_0123456789abcdef0123456789abcdef"
        val second = "d_fedcba9876543210fedcba9876543210"

        val firstGeneration = sdk.restorePendingMintAnchor(first, sdk.surfaceId)!!
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        runCurrent()
        assertTrue(fake.sentText.last { it.contains("\"type\":\"session.configure\"") }.contains("\"conversationId\":\"$first\""))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }

        val secondGeneration = sdk.restorePendingMintAnchor(second, sdk.surfaceId)!!
        assertTrue(secondGeneration > firstGeneration)
        sdk.connection.first { fake.openedUrls.size >= 3 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        runCurrent()
        val configure = fake.sentText.last { it.contains("\"type\":\"session.configure\"") }
        assertTrue(configure.contains("\"conversationId\":\"$second\""), configure)
        assertTrue(configure.contains("\"surfaceId\":\"${sdk.surfaceId}\""), configure)
    }

    @Test
    fun restored_draft_anchor_is_replayed_in_first_configure_with_same_surface() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        val draftKey = "d_0123456789abcdef0123456789abcdef" // gitleaks:allow — synthetic draft/session handle, not an authentication secret

        assertTrue(sdk.restorePendingMintAnchor(draftKey, sdk.surfaceId) != null)
        connectToReady(sdk, fake)

        val configure = fake.sentText.first { it.contains("\"type\":\"session.configure\"") }
        assertTrue(configure.contains("\"conversationId\":\"$draftKey\""), configure)
        assertTrue(configure.contains("\"surfaceId\":\"${sdk.surfaceId}\""), configure)
    }

    // ── SEED ────────────────────────────────────────────────────────────────────

    @Test
    fun empty_cursor_seeds_from_store_so_reconnect_carries_persisted_epoch_and_seq() = runTest {
        val store = RecordingResumeCursorStore()
        // A prior app run persisted a cursor for this conversation (epoch 3, lastSeq 12).
        store.seed(anchoredUuid, CursorSnapshot(epoch = 3, lastSeq = 12))

        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake, resumeCursorStore = store)
        connectToReady(sdk, fake)

        // Anchor the conversation (no seq-stamped frames yet → in-memory cursor empty).
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }

        // Drop → reconnect. resumeParams() seeds the empty cursor from the store, so the
        // reconnect's session.configure carries the PERSISTED epoch/lastSeq.
        fake.failIncoming("network drop")
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()

        assertTrue(store.loads.contains(anchoredUuid), "resume-prep must load the persisted cursor, loads=${store.loads}")
        val resume = resumeFrames(fake.sentText)
        assertTrue(resume.isNotEmpty(), "seeded cursor must carry resume in configure, sent=${fake.sentText}")
        assertTrue(
            resume.single().contains("\"epoch\":3") && resume.single().contains("\"lastSeq\":12"),
            "resume must carry the PERSISTED epoch/lastSeq, frame=${resume.single()}",
        )
    }

    // ── SAVE ────────────────────────────────────────────────────────────────────

    @Test
    fun cursor_advance_persists_snapshot_at_turn_boundary() = runTest {
        val store = RecordingResumeCursorStore()
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake, resumeCursorStore = store)
        connectToReady(sdk, fake)

        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }

        // A seq-stamped frame advances the in-memory cursor (epoch 3, lastSeq 9) but
        // the SAVE is coalesced — it does not write until the turn boundary.
        fake.emit(WsIncoming.Text(turnStartedSeq(seq = 9)))
        runCurrent()
        assertTrue(store.saves.isEmpty(), "advance alone must NOT write (coalesced), saves=${store.saves}")

        // turn.completed flushes the dirty cursor → exactly one save with the snapshot.
        fake.emit(WsIncoming.Text(turnCompletedFrame()))
        runCurrent()
        assertEquals(1, store.saves.size, "turn boundary must flush exactly one save, saves=${store.saves}")
        assertEquals(anchoredUuid to CursorSnapshot(epoch = 3, lastSeq = 9), store.saves.single())
    }

    // ── CLEAR ───────────────────────────────────────────────────────────────────

    @Test
    fun recovered_false_clears_the_persisted_cursor() = runTest {
        val store = RecordingResumeCursorStore()
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake, resumeCursorStore = store)
        connectToReady(sdk, fake)

        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }
        // Advance the cursor so a reconnect attempts resume.
        fake.emit(WsIncoming.Text(turnStartedSeq(seq = 5)))
        runCurrent()

        fake.failIncoming("network drop")
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()

        // The gateway could NOT resume → recovered:false: the persisted cursor is stale
        // and must be cleared so the next relaunch doesn't re-seed a dead epoch.
        fake.emit(WsIncoming.Text(streamResumedFrame(recovered = false)))
        runCurrent()

        assertTrue(store.clears.contains(anchoredUuid), "recovered:false must clear the persisted cursor, clears=${store.clears}")
    }

    // ── NULL conversationId — advance is NOT lost ────────────────────────────

    @Test
    fun flush_with_null_conversationId_retains_dirty_flag_and_saves_once_id_is_available() {
        // Build ResumeCursorPersistence directly — no full SDK needed.
        val store = RecordingResumeCursorStore()
        val cursor = ResumeCursor()
        var currentId: String? = null
        val persistence = ResumeCursorPersistence(
            cursor = cursor,
            store = store,
            conversationId = { currentId },
        )

        // Advance the in-memory cursor to epoch 3, seq 7.
        cursor.tryApply(seq = 7L, incomingEpoch = 3L)
        persistence.noteAdvance()

        // Flush while conversationId is null — nothing must be saved, dirty stays set.
        persistence.flush()
        assertTrue(store.saves.isEmpty(), "flush with null id must NOT save, saves=${store.saves}")

        // Now the conversationId becomes available — the SAME advance must reach the store.
        currentId = anchoredUuid
        persistence.flush()
        assertEquals(1, store.saves.size, "flush after id arrives must save exactly once, saves=${store.saves}")
        assertEquals(anchoredUuid to CursorSnapshot(epoch = 3, lastSeq = 7), store.saves.single())
    }

    // ── clearFor — delete path ───────────────────────────────────────────────

    @Test
    fun deleteSession_clears_persisted_cursor_after_server_success() = runTest {
        val store = RecordingResumeCursorStore()
        store.seed(anchoredUuid, CursorSnapshot(epoch = 3, lastSeq = 5))
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake, resumeCursorStore = store, sessionsHttpClient = deleteClient(HttpStatusCode.NoContent))
        connectToReady(sdk, fake)

        sdk.deleteSession(anchoredUuid)

        assertEquals(listOf(anchoredUuid), store.clears)
    }

    @Test
    fun deleteSession_preserves_persisted_cursor_on_server_failure() = runTest {
        val store = RecordingResumeCursorStore()
        store.seed(anchoredUuid, CursorSnapshot(epoch = 3, lastSeq = 5))
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake, resumeCursorStore = store, sessionsHttpClient = deleteClient(HttpStatusCode.NotFound))
        connectToReady(sdk, fake)

        val failure = runCatching { sdk.deleteSession(anchoredUuid) }.exceptionOrNull()

        assertIs<SessionsRequestException>(failure)
        assertTrue(store.clears.isEmpty(), "failed delete must preserve resume continuity")
    }
}
