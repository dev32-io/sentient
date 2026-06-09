# Mobile Clean-Architecture Refactor (Design)

Date: 2026-06-08 · Branch: `feature/mobile-client` · Platforms: Android + iOS (KMP shared)

Restructure the mobile clients onto a clean, lifecycle-correct architecture: a shared UseCase
layer over stateless repos, framework-managed VM lifecycle (Hilt / SwiftUI-native), and
**route-based navigation where a conversation is a route**. The active conversation's lifecycle
becomes the natural cleanup boundary, dissolving the cross-conversation state leaks that the
session-scoped repos produced.

---

## Why

Today: manual constructor DI, **no UseCase layer**, a state-gate root (history is an overlay,
not a route), one `MobileSession` that **spans conversations**, and **stateful repos**. Business
and state logic swim between VM and repo. Switching conversation is an in-place mutation, so
per-conversation state (the optimistic outbox, the live-reveal bubble, cycle-id stamps) leaked
into the next conversation — producing duplicated bubbles and stale pending sends. The attempted
fix (`reset()` on a session-switch wire frame) is fragile and provably wrong: `newChat` emits
`session.created` (not `session.switched`), and resume re-emits `session.switched` with the same
id, so a frame-based reset both misses new-chat and wrongly clears the outbox on resume.

Root cause: **state is session-scoped, not conversation-scoped.** The lifecycle boundary does not
match the conceptual boundary.

---

## Target architecture

### Three scopes

| Scope | Lifetime | Owns |
|---|---|---|
| **App** | process | nav host, config, token store, backend resolution |
| **User / Connection** | login → logout | SDK + socket + ConnectionManager + stateless repos + usecase factory. **One per logged-in user**; survives all navigation inside the authed area, so the socket never drops on conversation switch or history navigation. |
| **Route / Screen** | one per nav destination | the **thin VM** (per-screen + view-local state) and its usecase subscriptions. **Chat VM is keyed on `sessionId`.** |

A conversation switch is `navigate(Chat(sessionId))`. That recreates the Chat VM, so every piece
of per-conversation state — the outbound cache, the live-reveal fold, the active `sessionId` — is
constructed fresh. **There is no `reset()` anywhere.** The SDK in the User scope just receives
`switchSession(id)`; the socket stays up.

### Layers

```
UI (Compose / SwiftUI)
  → VM (thin, native per platform: Hilt ViewModel / SwiftUI @Observable)
      → UseCase (shared commonMain — combine/transform across sources)
          → Repository (shared commonMain — STATELESS SDK-surface mappers)
              → SDK (mobile-sdk blackbox: transport, connectors, connection)
```

- **Repositories (stateless).** Pure mappers, no accumulation, no `isConnected` gating, no combine.
  - `ConversationRepository` → `timeline: Flow<List<ChatMessage>>`, `liveEvents: Flow<SdkEvent>`, `send(text, pendingId)`.
  - `SessionsRepository` → `list / search / rename / delete / switchTo / newChat`.
  - `ConnectionRepository` → `state: Flow<ConnectionState>`.
- **UseCases (the business logic).**
  - `ObserveChatUseCase(sessionId, pending: Flow<List<Pending>>) → Flow<ChatModel>` — folds
    `liveEvents → reveal` (typewriter ticker runs **inside** this flow), combines
    `timeline + reveal + pending`, applies suppress-by-cycleId (one bubble per cycle) and
    reconcile-by-pendingId. The reveal state that previously leaked is now an internal flow,
    born and cancelled with the subscription → per conversation, automatically.
  - `SwitchConversationUseCase(sessionId?)` → `switchTo(id)` or `newChat()`.
  - `SendMessageUseCase(text, pendingId)` → `ConversationRepository.send` (so the VM goes
    VM → usecase → repo → SDK, never touching the SDK directly).
  - History usecases: `ObserveSessionsUseCase`, `RenameSessionUseCase`, `DeleteSessionUseCase`.
- **VM (thin, native per platform).** Owns `currentSessionId` + the **`OutboundCache`**
  (pending list = view-local state, commonMain class held by the VM). On `init`: invoke
  `SwitchConversationUseCase(sessionId)`, collect `ObserveChatUseCase(sessionId, cache.pending)`,
  and observe `ConnectionRepository.state` to drain the cache when ready. `send(text)`:
  `cache.enqueue` + flush-if-ready. **The outbox never sees `isConnected`** — the VM owns the
  gate (no separate FlushPending usecase; the cache is VM-bound and stateful by nature, so it is
  cleared between conversations for free).

### How the leak / reset problem dissolves

| Case | Mechanism | Result |
|---|---|---|
| New chat | `navigate(Chat(null))` → fresh VM | empty conversation, no frame-sniffing |
| Load past session | `navigate(Chat(X))` → fresh VM | streams X clean |
| Background → resume | route unchanged → **same VM survives** | **queued outbox survives, flushes on reconnect** |
| Duplicate bubble | `ObserveChatUseCase` suppress-by-cycleId; reveal fold is subscription-scoped | one bubble per cycle, no stale live state |

No `reset()`, no cycle-id stamp cleanup, no wire-frame discrimination — the conversation
lifecycle does the cleanup.

---

## DI strategy

The shared module is a **library boundary**; a library must not impose a DI framework on its
consumers (Hilt is Android-only and serves neither the shared layer nor iOS).

- **Shared `commonMain`**: hand-wired manual factory (`UserComponent` / `ChatComponent` builds
  usecases from repos + SDK). Compile-time safe, framework-free, identical for both platforms.
- **Android**: Hilt manages VM lifecycle + nav-scoped VMs; a Hilt module pulls usecases from the
  shared factory.
- **iOS**: SwiftUI-native. `UserSession` (`@StateObject` at the authed root) holds the SDK +
  shared factory; it constructs VMs via `makeChatVM(sessionId:)`, passed into the view as
  `@StateObject`. The navigation layer (which owns the User scope) builds the VM — the iOS mirror
  of Hilt providing into the ViewModel at the destination.

---

## Navigation

Routes: `Splash · Setup · Login · Chat(sessionId?) · History · Settings`. Chat is the authed
**root**, parameterized by the active `sessionId`; History/Settings push over it. Selecting a
session pops back to a freshly-rebuilt Chat root with the new `sessionId`.

| Concern | Android | iOS |
|---|---|---|
| Route mechanism | Navigation-Compose `NavHost` | `NavigationStack` + `Route` enum |
| Fresh VM per conversation | `hiltViewModel()` @ back-stack entry, `sessionId` from `SavedStateHandle` | `.id(activeSessionId)` on the root `ChatView` |
| VM ← usecases | Hilt module ← shared factory | `UserSession.makeChatVM` ← shared factory |
| User/Connection scope | Hilt `@UserScope` singleton | `UserSession` `@StateObject` at authed root |
| Session switch | `navigate("chat?sessionId=X"){ popUpTo("chat"){inclusive} }` | `activeSessionId = X; path.removeAll()` |
| New chat | navigate chat, no arg | `activeSessionId = nil` |

`.id(activeSessionId)` is SwiftUI's exact analogue of Android recreating the VM on a route arg:
changing it gives the root `ChatView` a new identity, rebuilding its `@StateObject` VM fresh. The
SDK lives in the User scope above the stack on both platforms, so routing never drops the socket.

This is the foundation for future deep-linking (route args = `sessionId`).

**Open UI-presentation choice — the history drawer.** History becomes a route. The slide-over
drawer (recently rebuilt with the iOS-18 `UIGestureRecognizerRepresentable` + the directional-lock
gesture fix) **stays as that route's presentation** by default — the gesture work is preserved and
the UX is unchanged; only the data path behind it (drawer-open → fetch) becomes route-driven.
Alternative: History as a full pushed page. Recommendation: keep the drawer as the presentation
unless full-page is wanted. Confirm during spec review.

---

## Phasing

Each phase leaves the app building; old (`MobileSession`) and new paths coexist until both
platforms cut over, then old is deleted.

- **Phase 0 — Shared layer (additive, no UI change).** Stateless repos, the usecases (incl.
  `ObserveChatUseCase` combine + reveal fold), `OutboundCache`, the manual usecase factory.
  Unit tests for the combine/suppress/reconcile/reveal invariants. Old path untouched.
- **Phase 1 — Android cutover.** Hilt User-scope component + Navigation-Compose + thin `ChatVM`
  keyed on sessionId. Remove the state-gate root, `SdkSessionFactory` spanning, old VM. Maestro
  smoke (new-chat, switch, send→reveal→pills, resume-keeps-outbox).
- **Phase 2 — iOS cutover.** `UserSession` `@StateObject` + `NavigationStack`/`Route` + root
  `ChatView.id(activeSessionId)` + thin `@Observable` VM. Remove `createMobileSession` spanning,
  old VM. Maestro smoke (same matrix).
- **Phase 3 — Rules + delete dead code.** Delete `MobileSession`, the old repos, the
  `reset()`/Outbox/ReplyStream/Chat split scaffolding. Rewrite rules; update details docs.

The drawer / tool-pill / live-render UI fixes already landed this branch are orthogonal and carry
forward unchanged.

## Rules to rewrite (Phase 3)

All five currently mark this as "future work — don't build yet"; we are building it.

- `android-di` — manual ViewModel factory → Hilt (User-scope component + nav-scoped VMs).
- `ios-architecture-mvvm` + `android-architecture-mvi` — add the UseCase layer; VMs thin; "VM →
  usecase → repo" boundary; iOS VM = `@Observable` scoped to the `NavigationStack` destination.
- `mobile-navigation` — state-gate → typed route graph (Nav-Compose / `NavigationStack`); chat as
  route, history as route; deep-link-ready.
- `mobile-data/repositories` — stateful → **stateless** repos; combine/transform moves to
  usecases; the outbound cache is VM-local, not a shared repo.
- `mobile-data/session-lifecycle` — split User scope (SDK/socket, login→logout) from Route scope
  (per-conversation VM); conversation switch = navigation, not in-place mutation.

---

## E2E matrix (inline — per `e2e-testing` rule)

| Case | Platform | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| New chat is empty | iOS+And | in a conversation with history | tap new-chat | empty chat, composer ready, no prior pending/bubbles | `navigate Chat(null)` → fresh VM init → `newChat` → empty snapshot |
| Switch session clean | iOS+And | conversation A, A has pending/live | pick session B in history | B's messages only; **no A bubbles, no A pending** | `navigate Chat(B)` → fresh VM → `switchTo B` → B snapshot; A VM cleared |
| Live render one bubble | iOS+And | READY | send "write 3 sentences" | one bubble grows via typewriter then settles; no duplicate | `ObserveChat` reveal advances; suppress-by-cycle; commit settles same node |
| Live tool pill | iOS+And | READY | send a web-search prompt | pill `running→done` on the in-flight bubble, before/with text | `TaskUpserted running→finished` mid-cycle on live bubble |
| Resume keeps outbox | iOS+And | queued send while disconnected, backgrounded | foreground → reconnect | the queued bubble **survives** and flushes `queued→sent` | route unchanged → VM survives → flush-on-ready drains cache |
| Switch drops outbox | iOS+And | queued send in A | switch to B before reconnect | A's queued bubble **not** shown in B | A VM (cache) destroyed on route change |
| History route select | iOS+And | chat open | open history, tap a row | routes to that conversation; socket stays connected | history presentation → `navigate Chat(id)`; no reconnect in log |
| Drawer drag coexist | iOS | chat, drawer | horizontal drag opens/closes; vertical scrolls list | drawer follows finger; list does not move during horizontal drag | gesture begin-gate + failure-requirement; no scroll bleed |
| Tool-pill title | iOS+And | a tool ran | observe pill | prefix-stripped name (`web_search`, not `mcp_..._web_search`) | `formatToolName` applied at render |
| Deep-link-ready (smoke) | iOS+And | — | route to `Chat(id)` programmatically | lands on that conversation | route arg carries sessionId end-to-end |

---

## Risks

- **Large cross-platform cutover.** Mitigated by additive Phase 0 + per-platform cutover with old/new
  coexistence; delete only in Phase 3.
- **Hilt introduction on Android** is new infra (manifest, `@HiltAndroidApp`, component scoping) —
  contained to Phase 1; the shared layer stays framework-free.
- **iOS VM-injection timing** (`@StateObject` built from `UserSession`) — the destination/root builder
  constructs the VM eagerly and passes it in; verify it is not rebuilt on unrelated redraws (identity
  pinned by `.id(activeSessionId)`).
- **Reveal ticker inside a Flow** — must cancel cleanly when collection stops (conversation switch);
  use a structured `flow{}`/`channelFlow{}` ticker, not a detached coroutine.
- **History presentation** — keeping the drawer means the recently-fixed gesture must keep working
  once history data is route-driven; covered by the drawer-coexist e2e case.

## Out of scope

- Durable/persistent outbox + chat cache (still in-memory; dies with the User scope).
- Real deep-link URL scheme wiring (the route shape is the foundation; URL handlers are later).
- Voice/audio pipeline changes.
- Gateway/Hermes protocol changes.
