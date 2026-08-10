### Task 9: iOS permission dialog (design spec §7.1, build-order slice 7)

**Depends on:** Task 5 (KMP-SDK rebase) for the `PermissionRequest` surface on `ChatComponent`. **Must match:** Task 8's Android dismissal-semantics decision (see "Dismissal semantics" below — both platforms must land on the same answer).

#### Create

- `/Users/kevinye/Development/sentient/ios/App/Chat/banner/ChatPermissionAlert.swift` — the permission-prompt FSM + the `.permissionPrompt(...)` View extension modifier.
- `/Users/kevinye/Development/sentient/ios/Tests/PermissionPromptFSMTests.swift` — pins the FSM's requestId-guarded dismissal invariant.

#### Modify

- `/Users/kevinye/Development/sentient/ios/App/Chat/ChatViewModel.swift` — add `pendingPermission` published state, a dedicated `startPermissionCollecting()` collector, `respondPermission(_:approved:)`, `dismissPermissionPrompt()`, deinit cleanup.
- `/Users/kevinye/Development/sentient/ios/App/Chat/ChatView.swift` — attach `.permissionPrompt(...)` alongside the existing `.connectionState(...)` / `.panelRenamePrompt` / `.panelDeletePrompt` modifiers.

#### Test

- `/Users/kevinye/Development/sentient/ios/Tests/PermissionPromptFSMTests.swift` (new, this task).

---

#### Scope boundary

Do **not** edit anything under `/Users/kevinye/Development/sentient/shared/mobile-sdk/` or `/Users/kevinye/Development/sentient/shared/mobile-data/` in this task — Task 5 owns the KMP surface this task consumes. If `PermissionRequest` / `ChatComponent.pendingPermission` / `ChatComponent.respondPermission` do not yet exist when this task starts, Task 5 has not landed — stop and wait, don't stub them locally.

Never log `PermissionRequest.description` or raw tool args at any level (mobile logging rule — chat/tool content is never logged, ids/names/lengths only). `toolName` is a fixed MCP-route identifier, not user content, and is safe to log (mirrors `TaskStatusConnector`'s existing `toolName`/`taskId`/`status` logging, which likewise never logs `argsPreview`).

---

#### Interfaces

**Consumes — already shipped, read in full before editing (do not re-summarize from memory):**

`/Users/kevinye/Development/sentient/ios/App/Chat/ChatViewModel.swift` (328 lines) — the exact shape every new member below slots into:

```swift
@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var state = ChatUiState()
    @Published private(set) var connection: ConnectionState = makeDisconnectedConnection()
    @Published private(set) var talkMode: TalkMode = .idle
    @Published private(set) var keepScreenOn = false

    private let component: ChatComponent
    private let cache = createOutboundCache()

    private var chatTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var talkModeTask: Task<Void, Never>?
    private var coldReplaceTask: Task<Void, Never>?
    private var sweepTask: Task<Void, Never>?
    private var reopenFailedTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    init(component: ChatComponent, sessionId: String?) {
        self.component = component
        component.switchConversation.invoke(sessionId: sessionId)
        startChatCollecting()
        startConnectionCollecting()
        startTalkModeCollecting()
        startColdReplaceCollecting()
        startPeriodicSweep()
        startReopenFailedCollecting()
    }
    // ...
    deinit {
        chatTask?.cancel()
        connectionTask?.cancel()
        talkModeTask?.cancel()
        coldReplaceTask?.cancel()
        sweepTask?.cancel()
        reopenFailedTask?.cancel()
    }
}
```

`/Users/kevinye/Development/sentient/ios/App/Chat/banner/ChatPanelAlerts.swift` — the `alert(isPresented:presenting:)` idiom this task's modifier copies verbatim (Binding-driven optional payload, `presenting:` unwraps it into the action/message closures, no `Identifiable` conformance required on the payload type).

`/Users/kevinye/Development/sentient/ios/App/Chat/banner/ConnectionBanner.swift` — the private-`ViewModifier` + `extension View` wrapper shape this task's `.permissionPrompt(...)` mirrors, and the precedent for a pure derivation function (`ConnectionBannerState.derive`) living beside its View and getting a dedicated `XxxTests.swift`.

`/Users/kevinye/Development/sentient/ios/App/Chat/tool/ToolPillStrip.swift` line 34 — `formatToolName(rawName: t.toolName)`, a bridged top-level Kotlin function (`io.sentient.mobilesdk.util.formatToolName`, re-exported through `MobileData`) that strips MCP/adapter routing prefixes for display. Reused here for the dialog's tool-name line — do not re-implement the stripping logic.

**Consumes — from Task 5 (must exist before Step 6 of this task):**

The *only* surface this task needs — how Task 5 gets there internally (wire frame types, `SdkEvent` cases, orchestrator wiring) is Task 5's business, not pinned here:

```kotlin
// shared/mobile-sdk — a new public sdk-facing type, same tier as ChatMessage/TaskSnapshotItem
// (io.sentient.mobilesdk.sdk.PermissionRequest), NOT the raw wire frame type.
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

Bridged into Swift via the `MobileData` XCFramework exactly like the existing `component.talkMode` / `component.connection.state` StateFlows this task's new collector mirrors — direct `for await x in component.pendingPermission` iteration, no `SkieSwiftFlow(...)` wrapper needed (that wrapper is only required when passing a raw `StateFlow` as a function *argument*, e.g. `cache.pending` into `observeChat.invoke(pending:)`; a bare property read bridges to `AsyncSequence` directly, as `component.talkMode` already demonstrates).

**Produces:**

```swift
// ios/App/Chat/banner/ChatPermissionAlert.swift
enum PermissionPromptEvent {
    case requested(PermissionRequest)
    case resolved(requestId: String)
    case userResponded(requestId: String)
    case localTimeoutFired(requestId: String)
}
enum PermissionPromptFSM {
    static func reduce(current: PermissionRequest?, event: PermissionPromptEvent) -> PermissionRequest?
}
extension View {
    func permissionPrompt(
        _ request: Binding<PermissionRequest?>,
        onRespond: @escaping (String, Bool) -> Void
    ) -> some View
}
```

```swift
// ios/App/Chat/ChatViewModel.swift additions
@Published private(set) var pendingPermission: PermissionRequest?
func respondPermission(_ requestId: String, approved: Bool)
func dismissPermissionPrompt()
```

---

#### Dismissal semantics — decision-required (must match Task 8 / Android)

**Decision: decision-required, with client-side optimistic dismiss on the user's own response.**

- SwiftUI's plain `.alert(isPresented:presenting:)` has **no swipe-away or tap-outside dismissal** on iOS — the only way `isPresented` ever flips to `false` is one of the alert's own declared buttons (or a program-driven change to the bound value). There is no accidental/implicit-deny path to design against on this platform; the platform itself enforces decision-required.
- Tapping **Allow** or **Deny** does two things simultaneously: (1) fires `onRespond(requestId, approved)` → `ChatViewModel.respondPermission` sends `permission.response` over the wire, and (2) clears `pendingPermission` locally *immediately*, ahead of the `permission.resolved` round trip — an optimistic update, the same pattern this VM already uses for optimistic sends (`send(_:)` / `OutboundCache`, reconciled later by id). This is a pure responsiveness choice; the final state is identical either way.
- **Server-driven dismissal**: if the 2-minute timeout elapses server-side before the user acts, `permission.resolved{outcome:"timeout"}` settles `ChatComponent.pendingPermission` to `null`, which this VM's collector folds into `pendingPermission = nil` — dismissing the dialog without any local action. Global Constraints: this is a real server-side fail-closed deny: "a permission timeout is never an implicit approval." The client never approves anything on timeout; it only reflects the dialog going away.
- **Local timeout fallback** (defense in depth, not authority): the VM also arms a local `Task.sleep` until `expiresAtMs` when a prompt appears. If neither the user's tap nor the server's `permission.resolved` frame has cleared the prompt by then, the local timer clears it anyway so the dialog can never hang forever on a lost/delayed frame — logged as a WARN, never treated as an approval (nothing is sent to the server from this path; the tool call was already denied server-side by the time the frame would have arrived).
- Every clearing path (`resolved`, `userResponded`, `localTimeoutFired`) is guarded by `requestId` in `PermissionPromptFSM.reduce` so a stale event for an old prompt can never clobber a newer one that has since replaced it.
- **Task 8 (Android) must land the same two properties**: (a) the dialog cannot be dismissed except via Allow/Deny — an Android `AlertDialog` needs this made explicit (`setCancelable(false)` + disabled back-press), since Android's default IS dismissible by outside-tap/back-button, unlike iOS's `.alert`; (b) the same Allow=optimistic-immediate-dismiss / server-timeout-also-dismisses behavior, so a side-by-side web/Android/iOS walkthrough of the `permission-confirm` E2E case (design spec §10.1) behaves identically on all three surfaces.

---

#### Note: the §7.2 two-bubble requirement needs NO iOS change

Read before writing any code — this saves a wasted step. `ios/App/Chat/message/ChatRows.swift`'s `chatRows(_:)` builds exactly one `.message(m, index: i)` row per input `ChatMessage` (line 51: `rows.append(.message(m, index: i))`, inside a plain `for (i, m) in messages.enumerated()` loop — no peeking at the previous row, no same-role coalescing). `ios/App/Chat/message/MessageList.swift`'s `messageRows()` (line 174) then does `ForEach(chatRows(messages)) { row in ... MessageBubble(...) }` — one `MessageBubble` per row. Two assistant `ChatMessage` entries (two `turnId`s once Task 2/4 land the `cycleId → turnId` rename) already render as two separate bubbles today, with no merge logic anywhere in this file to touch. Confirm this by reading, do not add a de-duplication or grouping pass.

---

#### Steps

- [ ] **Step 1: Write the failing FSM test.** Create `/Users/kevinye/Development/sentient/ios/Tests/PermissionPromptFSMTests.swift`:

  ```swift
  import Testing
  import MobileData
  @testable import SentientApp

  // Pins the permission-prompt dismissal FSM (design spec §7.1): every clearing path
  // (.resolved / .userResponded / .localTimeoutFired) is guarded by requestId so a
  // stale event (a delayed server echo, an old countdown timer) never clobbers a NEWER
  // prompt that has since replaced the one it was raised for.
  struct PermissionPromptFSMTests {
      private func request(_ id: String) -> PermissionRequest {
          PermissionRequest(requestId: id, toolName: "search_web", description: "Search the web", expiresAtMs: 0)
      }

      @Test func requestedSetsPending() {
          let next = PermissionPromptFSM.reduce(current: nil, event: .requested(request("req-1")))
          #expect(next?.requestId == "req-1")
      }

      @Test func requestedReplacesAnOutstandingOne() {
          // Defensive only — SessionRuntime serializes one turn at a time, so two live
          // prompts shouldn't normally overlap — but the reducer must not get stuck.
          let next = PermissionPromptFSM.reduce(current: request("req-1"), event: .requested(request("req-2")))
          #expect(next?.requestId == "req-2")
      }

      @Test func resolvedMatchingIdClears() {
          let next = PermissionPromptFSM.reduce(current: request("req-1"), event: .resolved(requestId: "req-1"))
          #expect(next == nil)
      }

      @Test func resolvedStaleIdIsNoOp() {
          let next = PermissionPromptFSM.reduce(current: request("req-2"), event: .resolved(requestId: "req-1"))
          #expect(next?.requestId == "req-2")
      }

      @Test func userRespondedMatchingIdClears() {
          let next = PermissionPromptFSM.reduce(current: request("req-1"), event: .userResponded(requestId: "req-1"))
          #expect(next == nil)
      }

      @Test func localTimeoutFiredMatchingIdClears() {
          let next = PermissionPromptFSM.reduce(current: request("req-1"), event: .localTimeoutFired(requestId: "req-1"))
          #expect(next == nil)
      }

      @Test func localTimeoutFiredStaleIdIsNoOp() {
          // The countdown Task for an old prompt fires AFTER the user already answered
          // and a new prompt arrived — must not clobber the new one.
          let next = PermissionPromptFSM.reduce(current: request("req-2"), event: .localTimeoutFired(requestId: "req-1"))
          #expect(next?.requestId == "req-2")
      }
  }
  ```

- [ ] **Step 2: Run the test target and confirm the expected compile failure.**

  ```sh
  cd /Users/kevinye/Development/sentient/ios && xcodegen generate && xcodebuild test \
    -scheme SentientApp \
    -destination "platform=iOS Simulator,name=iPhone 15" \
    -resultBundlePath build/TestResults.xcresult \
    -derivedDataPath build/ \
    -quiet
  ```

  Expected failure: a build error, not a test failure — `error: cannot find type 'PermissionPromptFSM' in scope` / `cannot find type 'PermissionPromptEvent' in scope` (and, if Task 5 has landed, `PermissionRequest` resolves fine from `MobileData`; if it does not yet resolve, stop per the Scope boundary above — Task 5 hasn't landed).

- [ ] **Step 3: Implement the FSM + the alert modifier.** Create `/Users/kevinye/Development/sentient/ios/App/Chat/banner/ChatPermissionAlert.swift`:

  ```swift
  // ---------------------------------------------------------------------------
  // ChatPermissionAlert — the L3 permission-confirm dialog (design spec §7.1).
  //
  // Mirrors ChatPanelAlerts' alert(isPresented:presenting:) shape: bound to an
  // Optional payload via a Binding, no Identifiable conformance needed on the
  // payload. Decision-required — see the file header's cousin note in the task
  // that added this file: SwiftUI's plain .alert offers no swipe/tap-outside
  // dismissal on iOS, so Allow/Deny are the ONLY path out.
  //
  // Allow / Deny reuse the SAME two roles ChatPanelAlerts.panelDeletePrompt uses
  // for its destructive-confirm / cancel pair: Allow is the consequential grant
  // (role: .destructive — the entire point of an L3 confirm is that the tool is
  // risky) and Deny is the safe no-op default (role: .cancel).
  //
  // PermissionPromptFSM is the pure reducer ChatViewModel folds every
  // pendingPermission transition through, so the requestId-guard invariant is
  // unit-testable without a live AsyncSequence collector (see
  // ios/Tests/PermissionPromptFSMTests.swift).
  // ---------------------------------------------------------------------------
  import SwiftUI
  import MobileData

  /// Events that can change `ChatViewModel.pendingPermission`. Local-only
  /// (Swift-native) — not wire types.
  enum PermissionPromptEvent {
      /// A new prompt arrived from the SDK's `pendingPermission` StateFlow (permission.request).
      case requested(PermissionRequest)
      /// The SDK's `pendingPermission` StateFlow settled to null (permission.resolved —
      /// allowed / denied / timeout all clear identically; the outcome is server-side
      /// bookkeeping only, not a UI branch here).
      case resolved(requestId: String)
      /// The user tapped Allow or Deny locally — optimistic dismiss ahead of the round trip.
      case userResponded(requestId: String)
      /// The local `expiresAtMs` countdown elapsed before either of the above arrived — a
      /// defensive UI fallback only. The server has already fail-closed denied server-side
      /// (a timeout is never an implicit approval); this just unsticks the dialog if the
      /// `permission.resolved` echo is lost or delayed.
      case localTimeoutFired(requestId: String)
  }

  /// Pure reducer over `ChatViewModel.pendingPermission`. Every clearing path is guarded
  /// by requestId so a stale event never clobbers a NEWER prompt that has since replaced
  /// it. Decision-required: the ONLY way `pendingPermission` becomes nil is one of these
  /// three events matching the CURRENT requestId — there is no bare "dismiss" path.
  enum PermissionPromptFSM {
      static func reduce(current: PermissionRequest?, event: PermissionPromptEvent) -> PermissionRequest? {
          switch event {
          case .requested(let request):
              return request
          case .resolved(let requestId), .userResponded(let requestId), .localTimeoutFired(let requestId):
              return current?.requestId == requestId ? nil : current
          }
      }
  }

  extension View {
      /// Shows the outstanding permission-confirm prompt, if any, as a decision-required
      /// alert. `request` is a Binding the caller derives from `ChatViewModel.pendingPermission`
      /// (see ChatView) — its setter routes a binding-driven `nil` back into a VM call rather
      /// than mutating published state directly, per the MVVM view-calls-VM-methods rule.
      func permissionPrompt(
          _ request: Binding<PermissionRequest?>,
          onRespond: @escaping (String, Bool) -> Void
      ) -> some View {
          alert("Allow this action?", isPresented: Binding(
              get: { request.wrappedValue != nil },
              set: { if !$0 { request.wrappedValue = nil } }
          ), presenting: request.wrappedValue) { r in
              Button("Allow", role: .destructive) {
                  onRespond(r.requestId, true)
                  request.wrappedValue = nil
              }
              .accessibilityIdentifier("permission-allow")
              Button("Deny", role: .cancel) {
                  onRespond(r.requestId, false)
                  request.wrappedValue = nil
              }
              .accessibilityIdentifier("permission-deny")
          } message: { r in
              Text("\(formatToolName(rawName: r.toolName))\n\n\(r.description)")
          }
      }
  }
  ```

- [ ] **Step 4: Run the test target again and confirm green.** Same command as Step 2. Expected: build succeeds, all 7 tests in `PermissionPromptFSMTests` pass. Nothing in the app's runtime behavior has changed yet — no production code calls `PermissionPromptFSM` or `.permissionPrompt(...)` until Steps 6–12.

- [ ] **Step 5: Commit the FSM + modifier.**

  ```sh
  git add ios/Tests/PermissionPromptFSMTests.swift ios/App/Chat/banner/ChatPermissionAlert.swift
  git commit -m "$(cat <<'EOF'
  feat(ios): add permission-prompt FSM + alert modifier (design spec §7.1)

  Pure reducer over pendingPermission guarded by requestId so a stale
  resolved/timeout event never clobbers a newer prompt; the alert maps
  Allow/Deny onto the same destructive/cancel role pair ChatPanelAlerts
  already uses for its delete confirm.
  EOF
  )"
  ```

- [ ] **Step 6: Add the `pendingPermission` published property + task handles to `ChatViewModel`.** In `/Users/kevinye/Development/sentient/ios/App/Chat/ChatViewModel.swift`, change:

  ```swift
      @Published private(set) var keepScreenOn = false

      private let component: ChatComponent
  ```

  to:

  ```swift
      @Published private(set) var keepScreenOn = false

      /// Outstanding L3 permission-confirm prompt (design spec §7.1), or nil. Single
      /// active prompt per session — SessionRuntime blocks the turn on it.
      @Published private(set) var pendingPermission: PermissionRequest?

      private let component: ChatComponent
  ```

- [ ] **Step 7: Add the two new task handles + a ms constant.** Change:

  ```swift
      private var chatTask: Task<Void, Never>?
      private var connectionTask: Task<Void, Never>?
      private var talkModeTask: Task<Void, Never>?
      private var coldReplaceTask: Task<Void, Never>?
      private var sweepTask: Task<Void, Never>?
      private var reopenFailedTask: Task<Void, Never>?
      private let log = AppLog("chat", "viewmodel")

      /// Periodic outbox-sweep interval (unacked-timeout detection) in nanoseconds.
      private static let sweepIntervalNs: UInt64 = 1_000_000_000
      /// Auto-dismiss interval for the ReopenFailed notice (spec §14) in nanoseconds.
      private static let reopenFailedAutoDismissNs: UInt64 = 4_000_000_000
  ```

  to:

  ```swift
      private var chatTask: Task<Void, Never>?
      private var connectionTask: Task<Void, Never>?
      private var talkModeTask: Task<Void, Never>?
      private var coldReplaceTask: Task<Void, Never>?
      private var sweepTask: Task<Void, Never>?
      private var reopenFailedTask: Task<Void, Never>?
      private var permissionTask: Task<Void, Never>?
      /// Local defensive countdown to a shown prompt's expiresAtMs (see the "Dismissal
      /// semantics" note in this task's plan body). Re-armed per prompt; cancelled on
      /// any of: a new prompt replacing it, the server resolving it, or the user
      /// answering it locally.
      private var permissionTimeoutTask: Task<Void, Never>?
      private let log = AppLog("chat", "viewmodel")

      /// Periodic outbox-sweep interval (unacked-timeout detection) in nanoseconds.
      private static let sweepIntervalNs: UInt64 = 1_000_000_000
      /// Auto-dismiss interval for the ReopenFailed notice (spec §14) in nanoseconds.
      private static let reopenFailedAutoDismissNs: UInt64 = 4_000_000_000
      /// Nanoseconds per millisecond, for converting the wire's expiresAtMs into a
      /// Task.sleep(nanoseconds:) duration.
      private static let nsPerMs: UInt64 = 1_000_000
  ```

- [ ] **Step 8: Start the collector from `init`.** Change:

  ```swift
          startChatCollecting()
          startConnectionCollecting()
          startTalkModeCollecting()
          startColdReplaceCollecting()
          startPeriodicSweep()
          startReopenFailedCollecting()
      }
  ```

  to:

  ```swift
          startChatCollecting()
          startConnectionCollecting()
          startTalkModeCollecting()
          startColdReplaceCollecting()
          startPeriodicSweep()
          startReopenFailedCollecting()
          startPermissionCollecting()
      }
  ```

- [ ] **Step 9: Add the public `respondPermission` / `dismissPermissionPrompt` actions.** In the "Public actions" section, right after `dismissReopenFailedNotice()`:

  ```swift
      /// Tap-to-dismiss the ReopenFailed one-shot notice. Idempotent.
      func dismissReopenFailedNotice() {
          log.debug("reopen-failed.notice.dismissed")
          state.reopenFailedNotice = nil
      }
  ```

  add directly below it:

  ```swift
      /// Local optimistic dismiss — fires immediately on the user's own Allow/Deny tap,
      /// ahead of the `permission.resolved` round trip. See the "Dismissal semantics"
      /// note in this task's plan body.
      func dismissPermissionPrompt() {
          guard let current = pendingPermission else { return }
          permissionTimeoutTask?.cancel()
          pendingPermission = PermissionPromptFSM.reduce(current: current, event: .userResponded(requestId: current.requestId))
      }

      /// Answer an outstanding permission prompt. Sends `permission.response` over the
      /// wire; the dialog itself is dismissed by `dismissPermissionPrompt()`, called
      /// alongside this from the same button tap (see ChatPermissionAlert.permissionPrompt).
      func respondPermission(_ requestId: String, approved: Bool) {
          log.info("permission.response requestId=\(requestId) approved=\(approved)")
          Task { [weak self] in
              try? await self?.component.respondPermission(requestId: requestId, approved: approved)
          }
      }
  ```

- [ ] **Step 10: Add the collector + local-timeout-fallback implementation.** In the private collectors section, right after `startReopenFailedCollecting()`'s closing brace (before `deinit`):

  ```swift
      // ── Permission-prompt stream collection (design spec §7.1) ────────────────

      /// Dedicated collector for the SDK's pendingPermission StateFlow — a SEPARATE
      /// Task from every other collector in this file (never folded into an existing
      /// loop), cancelled in deinit like the rest.
      private func startPermissionCollecting() {
          permissionTask = Task { [weak self] in
              guard let self else { return }
              for await request in self.component.pendingPermission {
                  self.applyPermissionRequest(request)
              }
          }
      }

      private func applyPermissionRequest(_ request: PermissionRequest?) {
          permissionTimeoutTask?.cancel()
          if let request {
              pendingPermission = PermissionPromptFSM.reduce(current: pendingPermission, event: .requested(request))
              log.info("permission.request.shown requestId=\(request.requestId) toolName=\(request.toolName)")
              armLocalTimeoutFallback(for: request)
          } else if let previous = pendingPermission {
              // SDK settled to null — permission.resolved arrived (allowed / denied /
              // timeout all clear identically; the outcome itself is server-side
              // bookkeeping, not something this VM branches on).
              log.info("permission.resolved requestId=\(previous.requestId)")
              pendingPermission = PermissionPromptFSM.reduce(current: previous, event: .resolved(requestId: previous.requestId))
          }
      }

      /// Defensive UI-only fallback: if neither the user's own tap nor the server's
      /// permission.resolved frame clears this prompt by its expiresAtMs, clear it
      /// locally so the dialog can never hang forever on a lost/delayed frame. Never an
      /// approval — nothing is sent to the server from this path.
      private func armLocalTimeoutFallback(for request: PermissionRequest) {
          let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
          let remainingMs = max(0, request.expiresAtMs - nowMs)
          permissionTimeoutTask = Task { [weak self] in
              try? await Task.sleep(nanoseconds: UInt64(remainingMs) * Self.nsPerMs)
              guard let self, !Task.isCancelled else { return }
              let wasShowing = self.pendingPermission?.requestId == request.requestId
              self.pendingPermission = PermissionPromptFSM.reduce(
                  current: self.pendingPermission,
                  event: .localTimeoutFired(requestId: request.requestId)
              )
              if wasShowing {
                  self.log.warn("permission.request.local-timeout-fallback requestId=\(request.requestId)")
              }
          }
      }
  ```

- [ ] **Step 11: Cancel the two new tasks in `deinit`.** Change:

  ```swift
      deinit {
          chatTask?.cancel()
          connectionTask?.cancel()
          talkModeTask?.cancel()
          coldReplaceTask?.cancel()
          sweepTask?.cancel()
          reopenFailedTask?.cancel()
      }
  ```

  to:

  ```swift
      deinit {
          chatTask?.cancel()
          connectionTask?.cancel()
          talkModeTask?.cancel()
          coldReplaceTask?.cancel()
          sweepTask?.cancel()
          reopenFailedTask?.cancel()
          permissionTask?.cancel()
          permissionTimeoutTask?.cancel()
      }
  ```

- [ ] **Step 12: Attach the modifier in `ChatView`.** In `/Users/kevinye/Development/sentient/ios/App/Chat/ChatView.swift`, change:

  ```swift
          .connectionState(
              banner: connectionBanner,
              onReconnect: { vm.reconnect() },
              authExpired: connection.authExpired,
              onAuthExpired: { onLogout() }
          )
          .panelRenamePrompt($panelRenaming, text: $panelRenameText) { id, title in
              Task { await historyModel.renameSession(id, title: title) }
          }
          .panelDeletePrompt($panelDeleting) { id in
              Task { await historyModel.deleteSession(id) }
          }
  ```

  to:

  ```swift
          .connectionState(
              banner: connectionBanner,
              onReconnect: { vm.reconnect() },
              authExpired: connection.authExpired,
              onAuthExpired: { onLogout() }
          )
          .panelRenamePrompt($panelRenaming, text: $panelRenameText) { id, title in
              Task { await historyModel.renameSession(id, title: title) }
          }
          .panelDeletePrompt($panelDeleting) { id in
              Task { await historyModel.deleteSession(id) }
          }
          .permissionPrompt(
              Binding(
                  get: { vm.pendingPermission },
                  set: { if $0 == nil { vm.dismissPermissionPrompt() } }
              ),
              onRespond: { requestId, approved in vm.respondPermission(requestId, approved: approved) }
          )
  ```

- [ ] **Step 13: Build the app target to confirm the View wiring compiles.**

  ```sh
  cd /Users/kevinye/Development/sentient/ios && xcodebuild build \
    -scheme SentientApp \
    -configuration Debug \
    -destination "platform=iOS Simulator,name=iPhone 15" \
    -derivedDataPath build/ \
    -quiet
  ```

  Expected: build succeeds with no errors or new warnings.

- [ ] **Step 14: Run the full test suite as a regression check.**

  ```sh
  cd /Users/kevinye/Development/sentient/ios && xcodebuild test \
    -scheme SentientApp \
    -destination "platform=iOS Simulator,name=iPhone 15" \
    -resultBundlePath build/TestResults.xcresult \
    -derivedDataPath build/ \
    -quiet
  ```

  Expected: every existing suite in `ios/Tests/` (ChatRowsTests, ConnectionBannerStateTests, CycleErrorRecoveryTests, DisplayNameStoreTests, FollowLatestTests, LoadingAffordanceTests, MicCornerGestureTests, SendQueueTests, TypewriterTests) plus the new `PermissionPromptFSMTests` all pass.

- [ ] **Step 15: Commit the ViewModel + View wiring.**

  ```sh
  git add ios/App/Chat/ChatViewModel.swift ios/App/Chat/ChatView.swift
  git commit -m "$(cat <<'EOF'
  feat(ios): wire the permission-confirm dialog into ChatView (design spec §7.1)

  Dedicated pendingPermission collector on ChatComponent's new
  StateFlow, decision-required alert (Allow/Deny only — no swipe/tap
  dismiss on iOS), optimistic local clear on response, defensive local
  expiresAtMs fallback if permission.resolved is lost. Two-bubble
  follow-up rendering (§7.2) needed no change — ChatRows already emits
  one row per ChatMessage.
  EOF
  )"
  ```

---

#### E2E coverage (not this task)

The `permission-confirm-web` row in the design spec's §10.1 matrix (viewport column already lists `desktop 1280×900 + mobile 390×844`) is exercised end-to-end by Task 12 (native E2E, Maestro) using the `permission-allow` / `permission-deny` accessibility identifiers this task adds. This task's own verification is Steps 13–14 (build + unit test) plus the FSM coverage in Step 1 — no Maestro flow is authored here.
