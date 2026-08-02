# Session model redesign — server-minted sessions, surfaces as observers

**Status:** design approved 2026-08-02; revised the same day after an adversarial review against the code. Supersedes the per-surface conversation model on `feature/native-orchestrator`.

**Goal:** A session becomes a first-class, server-owned resource that a user can create, list and re-open — and any number of that user's surfaces can attach to one live session at once, all seeing the same stream, each able to act only within the rights its attachment was granted.

> **Revision note (2026-08-02).** The first draft made four claims about the current gateway that are false, and assumed two mechanisms that do not exist. All are corrected below and called out inline as **[corrected]** so a reader who saw the first draft can find them. The review that produced them cited file paths that do not exist in this repo, so **every** finding here was re-verified against the source before being accepted.

---

## 1. Why this is a redesign and not a fix

The current model derives a conversation id from the surface: `c::<userId>::<surfaceId>` (`session-handlers/ws-session-configure.ts:355`). One surface therefore has exactly one conversation, forever, and "+ new chat" has nothing to hand back because **there is no allocator**.

That shape was correct under Hermes. Hermes owned the agent runtime and the session state, so the gateway could only key a conversation by something it held itself — the surface. The gateway now owns the loop, the store and the buffer, so the constraint that produced this design is gone. Keeping it costs two live defects:

- **D15** — "+ new chat" does not start a new chat. On web it does not even clear the mirror. Measured on the wire: `stream-start messageCount` 6→8 across the click, and the model recited a pre-click marker verbatim when denied an escape hatch. It is a **context leak**, not a cosmetic bug.
- **No past-chat list.** There is no `/api/v1/sessions` handler; both SDKs call it, and mobile's failure branch is `replaceMirror(emptyList())`.

---

## 2. The model

**The session is the unit of state. A surface is an observer with rights.**

A session owns a **session journal**: one monotonic seq space carrying the frames that belong to the conversation — text deltas, feed items, tool tiles, permission prompts, audio. A surface holds a **cursor** into it.

### 2.1 Two lanes, not one **[corrected]**

The first draft said *every* outbound frame shares one seq space. That is wrong and would leak one connection's private frames to another surface. There are two lanes:

| Lane | Owner | Contents | Cursor |
|---|---|---|---|
| **Session** | the session | turn lifecycle, text deltas, feed items, tool updates, permission prompts and resolutions, audio, title updates | shared; each subscriber has its own position |
| **Connection** | the socket | auth results, pong, resume coordination, session-ready | none; connection-private, never journaled to the session |

The implementation must **enumerate** which frame types enter the session lane. A frame type added later with no explicit lane assignment is a contract break, not a default.

### 2.2 What the model buys

- **Reconnect stops being special.** "Send me everything after seq N" is one operation whether a surface dropped for 200 ms or is a phone joining the laptop's conversation.
- **Input needs no new concurrency model** for *text*. At most one turn runs per session; a message landing mid-turn *steers* it, one landing after the final answer starts a back-to-back turn (2.0 spec §5). Voice is different — see §8.3.
- **Fan-out is one seq space, not N.** A frame is allocated once; every cursor reads the same bytes.

### 2.3 The journal is already surface-scoped **[corrected]**

The first draft said `FrameJournal` belongs to a *connection*. It does not: `ReplayRegistry` keys it `${userId}::${surfaceId}` and deliberately outlives the socket, with a lease model so a superseded socket cannot mutate the live entry.

This helps. The retention machinery, the lease discipline and the disconnect-survival property already exist — moving from surface scope to session scope is a smaller step than the first draft implied, and the lease pattern is the precedent for the subscriber set (§5.3).

### 2.4 What does NOT come for free **[corrected]**

The first draft claimed permission prompts, Stop and steer all fall out of the model. Steer does. The other two are real work:

- **`PermissionBroker` is explicitly one per connection** — *"One broker per WS connection, held on `ws.data.permissions`"* (`runtime/permission-broker.ts:14`). Fanning a prompt to every eligible surface and accepting the first answer means relocating it to session scope, keeping its existing guarantees: a second answer must be **refused**, not re-decided, and its timeout must survive a subscriber leaving mid-prompt.
- **Stop from any surface** requires the `interrupt` right (§3.4), not merely an attachment.

---

## 3. Identity and security

### 3.1 What already holds

- One SQLite file per user. `openSessionStore(cap)` derives the path from a **capability**, never from the request.
- Capabilities are minted in one place — `AccessManager.grant`, from an authenticated `UserPrincipal` — and frozen at mint.
- One call site of `openSessionStore` in the gateway.

So `session_id` is a column *inside the caller's own database*, and **a forged sessionId can only address a partition in the caller's own file** — the request never selects which database opens. That property is preserved by construction.

### 3.2 The L2 chain has a hole, and this wave closes it **[corrected]**

`CLAUDE.md` states: *"L2 resource handles — `SessionRuntime`, `FileScope`, `ToolBroker`, `ProviderClient` — hold capabilities by value, never an ambient 'current user'."* Verified against the source, two parts of that are not true today:

- **`openSessionStore` never checks `cap.resource`** (`store/session-store.ts:85-89`) — only `capabilityCoversPath`. A `file-scope` capability has an identical `rootPath`, so it opens the session store fine. Confused deputy.
- **`ToolBroker` takes a `UserPrincipal`, not a capability** (`tools/tool-broker.ts:147`).

This is the **third instance on this branch** of documentation asserting a control that is not wired, after `delegateTask`'s *"a blanket PDP confirm here would double-prompt"* and `mcp-policy.yaml`'s claimed inbound injection scan. The pattern is now a known failure mode of this codebase and should be treated as one.

**Both are closed in this wave** (owner's decision), because the session design rests on this chain: declaring `session` a capability-scoped resource means nothing if resource class is unchecked.

### 3.3 sessionId

**Server-minted, opaque, unguessable.** No structure, no embedded userId.

- **CSPRNG, ≥128 bits** — mandated, not implied. The existing connection-session allocator uses `Math.random().toString(36)` (`auth/session-manager.ts:61`); adequate for a connection id, not for a durable resource id. Do not reuse that pattern.
- Canonical length and charset, validated on input; collision-safe insertion.
- **Never derived** from userId, surfaceId or a timestamp.

### 3.4 Attachment carries rights, not just presence

An attachment is granted a set of verbs. This replaces the first draft's "attached ⇒ full authority", which would let any surface a user owns approve a privileged tool call — an ESP32 cube in a hallway is not the same trust as the owner's phone.

| Verb | Grants |
|---|---|
| `observe` | receive session-lane frames |
| `submit` | send input into the session |
| `interrupt` | abort the running turn |
| `approve` | answer a permission prompt |

Every command is mediated against the attachment's retained rights. **Rights come from server-side policy keyed on the authenticated principal and the surface's registered identity — never from client-advertised `clientType` or capabilities**, which are self-declared and stored as-is today (`ws-session-configure.ts:122`).

Default for this wave: a user's own interactive surfaces (web, mobile) get all four. The point is that the *mechanism* exists so a restricted surface is a policy entry rather than a redesign.

### 3.5 Addressing

1. **Membership lookup replaces the prefix check.** Attachment asks *"does this session exist in the caller's own store"* — which is stronger than a string prefix, because the store queried is chosen by capability.
2. **An unknown sessionId is REJECTED**, not silently created. A client must never present an id the server did not mint. This also closes junk-partition spam.
3. **The sessions route never accepts a userId.** It reads the principal.
4. **Legacy ids are addressable, not privileged** **[corrected]**. Existing `c::<userId>::<surfaceId>` partitions remain reachable through the same membership lookup — they are rows in the caller's own store like any other. The prefix parse is **retired**: no code path may infer ownership from an id's shape. New sessions get §3.3 ids; both shapes coexist and are handled identically.

### 3.6 Threat notes

- **Cross-user read via forged id** — blocked structurally *and* by membership lookup. Must be an E2E row, not an assertion.
- **Cross-surface leak within one user** — the risk this design introduces. Attachment must be an explicit act naming a session id, never inferred.
- **Privileged approval from a low-trust surface** — closed by §3.4.
- **Stale socket acting on a live session** — the `ReplayRegistry` lease model is the precedent; the subscriber set needs the same ownership discipline.
- **Token expiry mid-attachment** — a principal is frozen at auth while tokens carry expiry. An attachment must not outlive its credential: carry expiry into connection state and revalidate before privileged commands.

---

## 4. Storage

### 4.1 A session metadata table is required **[corrected]**

The first draft assumed titles could be stored and renamed. The store has **one table, `entries`, append-only**, with a deliberately frozen baseline DDL (`store/schema.ts`). There is nowhere to put a title, and no update path.

Add a `sessions` table via the migration ladder — **never by editing `STORE_DDL`**, whose header explains why: every per-user database already exists, so a column added to the baseline reaches none of them, and fresh-database tests stay green while real users fail. That blind spot is what deleted the `pending_id` round trip (D14).

Fields: session id, created/updated timestamps, title, **title provenance** (`generated | user`), and a **version for compare-and-set** (§6).

### 4.2 Lifecycle

- **Fresh surface starts fresh.** A surface with no stored sessionId begins a new session; joining an existing one is always explicit.
- **Mint on first message.** Connecting yields an empty draft; the id is minted and persisted when the user sends something. Ten opened tabs leave no trace.
- **Mint atomically.** The session row, the first entry and the id acknowledgement commit together, so a crash cannot leave a persisted message under an id the client never learned.
- **Retention: 15 minutes after the session stops being retained** (§5), then drop. The conversation is durable; dropping loses only the replay tail.

---

## 5. `SessionRetention` — derived, never a flag

A stored `workInFlight` boolean would be set and cleared at several sites and eventually leak one, holding a session resident forever or dropping one mid-work. Retention is **derived from observable state on every evaluation**:

```
retained  =  subscribers > 0
          || a turn is in flight (ReAct iterating or streaming)
          || any foreground tool call is awaiting its result
          || any background task is registered and unfinished
          || a permission prompt is outstanding
          || an auxiliary task (§6) has not returned
```

**It returns reasons, not just a boolean, and logs them.** Otherwise "why is this session still resident" is unanswerable.

### 5.1 Invariants to pin

- the timer starts **only** on the transition to *not retained*;
- any input becoming true again **cancels** a running timer rather than racing it;
- **disposal is generation-stamped and re-checks retention under the same lock immediately before disposing**, so a timer that fired while a surface was attaching cannot dispose a live session.

### 5.2 Why the clause is mandatory

Today expiry means "the client refetches" — cheap. Under this design expiry **also disposes the runtime**. Without the derivation, a delegated task running with nobody attached would be killed at the 15-minute mark: work the user explicitly approved, destroyed because they closed a laptop.

### 5.3 Config

Reuse the existing timer rather than adding a second lifecycle — `replay-registry.ts` argues exactly this in its header.

- `session.replay_journal_retention_ms: 300000` → **900000 (15 min)**.
- **Rename it**: it now governs session lifetime, not only journal bytes. A key that under-describes its job is how the dead `session.idle_timeout_ms` survived with zero readers. `operator-config-migrator.ts` carries existing installs.
- `session.replay_journal_max_bytes` (16 MB) becomes **per session**. Re-tune; log evictions.

---

## 6. Titling, as an auxiliary-task handler

Deliberately **not** a titler: one encapsulated seam taking a prompt template, a truncated conversation slice and a small output budget, returning structured output. Titles are its first user; tags, follow-up suggestions and summarisation are obvious next ones.

This follows [Open WebUI](https://docs.openwebui.com/features/workspace/prompts/), whose "task model" seam drives title generation, tag generation and follow-up suggestions from one place, with a `TITLE_GENERATION_PROMPT_TEMPLATE`, JSON output, a 3–5 word target, and input truncation so a pasted document cannot blow the prompt.

- Fires after the first assistant reply **commits**. Never blocks it.
- Small output cap, reasoning effort off — what wave 1's `reasoning_effort` knob is for.
- The result lands as a **session-lane frame**, so every attached surface renames live.
- **Compare-and-set against the version in §4.1, and refuse to overwrite `provenance = user`.** A rename racing a generated title is a real ordering, not a theoretical one: the generator fires seconds after the first reply, exactly when a user might rename.
- On failure, fall back to a truncated first message. Never permanently "Untitled".
- Prompt templates live in `.md` files with an operator-override loader.

---

## 7. Attaching

A joining surface receives, atomically:

1. the **committed feed** from the store;
2. a **session-state snapshot** — the active turn id, text accumulated so far, in-flight tool state, open permission prompts, and current audio state;
3. a cursor placed at the journal head.

### 7.1 The linearization point **[corrected]**

The first draft said "send the feed, then place the cursor at head". A frame emitted between those two steps is **lost silently**. Attach must capture `{store watermark, journal seq}` atomically, register the subscriber, buffer concurrent emissions, and drain them after the snapshot is sent.

### 7.2 Why a state snapshot, not just the feed

Clients build in-flight UI from *transient prerequisite* frames — `turn.started` before deltas, audio-start before audio, a prompt before its resolution. A surface attaching mid-turn that receives only committed entries plus a head cursor gets deltas for a turn it never saw start, and audio for a stream it never saw begin.

It must **not** replay historical audio bytes — that would re-speak what the user already heard. Replay-from-cursor stays for reconnects, where the client presents a seq it genuinely reached.

`render(replay) == render(live)` remains a protocol-contract invariant and must hold for a joiner as for a reconnecter.

---

## 8. Risks and open decisions

### 8.1 Slow subscriber vs a bounded shared journal

`ws-send.ts` ignores transport backpressure (`ws.send()` return value unchecked) and the journal evicts oldest. With a per-connection journal a slow client only hurt itself; with a shared one its prerequisite frames can be evicted while it lags. Define maximum lag, and what happens past it — forced re-snapshot or disconnect — rather than discovering it as silent loss.

### 8.2 Buffer memory

The journal now holds audio (~50 frames/s) for a *session* several devices may watch for an hour. Cap and window need re-tuning; evictions logged, not silent.

### 8.3 Concurrent voice input — needs a decision

Text has a concurrency model (steer). Voice does not: STT onset calls `bargeIn` on the ambient runtime, and stored entries carry **no source-surface field**. Two people speaking to two surfaces on one session is undefined behaviour. Decide: arbitrate (first onset wins, others rejected), queue, or reject the second — and whether entries gain a source-surface column. **Not** deferred silently; if this wave does not solve it, it must be written down as a known hole.

### 8.4 Command binding

`text.input`, `interrupt` and permission responses carry no session id, and binary audio uses the ambient connection runtime. On a session switch, in-flight commands can land on the wrong session. Commands need session binding and an attachment generation; stale-generation traffic is dropped and STT state reset.

### 8.5 The wire is frozen

Distinguishing "the user pressed +" from "the app launched" needs a new field or a new frame, with both SDKs moving together. Mobile fires `session.new` on **every launch**, twice per launch; minting per `session.new` would fork a conversation per app open and destroy `reload-convergence` and `restart-persistence`.

---

## 9. Out of scope

- **Multi-user shared sessions.** A session belongs to one user.
- **Audio routing / designated speaker.** All attached surfaces receive frames; clients decide. Today they all play audio, which is acceptable.
- **Presence and typing indicators.**
- **Durable turn state and tool idempotency.** A crash between `tool_call` and `tool_result` can reissue a side effect. Real, and its own project — filed in `docs/native-todo.md`.
- **Symlink-safe capability paths.** `capabilityCoversPath` is lexical (`path.resolve` + prefix), so a planted symlink could redirect the DB path. Needs an attacker who can already write in the user's tree — filed, not blocking.
- **D16 delegated-task silence** and the **untrusted-content boundary** — tracked separately.

---

## 10. E2E matrix

Local dev stack only (`http://localhost:5173`; never `mini0.lan` / `sentient.dev32.io`). Log in as **Ada**, PIN `1234`. Tool calls are reads or temp-writes only — no `ha_call_service`, no `ma_playback` / `ma_play_media` / `ma_volume`.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `newchat-mints` | desktop | authed, non-empty feed | press "+", then send | feed clears; model has NO prior context | new id minted on first message; `stream-start messageCount` counts only the fresh turn |
| `newchat-not-on-launch` | mobile | authed | launch twice | no new session appears | `session.new` resolves to the existing session both times |
| `draft-leaves-no-ghost` | desktop | authed | open a tab, close without typing | history unchanged | no session persisted |
| `title-appears` | desktop ×2 | both attached, new session | send the first message | a title appears in BOTH without refresh | auxiliary task fires after commit; title frame on the session lane |
| `title-rename-wins` | desktop | new session | rename before the generator returns | the user's title survives | CAS refuses the generated write; `provenance=user` |
| `title-fallback` | desktop | titling forced to fail | send the first message | a readable fallback, never "Untitled" | failure logged with a reason |
| `sessions-list` | desktop | ≥2 sessions | open the drawer | both listed, newest first, no error | 200, scoped to the principal |
| `session-resume` | desktop | authed | open an older session | full history; a new turn continues it | replay projection == live projection |
| `legacy-session-opens` | desktop | a pre-existing `c::<userId>::<surfaceId>` partition | open it from the list | full history renders | membership lookup succeeds; no prefix parse |
| `two-surfaces-live` | desktop ×2 | same session | send from A | **B shows the same reply streaming** | one `react-loop.start`; both cursors advance |
| `two-surfaces-either-speaks` | desktop ×2 | same session | send from B mid-turn on A | folded into the running turn | steer path; NOT a second turn |
| `join-midturn` | desktop ×2 | A streaming; B attaches | B opens the session | B renders coherently, no re-spoken audio | snapshot incl. active turn; cursor at head |
| `join-race` | desktop ×2 | A streaming fast | B attaches during a delta burst | B misses no frame and shows no duplicate | atomic watermark + drain |
| `permission-either-answers` | desktop ×2 | same session | prompt from A, answer on B | resolves once; A's dialog closes with the outcome | one resolution; second answer refused |
| `permission-right-enforced` | desktop ×2 | B attached WITHOUT `approve` | answer the prompt from B | refused | denied against the attachment's rights, logged |
| `stop-from-either` | desktop ×2 | A's turn streaming | Stop on B | stops for both | one abort; `cutoff="interrupt"` |
| `connection-lane-private` | desktop ×2 | same session | force a resume on A | B receives NO auth/pong/resume frame | connection lane never journaled |
| `last-one-out` | desktop ×2 | same session | close A, keep B | B keeps working | runtime NOT disposed |
| `retention-holds-work` | desktop | delegated task running | close every surface | on reattach the result is there | retention names the background task; no dispose |
| `retention-drops-idle` | desktop | idle session | close all, wait past the window | reattach shows full history | dispose logged with no reasons; rehydrate |
| `unknown-session-refused` | desktop | authed | present an id the server never minted | no session opens; clean error | rejected, not created |
| `cross-user-refused` | desktop | Ada authed | present Grace's sessionId | no data from Grace | refusal logged; membership lookup failed |
| `wrong-capability-refused` | — | unit | open the session store with a `file-scope` capability | throws | resource-class check fires |
| `reload-convergence` | desktop ×2 | shared session with tool calls | reload both | identical feeds | `render(replay) == render(live)` |

`cross-user-refused`, `unknown-session-refused`, `permission-right-enforced` and `wrong-capability-refused` are the security rows and must be **driven**, not reasoned about.

---

## 11. Decisions, for the record

| Decision | Choice | Why |
|---|---|---|
| Who shares a session | One user, many surfaces | Keeps the per-user DB and the capability chain intact |
| Fresh surface default | Always a new session | Predictable; joining is explicit |
| sessionId shape | Server-minted, opaque, CSPRNG ≥128 bits | Removes id-as-authorization; prevents enumeration |
| Unknown id | Rejected | A client must never present an id the server did not mint |
| Legacy ids | Addressable, not privileged | The owner's real history lives there; no migration |
| Mint timing | On first message, atomically | No ghost sessions; no orphaned first message |
| Attachment | Carries verbs (`observe`/`submit`/`interrupt`/`approve`) | Not every surface a user owns deserves to approve a tool call |
| Frame lanes | Session vs connection, enumerated | A connection's auth frame must never reach another surface |
| Permission broker | Relocated to session scope | It is per-connection today; fan-out is real work, not free |
| Audio fan-out | All subscribers; client decides | Avoids inventing a routing policy nobody asked for |
| Retention | 15 min, derived predicate, generation-stamped | One lifecycle; work in flight can never be dropped |
| Titling | Auxiliary-task seam, CAS against user rename | Reusable; never delays a reply; never overwrites a person |
| L2 capability gap | Fixed in this wave | Declaring `session` capability-scoped is empty if resource class is unchecked |
