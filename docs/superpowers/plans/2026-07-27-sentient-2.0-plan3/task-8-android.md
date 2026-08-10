### Task 8: Android permission-prompt dialog (design spec §7.1, build-order slice 7)

**Depends on:** Task 5 (KMP-SDK rebase) for the `PermissionRequest` surface on `ChatComponent`. **Must match:** Task 9's iOS dismissal-semantics decision (see "Dismissal semantics" below — both platforms land on the same answer; the exact code below is aligned with Task 9's already-written contract so both mobile UI tasks consume the identical `shared/mobile-data` surface without conflicting).

#### Files

**Create**
- `/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/PermissionPromptDialog.kt`
- `/Users/kevinye/Development/sentient/android/src/test/kotlin/io/sentient/android/chat/PermissionPromptGuardTest.kt`

**Modify**
- `/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/ChatUiState.kt`
- `/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt`
- `/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/ChatContent.kt`
- `/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/nav/ChatHost.kt`

**Test**
- `/Users/kevinye/Development/sentient/android/src/test/kotlin/io/sentient/android/chat/PermissionPromptGuardTest.kt` (new, this task).

---

#### Scope boundary

Do **not** edit anything under `/Users/kevinye/Development/sentient/shared/mobile-sdk/` or `/Users/kevinye/Development/sentient/shared/mobile-data/` in this task — Task 5 owns the KMP surface this task consumes, including the `ChatComponent.pendingPermission` / `ChatComponent.respondPermission` passthroughs (they live in `shared/mobile-data`, a module BOTH this task and Task 9 read from — if either UI task tried to add those symbols itself, the two tasks would collide on the same file). If `PermissionRequest` / `ChatComponent.pendingPermission` / `ChatComponent.respondPermission` do not yet exist when this task starts, Task 5 has not landed — stop and wait, don't stub them locally.

Never log `PermissionRequest.description` at any level (mobile logging rule — chat/tool content is never logged, ids/names/lengths only; `PrivacyGuardTest` in `shared/mobile-sdk` enforces the sink). `toolName` is a fixed MCP-route identifier, not user content, and is safe to log (mirrors `ToolPillStrip`'s existing `toolName` usage and Task 9's iOS logging of the same field).

---

#### Interfaces

**Consumes — already shipped, read in full before editing (do not re-summarize from memory):**

`/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt` (216 lines) — the exact shape every new member below slots into. `init {}` currently runs five independent `viewModelScope.launch { … collect … }` loops (cold-history-replace, `observeChat`, connection-driven outbox flush, a periodic outbox sweep `while (isActive)`, and `reopenFailed`), plus three `StateFlow`s built with `.stateIn(...)` (`connection`, `talkMode`, `keepScreenOn`). This task adds a SIXTH, dedicated collector — never folded into `reopenFailed`'s block or any other existing one.

```kotlin
class ChatViewModel(
    private val component: ChatComponent,
    sessionId: String?,
) : ViewModel() {
    private val log = createLogger("android", "chat-viewmodel")
    private val cache = OutboundCache()
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()
    val connection: StateFlow<ConnectionState> = component.connection.state.stateIn(...)
    val talkMode: StateFlow<TalkMode> = component.talkMode.stateIn(...)
    val keepScreenOn: StateFlow<Boolean> = combine(talkMode, connection) { ... }.stateIn(...)

    init {
        component.switchConversation(sessionId)
        viewModelScope.launch { component.observeChat.coldHistoryReplaceSignal().collect { ... } }
        viewModelScope.launch { component.observeChat(cache.pending).collect { model -> ... } }
        viewModelScope.launch { component.connection.state.collect { conn -> ... } }
        viewModelScope.launch { while (isActive) { delay(SWEEP_INTERVAL_MS); ... } }
        viewModelScope.launch { component.reopenFailed.collect { ... } }
    }
    // fun send/retry/pressMic/releaseMic/lockMic/stopContinuous/toggleTts/interrupt/
    // reconnect/ensureConnected/onComposerFocus/dismissReopenFailedNotice
}
```

`/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/ChatUiState.kt` (39 lines) — `ErrorBanner`, `REOPEN_FAILED_NOTICE`, `ChatUiState(model, isLoading, banner, reopenFailedNotice)`, `reduceChatUi(prev, result)`. `reopenFailedNotice: String?` is this file's precedent for "a one-shot server-driven UI slice folded into `ChatUiState`" — `pendingPermissionRequest` follows the SAME placement pattern, but per the note below is NOT a passive auto-dismissed notice.

`/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/settings/components/DangerButton.kt` — `DangerButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, testTag: String = "danger-button")`. The destructive-affordance style for Deny (an `OutlinedButton` tinted `Colors.stop`) — used here as the `dismissButton` slot INSTEAD OF a plain `TextButton`, unlike `AddMemberDialog`/`ChangePinDialog`/`SignalLinkDialog`'s "Cancel" buttons. This is deliberate: declining a permission prompt is a real, consequential decision (the tool is blocked and the model is told the user refused), not a no-op dismiss.

`/Users/kevinye/Development/sentient/android/src/main/kotlin/io/sentient/android/chat/tool/ToolPillStrip.kt` — the args-preview text-block idiom this task's description block reuses verbatim: `fontFamily = JetBrainsMono, fontSize = tokens.type.sm, color = Color(Colors.ink2)`, wrapped in `Modifier.fillMaxWidth().background(Color(Colors.accent).copy(alpha = 0.10f)).padding(tokens.space.md)`. Also `formatToolName(rawName: String): String` (`io.sentient.mobilesdk.util.formatToolName`) — strips MCP/adapter routing prefixes for display; reused here for the tool-name line, not re-implemented.

**Consumes — from Task 5 (must exist before Step 1 of this task; identical to what Task 9/iOS already consumes):**

```kotlin
// shared/mobile-sdk — a new public sdk-facing type, same tier as ChatMessage/TaskSnapshotItem.
package io.sentient.mobilesdk.sdk

data class PermissionRequest(
    val requestId: String,
    val toolName: String,
    /** Server-rendered human-readable action + argument summary (design spec §7.1) —
     *  the client never re-derives this from raw tool args. */
    val description: String,
    val expiresAtMs: Long,
)
```

```kotlin
// shared/mobile-data/.../di/ChatComponent.kt — additions alongside the existing
// `talkMode: StateFlow<TalkMode>` / `interrupt()` / `forceReconnect()` passthroughs.

/** Outstanding permission-confirm prompt, or null. Single active prompt per session —
 *  SessionRuntime blocks the turn on it (design spec §5.3/§7.1). Goes non-null on
 *  `permission.request`, back to null on `permission.resolved` (any outcome — allowed,
 *  denied, or timeout all clear it identically). */
val pendingPermission: StateFlow<PermissionRequest?> get() = sdk.pendingPermission

/** Answer an outstanding permission prompt. Sends `permission.response{requestId,approved}`. */
suspend fun respondPermission(requestId: String, approved: Boolean) = sdk.respondPermission(requestId, approved)
```

Because `pendingPermission` is a `StateFlow` (continuous, conflating), the SDK/gateway side already owns the "which request is current" invariant (Task 6's `PermissionBroker` guarantees only one outcome ever settles a given `requestId`, and `denyAll`/timeout/abort are all funnelled through one `settle()`). This task's ViewModel therefore does **not** need its own request/resolve reducer — it only needs a small guard for its OWN local defensive timer (Step 2 below), which is a genuinely new piece of local state this task adds.

**Produces:**

```kotlin
// android/.../chat/ChatUiState.kt
data class ChatUiState(..., val pendingPermissionRequest: PermissionRequest? = null)
internal fun shouldClearOnLocalTimeout(current: PermissionRequest?, firedForRequestId: String): Boolean

// android/.../chat/ChatViewModel.kt
fun allowPermission()
fun denyPermission()

// android/.../chat/PermissionPromptDialog.kt
@Composable fun PermissionPromptDialog(request: PermissionRequest, remainingMs: Long, onAllow: () -> Unit, onDeny: () -> Unit)
```

---

#### Dismissal semantics — decision required (must match Task 9 / iOS)

**Decision: decision-required, with client-side optimistic dismiss on the user's own response.**

- Material3 `AlertDialog` is dismissible by default (back-press and tap-outside both invoke `onDismissRequest`) — unlike SwiftUI's plain `.alert`, which offers no such path on iOS. This dialog is a security decision gate, not a dismissible notice (design spec §7.1: "blocks the turn until answered"). A swipe/back must not silently produce ANY outcome — neither an implicit allow NOR an implicit deny. So this task sets `onDismissRequest = {}` (a no-op) **and** `DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false)` — the properties are what actually close off the platform's default dismiss paths; the empty lambda is defense-in-depth documentation, not the real guard.
- Tapping **Allow** or **Deny** does two things simultaneously: (1) `component.respondPermission(requestId, approved)` sends `permission.response` over the wire, and (2) the ViewModel clears `pendingPermissionRequest` locally *immediately*, ahead of the round trip — an optimistic update, the same pattern this VM already uses for optimistic sends (`OutboundCache`, reconciled later by id).
- **Server-driven dismissal**: when the 2-minute timeout elapses server-side (or the user answers), `permission.resolved` settles `ChatComponent.pendingPermission` to `null`; this VM's collector folds that into `pendingPermissionRequest = null`, dismissing the dialog with no local action. Global Constraints: this is a real server-side fail-closed deny — a timeout is never an implicit approval. The client never approves anything on timeout; it only reflects the dialog going away.
- **Local timeout fallback** (defense in depth, not authority — mirrors Task 9's iOS `armLocalTimeoutFallback` so both platforms give the same worst-case guarantee): the VM also arms a `viewModelScope.launch { delay(...) }` job until `expiresAtMs` when a prompt appears. If neither the user's tap nor the server's `permission.resolved` frame has cleared the prompt by then, the local job clears it anyway (logged as WARN) so the dialog can never hang forever on a lost/delayed frame. Nothing is sent to the server from this path — by the time it fires, the gateway's own matching timeout has already fail-closed denied the tool call.
- Every clearing path (the collector settling to `null`, the user's own tap, the local-timeout job) is guarded by `requestId` so a stale event for an old prompt can never clobber a newer one that has since replaced it — `shouldClearOnLocalTimeout` pins this for the local-timeout path (the only one where a stale fire is actually possible: the StateFlow-driven paths can never be stale because `StateFlow` only ever holds the CURRENT value).
- The countdown text shown to the user ("Expires in 1:47…") is a THIRD, purely cosmetic timer living entirely inside `PermissionPromptDialog`'s own `LaunchedEffect` — it decides nothing and is cancelled automatically by Compose's structural concurrency the instant the dialog leaves composition (which happens the moment `pendingPermissionRequest` goes `null`, whether from the user's tap, the server, or the local-timeout job above). This is the "local countdown" that gets implicitly cancelled on user response without any manual `Job` bookkeeping.

---

#### Note: the §7.2 two-bubble requirement needs NO Android change

Read before writing any code — this saves a wasted step. `android/src/main/kotlin/io/sentient/android/chat/message/ChatRows.kt`'s `chatRows(messages, nowMs)` builds exactly one `ChatRow.Msg(m, i)` per input `ChatMessage` inside a plain `for ((i, m) in messages.withIndex())` loop — no peeking at the previous row, no same-role coalescing. `MessageList.kt`'s `LazyColumn` then does `items(rows, key = { ... }) { row -> when (row) { is ChatRow.Msg -> MessageBubble(...) ... } }` — one `MessageBubble` per row, keyed by `messageRowKey` (`cyc-<turnId>` once Task 2/4 land the `cycleId → turnId` rename, else the entry id, else index). Two assistant `ChatMessage` entries with two different `turnId`s already render as two separate bubbles today, with no merge logic anywhere in these two files to touch. Confirm this by reading; do not add a de-duplication or grouping pass.

---

#### Steps

- [ ] **Step 1: Pre-flight — confirm Task 5's surface exists.**

  ```bash
  cd /Users/kevinye/Development/sentient
  grep -n "class PermissionRequest" shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/*.kt
  grep -n "pendingPermission\|respondPermission" shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/di/ChatComponent.kt
  ```
  Expect: both grep for `PermissionRequest` and both `pendingPermission`/`respondPermission` lines to print. If either is empty, **stop** — Task 5 has not landed and this task cannot proceed.

- [ ] **Step 2: Write the failing test for the local-timeout guard.** Create `/Users/kevinye/Development/sentient/android/src/test/kotlin/io/sentient/android/chat/PermissionPromptGuardTest.kt`:

  ```kotlin
  package io.sentient.android.chat

  import io.sentient.mobilesdk.sdk.PermissionRequest
  import kotlin.test.Test
  import kotlin.test.assertFalse
  import kotlin.test.assertTrue

  // Pins ChatViewModel's local-timeout-fallback guard (design spec §7.1): the
  // defensive job that clears a stale/lost permission prompt must never clobber a
  // NEWER prompt that has since replaced the one it was armed for. Mirrors Task 9's
  // iOS PermissionPromptFSMTests.localTimeoutFiredStaleIdIsNoOp / resolvedStaleIdIsNoOp.
  private fun request(id: String) = PermissionRequest(
      requestId = id,
      toolName = "assistant_signal_send_message",
      description = "Send a Signal message",
      expiresAtMs = 0,
  )

  class PermissionPromptGuardTest {

      @Test
      fun `matching requestId clears`() {
          assertTrue(shouldClearOnLocalTimeout(request("req-1"), "req-1"))
      }

      @Test
      fun `stale requestId does not clobber a newer pending request`() {
          assertFalse(shouldClearOnLocalTimeout(request("req-2"), "req-1"))
      }

      @Test
      fun `no pending request is never cleared by a late timeout fire`() {
          assertFalse(shouldClearOnLocalTimeout(null, "req-1"))
      }
  }
  ```

- [ ] **Step 3: Run the test and confirm the expected compile failure.**

  ```bash
  cd /Users/kevinye/Development/sentient && ./gradlew :android:testDebugUnitTest --tests "io.sentient.android.chat.PermissionPromptGuardTest"
  ```
  Expected failure: `error: unresolved reference: shouldClearOnLocalTimeout` (`PermissionRequest` itself resolves fine — Task 5 already landed it per Step 1).

- [ ] **Step 4: Add the field + guard function to `ChatUiState.kt`.** Add the import, then change the `data class ChatUiState` block and append the guard function:

  ```kotlin
  import io.sentient.mobiledata.model.ChatModel
  import io.sentient.mobiledata.result.SentientResult
  import io.sentient.mobilesdk.result.RetryPolicy
  import io.sentient.mobilesdk.sdk.PermissionRequest
  ```

  ```kotlin
  data class ChatUiState(
      val model: ChatModel = ChatModel(),
      val isLoading: Boolean = false,
      val banner: ErrorBanner? = null,
      /**
       * Non-null while the ReopenFailed one-shot notice is visible. The VM sets this
       * when [SdkEvent.ReopenFailed] arrives and clears it on acknowledgement (tap or
       * auto-dismiss). The notice is unrelated to [banner] (which reflects repo
       * failures); they are independent UI elements.
       */
      val reopenFailedNotice: String? = null,
      /**
       * Outstanding L3 permission-confirm prompt (design spec §7.1/§5.3), or null.
       * Mirrors [component.pendingPermission] (a `StateFlow` — single active prompt
       * per session) 1:1 via ChatViewModel.startPermissionCollecting; cleared
       * optimistically on Allow/Deny or when that StateFlow itself settles back to
       * null (server `permission.resolved`, any outcome). UNLIKE
       * [reopenFailedNotice], this is a decision gate, not a passive notice — see
       * ChatViewModel.armLocalTimeoutFallback for the one place a LOCAL clear can
       * also happen, and [shouldClearOnLocalTimeout] for the invariant that guards it.
       */
      val pendingPermissionRequest: PermissionRequest? = null,
  ) {
      /**
       * True while an existing-session switch is loading its history snapshot — the
       * message list shows a centered spinner over the cleared list. The composer is
       * NEVER gated on this; a brand-new chat stays false.
       */
      val historyLoading: Boolean get() = model.historyLoading
  }
  ```

  Append after `reduceChatUi`:

  ```kotlin
  /**
   * Guards ChatViewModel's local-timeout-fallback clearing decision against a stale
   * job firing after a NEWER request has replaced the one it was armed for (design
   * spec §7.1). Display-only: this decides nothing security-relevant — only whether
   * the LOCAL dialog should still be told to go away. Mirrors Task 9's iOS
   * `PermissionPromptFSM.reduce(..., .localTimeoutFired)` guard.
   */
  internal fun shouldClearOnLocalTimeout(current: PermissionRequest?, firedForRequestId: String): Boolean =
      current?.requestId == firedForRequestId
  ```

- [ ] **Step 5: Run the test again and confirm green.**

  ```bash
  cd /Users/kevinye/Development/sentient && ./gradlew :android:testDebugUnitTest --tests "io.sentient.android.chat.PermissionPromptGuardTest"
  ```
  Expected: PASS — 3 tests.

- [ ] **Step 6: Commit the state field + guard.**

  ```bash
  git add android/src/main/kotlin/io/sentient/android/chat/ChatUiState.kt android/src/test/kotlin/io/sentient/android/chat/PermissionPromptGuardTest.kt
  git commit -m "$(cat <<'EOF'
  feat(android): add pendingPermissionRequest to ChatUiState + local-timeout guard

  Pins the invariant a stale local-timeout-fallback fire must never clobber
  a newer permission prompt that has since replaced it (design spec §7.1),
  mirroring Task 9's iOS PermissionPromptFSM guard.
  EOF
  )"
  ```

- [ ] **Step 7: Wire the dedicated collector + timeout job + allow/deny into `ChatViewModel.kt`.** Add the import, the field, the collector call, the collector itself, and the public methods.

  Add to the imports:

  ```kotlin
  import io.sentient.mobilesdk.sdk.PermissionRequest
  import kotlinx.coroutines.Job
  ```

  Add a field next to `cache` (top of the class body):

  ```kotlin
      private val cache = OutboundCache()
      /** The active local-timeout-fallback job (see armLocalTimeoutFallback), or null.
       *  Re-armed per prompt; cancelled the instant a newer emission or a user
       *  response supersedes it. */
      private var permissionTimeoutJob: Job? = null
  ```

  Change the end of `init { ... }` — after the existing `reopenFailed` collector block, add the new call:

  ```kotlin
          viewModelScope.launch {
              component.reopenFailed.collect {
                  log.info("reopen-failed.notice.show")
                  _state.value = _state.value.copy(reopenFailedNotice = REOPEN_FAILED_NOTICE)
                  delay(REOPEN_FAILED_AUTO_DISMISS_MS)
                  // Auto-dismiss only if not already cleared by a tap.
                  if (_state.value.reopenFailedNotice != null) {
                      log.debug("reopen-failed.notice.auto-dismiss")
                      _state.value = _state.value.copy(reopenFailedNotice = null)
                  }
              }
          }
          startPermissionCollecting()
      }
  ```

  Add the dedicated collector + its local-timeout helper right after `init {}` closes (before `private val isReady`):

  ```kotlin
      /**
       * Dedicated collector for the SDK's `pendingPermission` StateFlow (design spec
       * §7.1) — a SEPARATE loop from every other collector in [init], never folded
       * into [reopenFailed]'s or any other block. `component.pendingPermission`
       * already carries the single-active-prompt invariant (Task 6's
       * `PermissionBroker` guarantees only one outcome ever settles a given
       * requestId), so this collector just mirrors it into [ChatUiState] and arms
       * the defensive local-timeout fallback per prompt.
       */
      private fun startPermissionCollecting() {
          viewModelScope.launch {
              component.pendingPermission.collect { pending ->
                  permissionTimeoutJob?.cancel()
                  log.info(
                      "permission.pending.changed",
                      mapOf("hasPending" to (pending != null), "toolName" to (pending?.toolName ?: "<none>")),
                  )
                  _state.value = _state.value.copy(pendingPermissionRequest = pending)
                  if (pending != null) armLocalTimeoutFallback(pending)
              }
          }
      }

      /**
       * Defensive UI-only backstop (design spec §7.1, "Dismissal semantics" in this
       * task's plan body): if neither the user's own tap nor the server's
       * `permission.resolved` frame clears this prompt by its `expiresAtMs`, clear it
       * locally so the dialog can never hang forever on a lost/delayed frame. NEVER
       * an approval or a denial — nothing is sent to the server from this path; by
       * the time it fires the gateway's own matching timeout has already fail-closed
       * denied the tool call server-side. Guarded by [shouldClearOnLocalTimeout]
       * against a stale fire clobbering a newer request.
       */
      private fun armLocalTimeoutFallback(request: PermissionRequest) {
          permissionTimeoutJob = viewModelScope.launch {
              delay((request.expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0))
              if (shouldClearOnLocalTimeout(_state.value.pendingPermissionRequest, request.requestId)) {
                  log.warn("permission.local-timeout-fallback", mapOf("requestId" to request.requestId))
                  _state.value = _state.value.copy(pendingPermissionRequest = null)
              }
          }
      }
  ```

  Add the public allow/deny methods, right after `dismissReopenFailedNotice()` (before `companion object`):

  ```kotlin
      /** User tapped Allow on the permission-prompt dialog (design spec §7.1). */
      fun allowPermission() = respondToPermission(approved = true)

      /** User tapped Deny on the permission-prompt dialog (design spec §7.1). */
      fun denyPermission() = respondToPermission(approved = false)

      private fun respondToPermission(approved: Boolean) {
          val requestId = _state.value.pendingPermissionRequest?.requestId ?: return
          permissionTimeoutJob?.cancel()
          log.info("permission.response.sent", mapOf("requestId" to requestId, "approved" to approved))
          // Optimistic local clear — see "Dismissal semantics" in this task's plan body.
          _state.value = _state.value.copy(pendingPermissionRequest = null)
          viewModelScope.launch { component.respondPermission(requestId, approved) }
      }
  ```

- [ ] **Step 8: Compile-check the android module.**

  ```bash
  cd /Users/kevinye/Development/sentient && ./gradlew :android:compileDebugKotlin
  ```
  Expected: BUILD SUCCESSFUL. Nothing calls `allowPermission`/`denyPermission` yet, so this is a pure additive compile check.

- [ ] **Step 9: Commit the ViewModel wiring.**

  ```bash
  git add android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt
  git commit -m "$(cat <<'EOF'
  feat(android): wire ChatViewModel's permission-prompt collector + allow/deny

  Dedicated startPermissionCollecting() loop mirrors ChatComponent's
  pendingPermission StateFlow into ChatUiState; a local-timeout job gives
  the same lost-frame backstop as Task 9's iOS armLocalTimeoutFallback,
  guarded by requestId so a stale fire never clobbers a newer prompt.
  EOF
  )"
  ```

- [ ] **Step 10: Create `PermissionPromptDialog.kt`.**

  ```kotlin
  // ---------------------------------------------------------------------------
  // PermissionPromptDialog — the L3 `confirm` permission prompt (design spec §7.1,
  // §5.3). Shown when the model wants to run a side-effecting tool and the PDP needs
  // a user decision. Pure/stateless — [request] + Allow/Deny callbacks are hoisted
  // from ChatViewModel via ChatContent/ChatHost, mirroring AddMemberDialog /
  // ChangePinDialog / SignalLinkDialog's state-in/callbacks-out shape. Allow uses the
  // canonical confirmButton TextButton; Deny uses DangerButton (the destructive-
  // affordance style) instead of a plain TextButton — this is a real decision, not
  // "Cancel": declining blocks the tool and the model is told the user refused.
  //
  // onDismissRequest is intentionally a NO-OP, and DialogProperties disables both
  // back-press and tap-outside dismissal: this is a security decision gate, not a
  // dismissible notice ("blocks the turn until answered" per spec §7.1). A
  // swipe/back must not silently produce ANY outcome — neither an implicit allow NOR
  // an implicit deny. The only exits are the two buttons below, or the server's own
  // `permission.resolved` / ChatViewModel's local-timeout fallback (see the
  // "Dismissal semantics" note in this file's originating plan task).
  //
  // The countdown is DISPLAY-ONLY — it decides nothing itself; it is driven by a
  // LaunchedEffect keyed on requestId, so Compose's structural concurrency cancels
  // it automatically the instant this dialog leaves composition (ChatViewModel
  // clears pendingPermissionRequest on Allow/Deny tap, on a matching
  // permission.resolved, or on its own local-timeout fallback) — no manual Job here.
  //
  // The description block reuses ToolPillStrip.kt's exact args-preview text idiom
  // (JetBrainsMono / ink2 / accent-tinted background @ alpha 0.10f / tokens.space.md
  // padding) rather than inventing new copy formatting.
  // ---------------------------------------------------------------------------
  package io.sentient.android.chat

  import androidx.compose.foundation.background
  import androidx.compose.foundation.layout.Arrangement
  import androidx.compose.foundation.layout.Column
  import androidx.compose.foundation.layout.fillMaxWidth
  import androidx.compose.foundation.layout.padding
  import androidx.compose.material3.AlertDialog
  import androidx.compose.material3.Text
  import androidx.compose.material3.TextButton
  import androidx.compose.runtime.Composable
  import androidx.compose.runtime.LaunchedEffect
  import androidx.compose.runtime.getValue
  import androidx.compose.runtime.mutableStateOf
  import androidx.compose.runtime.remember
  import androidx.compose.runtime.setValue
  import androidx.compose.ui.Modifier
  import androidx.compose.ui.graphics.Color
  import androidx.compose.ui.platform.testTag
  import androidx.compose.ui.tooling.preview.Preview
  import androidx.compose.ui.window.DialogProperties
  import io.sentient.android.settings.components.DangerButton
  import io.sentient.android.theme.JetBrainsMono
  import io.sentient.android.theme.LocalTokens
  import io.sentient.android.theme.SentientTheme
  import io.sentient.mobilesdk.design.Colors
  import io.sentient.mobilesdk.sdk.PermissionRequest
  import io.sentient.mobilesdk.util.formatToolName
  import kotlinx.coroutines.delay

  private const val DESCRIPTION_BG_ALPHA = 0.10f
  private const val COUNTDOWN_TICK_MS = 1_000L
  private const val MS_PER_SECOND = 1_000L
  private const val SECONDS_PER_MINUTE = 60L

  @Composable
  fun PermissionPromptDialog(
      request: PermissionRequest,
      onAllow: () -> Unit,
      onDeny: () -> Unit,
  ) {
      val tokens = LocalTokens.current
      val remainingMs = rememberRemainingMs(request.expiresAtMs)
      AlertDialog(
          onDismissRequest = {}, // no-op — see file header: this is a decision gate, not a notice.
          properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
          modifier = Modifier.testTag("chat-permission-dialog"),
          title = { Text("Allow this action?") },
          text = {
              Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                  Text(
                      text = formatToolName(request.toolName),
                      fontFamily = JetBrainsMono,
                      fontSize = tokens.type.sm,
                      color = Color(Colors.ink3),
                      modifier = Modifier.testTag("chat-permission-tool"),
                  )
                  Text(
                      text = request.description,
                      fontFamily = JetBrainsMono,
                      fontSize = tokens.type.sm,
                      color = Color(Colors.ink2),
                      modifier = Modifier
                          .fillMaxWidth()
                          .background(Color(Colors.accent).copy(alpha = DESCRIPTION_BG_ALPHA))
                          .padding(tokens.space.md)
                          .testTag("chat-permission-description"),
                  )
                  Text(
                      text = "Expires in ${formatRemaining(remainingMs)}",
                      color = Color(Colors.ink3),
                      fontSize = tokens.type.xs,
                  )
              }
          },
          confirmButton = {
              TextButton(onClick = onAllow, modifier = Modifier.testTag("chat-permission-allow")) {
                  Text("Allow")
              }
          },
          dismissButton = {
              DangerButton(label = "Deny", onClick = onDeny, testTag = "chat-permission-deny")
          },
      )
  }

  /** Display-only countdown to [expiresAtMs]. Never dismisses or decides anything —
   *  see the file header. Cancelled automatically when the caller leaves composition. */
  @Composable
  private fun rememberRemainingMs(expiresAtMs: Long): Long {
      var remaining by remember(expiresAtMs) {
          mutableStateOf((expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0))
      }
      LaunchedEffect(expiresAtMs) {
          while (remaining > 0) {
              delay(COUNTDOWN_TICK_MS)
              remaining = (expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0)
          }
      }
      return remaining
  }

  private fun formatRemaining(ms: Long): String {
      val totalSeconds = ms / MS_PER_SECOND
      val minutes = totalSeconds / SECONDS_PER_MINUTE
      val seconds = totalSeconds % SECONDS_PER_MINUTE
      return "%d:%02d".format(minutes, seconds)
  }

  @Preview
  @Composable
  private fun PermissionPromptDialogPreview() {
      SentientTheme {
          PermissionPromptDialog(
              request = PermissionRequest(
                  requestId = "req-1",
                  toolName = "assistant_signal_send_message",
                  description = "Send a Signal message to Bob: \"On my way\"",
                  expiresAtMs = System.currentTimeMillis() + 120_000L,
              ),
              onAllow = {},
              onDeny = {},
          )
      }
  }
  ```

- [ ] **Step 11: Compile-check the android module.**

  ```bash
  cd /Users/kevinye/Development/sentient && ./gradlew :android:compileDebugKotlin
  ```
  Expected: BUILD SUCCESSFUL. Nothing calls `PermissionPromptDialog` from production code yet.

- [ ] **Step 12: Commit the dialog composable.**

  ```bash
  git add android/src/main/kotlin/io/sentient/android/chat/PermissionPromptDialog.kt
  git commit -m "feat(android): add PermissionPromptDialog (design spec §7.1)"
  ```

- [ ] **Step 13: Render the dialog conditionally from `ChatContent.kt`.** Add two new parameters (after `onDismissReopenFailed`, before `userName`) and their KDoc entries, and render the dialog at the end of the function body.

  Change the KDoc block:

  ```kotlin
   * @param onDismissReopenFailed  Tap-to-dismiss for the ReopenFailed one-shot notice.
   * @param onAllowPermission    User tapped Allow on the permission-prompt dialog (spec §7.1).
   * @param onDenyPermission     User tapped Deny on the permission-prompt dialog (spec §7.1).
   * @param userName            Logged-in user's display name for bubble avatars.
  ```

  Change the parameter list:

  ```kotlin
      onComposerFocus: () -> Unit = {},
      onDismissReopenFailed: () -> Unit = {},
      onAllowPermission: () -> Unit = {},
      onDenyPermission: () -> Unit = {},
      userName: String = "You",
      modifier: Modifier = Modifier,
  ) {
  ```

  Change the end of the function body — after the outer `Box(...) { ... }` closes:

  ```kotlin
          // Connection banner floats over the top — same overlay pattern as ChatContent.
          if (connectionBanner != null) {
              ConnectionBanner(
                  state = connectionBanner,
                  onReconnect = onReconnect,
                  modifier = Modifier
                      .align(Alignment.TopCenter)
                      .safeDrawingPadding()
                      .padding(top = MARK_SIZE_CONTENT)
                      .testTag("banner-connection"),
              )
          }
      }

      // Permission-prompt dialog (design spec §7.1) — floats as its own system Window
      // (Material3 AlertDialog), so its position in this tree has no effect on where
      // it renders. Kept OUTSIDE the Box so it is structurally independent of the
      // connection-banner overlay above.
      uiState.pendingPermissionRequest?.let { request ->
          PermissionPromptDialog(request = request, onAllow = onAllowPermission, onDeny = onDenyPermission)
      }
  }
  ```

- [ ] **Step 14: Wire the callbacks through `nav/ChatHost.kt`.** Change the `ChatContent(...)` call:

  ```kotlin
          ChatContent(
              uiState = chatUi,
              connection = connection,
              userName = userName,
              onSend = chatVm::send,
              onRetry = chatVm::retry,
              onMicPress = chatVm::pressMic,
              onMicRelease = chatVm::releaseMic,
              onMicLock = chatVm::lockMic,
              onMicStopContinuous = chatVm::stopContinuous,
              onTtsToggle = chatVm::toggleTts,
              onInterrupt = chatVm::interrupt,
              onOpenHistory = { scope.launch { drawerState.open() } },
              onNewChat = onNewChat,
              onReconnect = chatVm::reconnect,
              onComposerFocus = chatVm::onComposerFocus,
              onDismissReopenFailed = chatVm::dismissReopenFailedNotice,
              onAllowPermission = chatVm::allowPermission,
              onDenyPermission = chatVm::denyPermission,
          )
  ```

- [ ] **Step 15: Compile-check the android module (final).**

  ```bash
  cd /Users/kevinye/Development/sentient && ./gradlew :android:compileDebugKotlin
  ```
  Expected: BUILD SUCCESSFUL.

- [ ] **Step 16: Run the full android unit suite as a regression check.**

  ```bash
  cd /Users/kevinye/Development/sentient && ./gradlew :android:testDebugUnitTest
  ```
  Expected: every existing suite under `android/src/test/` (`ChatViewModelTest`, `ReopenFailedNoticeTest`, `CycleErrorRecoveryTest`, `ChatRowsTest`, `ConnectionBannerStateTest`, `MicCornerGestureTest`, `PendingSendTest`, `LoadingStateTest`, `TypewriterTest`, `HistorySessionsErrorTest`, `BackendConfigTest`, `SplashGateTest`) plus the new `PermissionPromptGuardTest` all pass.

- [ ] **Step 17: Commit the ChatContent + ChatHost wiring.**

  ```bash
  git add android/src/main/kotlin/io/sentient/android/chat/ChatContent.kt android/src/main/kotlin/io/sentient/android/nav/ChatHost.kt
  git commit -m "$(cat <<'EOF'
  feat(android): render the permission-prompt dialog in ChatContent/ChatHost

  Wires ChatViewModel's allowPermission/denyPermission through ChatContent's
  state-in/callbacks-out surface into ChatHost. Two-bubble follow-up
  rendering (spec §7.2) needed no change — ChatRows already emits one row
  per ChatMessage, no consecutive-role merge logic exists to touch.
  EOF
  )"
  ```

---

#### E2E coverage (not this task)

The `permission-confirm-web` row in the design spec's §10.1 matrix (viewport column already lists `desktop 1280×900 + mobile 390×844`) is exercised end-to-end by Task 12 (native E2E, Maestro) using the `chat-permission-dialog` / `chat-permission-allow` / `chat-permission-deny` test tags this task adds (surfaced as Compose resource-ids per the mobile Maestro convention). This task's own verification is Steps 3/5 (TDD guard test) plus Steps 8/11/15/16 (compile + regression) — no Maestro flow is authored here.
