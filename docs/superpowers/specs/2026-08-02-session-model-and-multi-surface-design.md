# Session model redesign — server-minted sessions, surfaces as observers

**Status:** design approved 2026-08-02. Supersedes the per-surface conversation model on `feature/native-orchestrator`.

**Goal:** A session becomes a first-class, server-owned resource that a user can create, list and re-open — and any number of that user's surfaces can attach to one live session at once, all seeing the same stream, any of them able to speak into it.

---

## 1. Why this is a redesign and not a fix

The current model derives a conversation id from the surface: `c::<userId>::<surfaceId>` (`ws-session-configure.ts`). One surface therefore has exactly one conversation, forever, and "+ new chat" has nothing to hand back because **there is no allocator**.

That shape was correct under Hermes. Hermes owned the agent runtime and the session state, so the gateway could only key a conversation by something it held itself — the surface. The gateway now owns the loop, the store and the buffer, so the constraint that produced this design is gone. Keeping it costs two live defects:

- **D15** — "+ new chat" does not start a new chat. On web it does not even clear the mirror. Measured on the wire: `stream-start messageCount` 6→8 across the click, and the model recited a pre-click marker verbatim when denied an escape hatch. It is a **context leak**, not a cosmetic bug.
- **No past-chat list.** `GET /api/v1/sessions` 404s; both SDKs call it, and mobile's failure branch is `replaceMirror(emptyList())`.

---

## 2. The model

**The session is the unit of state. A surface is an observer.**

A session owns its **frame buffer**: one monotonic seq space carrying every outbound frame — text deltas, feed items, tool tiles, permission prompts, audio. Today `FrameJournal` belongs to a *connection*; it moves to the *session*. A surface holds a **cursor** into that buffer and nothing more.

This single move is what makes the rest simple:

- **Reconnect stops being special.** "Send me everything after seq N" is one operation, whether a surface dropped for 200 ms or is a phone joining the laptop's conversation.
- **Input needs no new concurrency model.** At most one turn runs per session; a message landing mid-turn *steers* it, one landing after the final answer starts a back-to-back turn. That is the existing 2.0 stimulus design (spec §5). More surfaces means more inputs into the same seam.
- **Fan-out is one seq space, not N.** Because the buffer belongs to the session, a frame is allocated once and every cursor reads the same bytes. (The rejected alternative — keeping per-connection journals and broadcasting — cannot share bytes at all, since the seq lives *inside* the frame, so each subscriber would need its own allocation.)

### Consequences that fall out for free

Three questions that look like separate features are answered by the model itself:

- **Permission prompts** — a prompt is a frame. Every attached surface sees it, any may answer, the first answer resolves it and the rest receive the resolution. The PDP must reject a second answer rather than re-decide.
- **Stop** — any surface can abort the turn. It is one session and one user.
- **Steer** — the existing mid-turn stimulus path.

---

## 3. Identity and security

### 3.1 What already holds

Isolation is structural today and does not need rebuilding:

- One SQLite file per user. `openSessionStore(cap)` derives the path from a **capability**, never from the request, and re-checks `capabilityCoversPath` before opening.
- Capabilities are minted in exactly one place — `AccessManager.grant`, from an authenticated `UserPrincipal` — and are frozen at mint.
- There is exactly one call site of `openSessionStore` in the gateway.

So `session_id` is a column *inside the caller's own database*. **A forged sessionId can only address a partition in the attacker's own file**, because the request never selects which database opens. That is the property this redesign must preserve, and it is preserved by construction.

### 3.2 What changes

**Server-minted, opaque sessionId.** No structure, no embedded userId, unguessable.

Three consequences, each replacing a string convention with a real check:

1. **Membership lookup replaces the prefix check.** `resolveConversationId` currently accepts any id starting with `c::<userId>::`. An opaque id cannot carry its owner, so attachment becomes *"does this session exist in the caller's own store"* — which is the stronger check, because the store queried is chosen by capability.
2. **An unknown sessionId is REJECTED.** Today an unknown id is *"a new conversation, not an error"*. With server-minted ids that is a flaw: a client must never present an id the server did not mint. Rejecting also closes junk-partition spam.
3. **The sessions route never accepts a userId.** It reads the principal. This is the classic authorization mistake and it is cheapest to prevent before the route exists.

**`session` becomes a `ResourceClass`** alongside `session-store | file-scope | tool-broker`, so attachment is mediated by the same L1→L2 capability chain as every other resource rather than by string convention.

### 3.3 Threat notes

- **Cross-user read via forged id** — blocked structurally (§3.1), and now also by membership lookup. Must be an E2E row, not a reasoned assertion.
- **Cross-surface leak within one user** — the new risk this design introduces. If the subscriber set is keyed wrongly, a surface could receive frames from a session it never joined. Attachment must be an explicit act naming a session id; never inferred from a connection.
- **Junk partitions** — closed by rejecting unknown ids plus lazy mint (§4).
- **A superseded socket acting on a live session** — `replay-registry.ts`'s lease model already solves the analogous journal problem; the subscriber set needs the same ownership discipline so a stale socket's close cannot detach the live one.

---

## 4. Lifecycle

- **Fresh surface starts fresh.** A surface with no stored sessionId begins a new session. Joining an ongoing one is always an explicit pick.
- **Mint on first message.** Connecting yields an empty draft; the id is minted and persisted when the user actually sends something. Ten opened tabs leave no trace. The client tolerates a null sessionId briefly — mobile already does.
- **Retention: 15 minutes after the session stops being retained** (§5), then drop. The conversation is durable in SQLite; dropping loses only the replay tail, and a later attach rehydrates.

### Existing data

Current partitions are `c::<userId>::<surfaceId>` — already valid opaque strings. They keep working and appear in the list. **No migration.** Only new sessions get the new id shape. This is a live-data requirement: the owner's real history is in those partitions.

---

## 5. `SessionRetention` — derived, never a flag

A stored `workInFlight` boolean would be set and cleared at several call sites and would eventually leak one, holding a session resident forever or dropping one mid-work. So retention is **derived from observable state on every evaluation**:

```
retained  =  subscribers > 0
          || a turn is in flight (ReAct iterating or streaming)
          || any foreground tool call is awaiting its result
          || any background task is registered and unfinished
          || a permission prompt is outstanding
          || an auxiliary task (§6) has not returned
```

**It returns reasons, not just a boolean, and logs them.** Without that, "why is this session still resident" is unanswerable and the grace timer becomes undebuggable.

Two invariants to pin with tests:

- the timer starts **only** on the transition to *not retained*;
- any input becoming true again **cancels** a running timer rather than racing it.

Note the pleasing closure: the titling call in §6 is itself a retention input, so a session cannot be dropped out from under its own title.

### Why this clause is mandatory, not defensive

Today the retention timer's expiry means "the client REST-refetches" — cheap and lossless. Under this design expiry **also disposes the runtime**. Without the derivation, a delegated task running with nobody attached would be killed at the 15-minute mark: work the user explicitly approved, destroyed because they closed a laptop.

### The config key

Reuse the existing timer rather than adding a second lifecycle — `replay-registry.ts` argues exactly this in its own header (retention is swept lazily inside `acquire()`/`release()` "without introducing a second lifecycle to reason about").

- `session.replay_journal_retention_ms: 300000` → **900000 (15 min)**.
- **Rename it.** The key now governs session lifetime, not only journal bytes; a name that under-describes its job is how the dead `session.idle_timeout_ms` key survived with zero readers. `operator-config-migrator.ts` carries existing installs across.
- `session.replay_journal_max_bytes` (16 MB) is now **per session**, not per surface. Re-tune and log evictions — see §8.

---

## 6. Titling, as an auxiliary-task handler

Deliberately **not** a titler. One encapsulated seam that takes a prompt template, a truncated slice of the conversation and a small output budget, and returns structured output. Titles are its first user; tags, follow-up suggestions and summarisation are the obvious next ones.

This follows [Open WebUI](https://docs.openwebui.com/features/workspace/prompts/), whose "task model" seam drives title generation, tag generation and follow-up suggestions from one place, with a `TITLE_GENERATION_PROMPT_TEMPLATE`, JSON output (`{"title": "..."}`), a 3–5 word target, and input truncation so a pasted document cannot blow the prompt.

Behaviour:

- Fires after the first assistant reply **commits**. Never blocks the reply.
- Small output cap, reasoning effort off — precisely what the `reasoning_effort` knob added in wave 1 is for.
- The result lands as a **frame on the session buffer**, so every attached surface renames live.
- On failure, fall back to a truncated first message. A session is never permanently "Untitled".
- A user rename always wins and is never overwritten.
- Prompt templates live in `.md` files with an operator-override loader, per the clean-code rule on large prompt content.

---

## 7. Attaching

A joining surface receives:

1. the **committed feed from the store** — durable, text, cheap; and
2. a cursor at the buffer's **head**.

It does **not** replay the buffer. Replaying an hour-old session would re-speak TTS the user already heard. Replay-from-cursor remains what it was built for: reconnects, where the client presents a seq it genuinely reached.

`render(replay) == render(live)` remains a protocol-contract invariant and must hold for a joiner as it does for a reconnecter.

---

## 8. Risks

- **Buffer memory.** The buffer now holds audio (~50 frames/s) for a whole *session* rather than one connection, and several devices may watch it for an hour. The byte cap and retention window both need re-tuning; evictions must be logged, not silent.
- **Attach during compaction.** Compaction rewrites the model projection at a turn boundary. A surface attaching mid-compaction must get a coherent feed; the client projection reads the full store and should be unaffected, but this needs an explicit test rather than an assumption.
- **The wire is frozen.** `shared/protocol` is a frozen contract. Distinguishing "the user pressed +" from "the app launched" — mobile fires `session.new` on **every launch**, twice per launch — needs either a new field or a new frame, and both SDKs move together. Minting on every `session.new` would fork a conversation per launch and destroy `reload-convergence` and `restart-persistence`.

---

## 9. Out of scope

- **Multi-user shared sessions.** A session belongs to one user; sharing means that user's own surfaces. Multi-user would need a partition no single capability covers, reworking the L1→L2 chain.
- **Audio routing / designated speaker.** All attached surfaces receive frames; each client decides what to do with them. Today they all play audio, which is acceptable.
- **Presence and typing indicators.**
- **Delegated-task silence (D16)** and the **untrusted-content boundary** — tracked separately in `docs/native-todo.md`.

---

## 10. E2E matrix

Local dev stack only (`http://localhost:5173`; never `mini0.lan` / `sentient.dev32.io`). Log in as **Ada**, PIN `1234`. Tool calls are reads or temp-writes only — no `ha_call_service`, no `ma_playback` / `ma_play_media` / `ma_volume`.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `newchat-mints` | desktop | authed, non-empty feed | press "+ new chat", then send | feed clears; model has NO prior context | new sessionId minted on the first message; `stream-start messageCount` counts only the fresh turn |
| `newchat-not-on-launch` | mobile | authed | launch the app twice | no new session appears | `session.new` resolves to the existing session both times |
| `draft-leaves-no-ghost` | desktop | authed | open a tab, close it without typing | history list unchanged | no session persisted |
| `title-appears` | desktop ×2 | both attached to a new session | send the first message | a generated title appears in BOTH surfaces without refresh | auxiliary task fires after the reply commits; title frame fans out |
| `title-fallback` | desktop | authed, titling made to fail | send the first message | a readable fallback title, never "Untitled" | failure logged with a reason |
| `sessions-list` | desktop | authed, ≥2 sessions | open the drawer | both listed, newest first, no error banner | `GET /api/v1/sessions` 200, scoped to the principal |
| `session-resume` | desktop | authed | open an older session | full history renders; a new turn continues it | replay projection == live projection |
| `two-surfaces-live` | desktop ×2 | same session | send from A | **B shows the same reply streaming**, no refresh | one `react-loop.start`; one seq space; both cursors advance |
| `two-surfaces-either-speaks` | desktop ×2 | same session | send from B while A's turn is mid-flight | folded into the running turn, one reply | steer path; NOT a second turn |
| `join-midturn` | desktop ×2 | A streaming; B attaches now | B opens the session | B renders coherently, no re-spoken audio | snapshot from store + cursor at head |
| `permission-either-answers` | desktop ×2 | same session | trigger a confirm tool from A, answer on B | resolves once; A's dialog closes with the outcome | one `pdp.confirm-resolved`; a second answer is refused |
| `stop-from-either` | desktop ×2 | A's turn streaming | press Stop on B | the turn stops for both | one abort; `cutoff="interrupt"` |
| `last-one-out` | desktop ×2 | same session | close A, keep B, send from B | B keeps working normally | runtime NOT disposed while a subscriber remains |
| `retention-holds-work` | desktop | delegated task running | close every surface | on reattach the result is there | `SessionRetention` reports the background task as the holding reason; no dispose |
| `retention-drops-idle` | desktop | idle session, no work | close every surface, wait past the window | reattach still shows full history | dispose logged with no retention reasons; rehydrate from store |
| `unknown-session-refused` | desktop | authed | present a sessionId the server never minted | no session opens; a clean error | rejected, not silently created |
| `cross-user-refused` | desktop | Ada authed | present Grace's sessionId | no data from Grace | refusal logged; membership lookup failed |
| `reload-convergence` | desktop ×2 | shared session with tool calls | reload both | identical feeds | `render(replay) == render(live)` |

`cross-user-refused` and `unknown-session-refused` are the security rows and must be **driven**, not reasoned about.

---

## 11. Decisions, for the record

| Decision | Choice | Why |
|---|---|---|
| Who shares a session | One user, many surfaces | Keeps the per-user DB and the capability chain intact |
| Fresh surface default | Always a new session | Predictable; joining is explicit |
| sessionId shape | Server-minted, opaque | Removes the id-as-authorization convention |
| Unknown id | Rejected | A client must never present an id the server did not mint |
| Mint timing | On first message | No ghost sessions from opened tabs |
| Audio fan-out | All subscribers; client decides | Avoids inventing a routing policy nobody asked for |
| Retention | 15 min, derived predicate | Reuses one lifecycle; work in flight can never be dropped |
| Titling | Auxiliary-task handler, off the critical path | Reusable seam; never delays a reply |
| Existing partitions | Left as-is | The owner's real history lives there |
