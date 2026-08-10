# Wire Contract (`@sentient/protocol`)

The authoritative gateway ↔ client (web / mobile / cube) wire contract. The
zod schemas in `src/` are the source of truth; this file documents the parts a
reader can't infer at a glance. Keep it in lockstep with `src/messages.ts` and
`src/sessions.ts`.

## Transport boundary — WS vs REST

A standing architectural rule, not just for one feature:

- **WebSocket** carries the **live chat session ONLY**: mic audio in, TTS audio
  out, the live conversation stream (`conversation.entry`, `turn.*`,
  `permission.*`, `delegation.progress`), `ping`/`pong`, `interrupt`, and the
  resume handshake. *Everything on the WS push channel is seq-stamped and
  replay-buffered.*
- **REST** carries everything client-driven and stateless: session list,
  conversation history (paginated `getMessages`), search, rename, delete,
  preferences/settings. The client re-issues on demand; no resume/buffer
  semantics. Routes live under `/api/v1/sessions` (thin passthroughs over the
  Hermes dashboard sidecar; auth reuses the PASETO / shared-token model).

The WS query RPCs that previously did this (`SessionsConnector.list`,
`session.switch` → `conversation.snapshot`, preferences) were **removed** from
the WS schema. A lightweight WS `conversation.activate` control replaced
`session.switch`: it focuses the live stream + replay buffer and carries **no
history payload** — the client loads history via REST.

## Sequenced push frames — `seq` / `epoch`

Every gateway → client JSON push frame optionally carries two top-level fields,
stamped by the gateway's `FrameSequencer` before send:

- **`seq`** — a monotonic per-device-session frame counter within the current
  epoch. Doubles as the resume cursor (replay from `lastSeq + 1`) and the client
  mirror's ordering key.
- **`epoch`** — a session-scoped counter that increments on each reconnect. Lets
  the client tell a true seq gap from a reconnect restart.

Both are non-negative integers; **absence means the frame pre-dates sequencing**
(older gateway / pre-sequencing frame). The client first learns the current
`epoch` from `auth.ok` / `session.ready`, and again from the `stream.resumed`
reply after a reconnect.

## Binary frame header

Binary audio frames (gateway → client) carry `seq` in a fixed 9-byte header
prepended to the payload:

```
┌──────────────────────────────┬────────────┬──────────────────────┐
│  8 bytes (big-endian u64)    │  1 byte    │  N bytes             │
│  seq (monotonic counter)     │  type      │  payload             │
└──────────────────────────────┴────────────┴──────────────────────┘

  type 0x01 = audio (PCM / Opus payload)
```

`epoch` is **NOT** in the binary header — it travels on JSON frames only. The
client peels the 9-byte header, reads `seq`, dedupes by `seq`, and hands the
payload to the audio path.

## `session.configure` — now resume-aware

`session.configure` is the first client → gateway frame after auth. Required
fields relevant to resilience:

- **`deviceId`** (REQUIRED) — a stable per-device identifier the client supplies
  on **every** connection. The gateway keys the per-device replay buffer on it,
  so a reconnect reuses the same buffer. A fresh connect gets a fresh buffer.
- **`resume`** (OPTIONAL) — `{ epoch, lastSeq }`. Present only on a reconnect
  with a non-zero cursor. The resume request is folded **into**
  `session.configure` (there is **no** separate `stream.resume` frame), so the
  gateway's resume decision is a synchronous read off the one parsed configure
  message — no same-tick frame-ordering race.

## `stream.resumed` — resume reply

Gateway → client, sent after processing a `session.configure` that carried a
`resume` object. Its own frame (not folded into `session.ready`):

```
{ type: "stream.resumed", recovered: boolean, epoch: number,
  fromSeq?: number, toSeq?: number }
```

- `recovered: true` — the per-device buffer held frames in `[fromSeq, toSeq]`
  within the requested epoch; the gateway replays them (seq order) then goes
  live. The client applies them idempotently (dedupe by `seq`).
- `recovered: false` — epoch rolled over (gateway restart) or the buffer was
  empty / too old. The client treats it as a clean reconnect and **REST-refetches**
  the conversation history (no WS snapshot).

## `entryId` on committed entries

Each committed `conversation.entry` (live WS) and each REST history entry carries
a stable `entryId` — the device chat mirror's per-path upsert key. **Live and
REST use different namespaces** (live = gateway UUID; REST = `${conversationId}:${index}`),
so cross-path reconcile is **replace-on-REST-reload, not merge**: live frames
write-through by their live `entryId`; a REST reload wipes + repopulates the
conversation. Within each path `entryId` dedups; the resume replay dedupes by
`seq`.

## `replyId` — the live-bubble join key

**`replyId` is the bubble.** `turnId` is not, and a client that uses it as one is
broken in a way that only shows up mid-reveal.

A ReAct turn narrates, calls a tool, narrates again, then answers — several
stretches of text under ONE `turnId` that are ONE bubble that grew. So the
gateway folds them: a whole reply commits as a **single `conversation.entry`**
whose `entryId` **is** its `replyId`. `turnId` alone cannot express the one
exception either: a message the person sends **mid-turn** is drawn as its own row
between two stretches, so everything after it starts a NEW reply. The gateway
**rotates `replyId` inside one `turnId`** at that point, which means **one turn
can commit two assistant rows sharing a turnId**.

Where it rides:

- **`turn.text.delta`** — `replyId` (optional) names the bubble each delta
  belongs to. Server-minted in `session-runtime.ts`; never derived client-side.
- **`conversation.entry`** — `replyId` (optional) sits on the FRAME beside
  `turnId`, and the gateway also stamps it **on the assistant item itself**, so
  `conversation.snapshot` and REST history carry it with no frame to read.
- **`turn.started` / `turn.completed` / `turn.aborted`** — turn-scoped, no
  `replyId`. A turn's completion clears **every** open bubble of that turn.

The client rule, both SDKs:

1. Key the in-flight buffer by `replyId`, **not** by turn. `turn.started` seeds a
   turn-keyed placeholder (there is no reply id yet, and the bubble must appear
   before the first token); the first stamped delta **adopts that placeholder in
   place while it is still empty**. Every `turn.text.delta` on the wire — the
   live ones and the one an attaching window is replayed — must therefore be
   stamped, or the placeholder fills unadopted and a second buffer opens beside
   it: two live bubbles for one reply.
2. While a bubble reveals, suppress its committed twin **by `replyId` alone**.
   There is no turn fallback: a turn-keyed match hides BOTH rows of a rotated
   turn, and the first stretch of the reply vanishes for the length of the
   reveal. (`ObserveChatUseCase.kt` / `cycle-helpers.ts`.)
3. Render-key the live bubble by `replyId` too — two open bubbles under one
   `turnId` is a real state, and a turn-keyed render id makes them collide.

`replyId` is absent on entries with no bubble (a user row, an out-of-band
activate entry) and on anything written before the store had the column; a
client falls back to per-turn grouping there, which is correct for exactly those
rows.

`turnId` on the `conversation.entry` frame remains what it always was — the
gateway-owned id of the turn that produced the entry, **stripped from the item**
(the item is a UI-display projection) and present on the frame for assistant
entries. It is turn METADATA (which turn is live, what Stop cancels), not a
bubble key. Absent on user-echo / out-of-band entries and on REST history.
**Clients read both off the wire — they never derive either** (no text-match, no
ts-window, no position).

## The 2.0 frame inventory

The native orchestrator (spec §7) replaced the Hermes-cycle vocabulary
wholesale. `cycle.*`, `message.delta`/`message.done`, `connector.audio.*`,
`task.update`, `tool.confirm_request`, and `cognition.status` are **deleted** —
not deprecated. Nothing emits or parses them.

`turn.tool.update` — a 2.0 frame in its own right — is **deleted** too, along
with the `kind: "tool"` conversation feed item. Live tool activity is one
full-state `tasklist.state` frame; the gateway owns which rows exist and how
long each lives, so no client derives tile lifetime or bubble anchoring any
more. Tool calls stay in the store forever for the MODEL projection; they are
simply not client-facing.

### Gateway → client

| Frame | Payload | Notes |
|---|---|---|
| `turn.started` | `turnId`, `trigger` | `trigger` is `user` or `background-completion`. Clients label the bubble from it; they never infer it. Seeds an EMPTY turn-keyed placeholder bubble — see the `replyId` section. |
| `turn.text.delta` | `turnId`, `text`, `replyId?` | `turnId` is **required**. Its absence in the Plan-2 interim frame made §7.2's back-to-back turns unroutable. `replyId` is the bubble key — **including on the replay a mid-turn joiner is sent**, or that window opens two bubbles for one reply. |
| `turn.completed` | `turnId` | Clears **every** open bubble of the turn, not just the turn-keyed one. |
| `turn.aborted` | `turnId`, `cutoff` | `cutoff` is `interrupt` or `barge-in`. Same all-bubbles rule as `turn.completed`. |
| `conversation.entry` | `item`, `turnId?`, `replyId?` | ONE committed entry per reply — the gateway folds every stretch of a ReAct turn's text into it. `entryId == replyId` for an assistant entry; both ids also ride the frame. |
| `conversation.snapshot` | `items[]` | Full replace of the client's committed mirror, never a merge. Carries `replyId` on assistant items (there is no frame sidecar to read), which is what makes `render(replay) == render(live)` hold. Also sent EMPTY by the draft handshake — that empty frame is the only thing that clears a client's mirror on "+". |
| `tasklist.state` | `turnId` (nullable), `items[]` of `{ id, toolName, kind, status, argsPreview, startedAtMs, endedAtMs? }` | The composer task strip — never a chat bubble. FULL STATE, last-one-wins. `id` is the `toolCallId` for a foreground row, the `taskId` for a background one. `turnId` is null when only background rows outlive their turn. `argsPreview` is USER CONTENT: renderable, never loggable. Re-sent to a joining or switching window (`ws-session-configure.ts`, `ws-conversation-activate.ts`) but **not** on the draft / fresh-mint path, so the CLIENT clears the strip at that boundary. |
| `turn.audio.start` | `turnId`, `encoding`, `sampleRate` | Does **not** stop a previous turn's audio. |
| `turn.audio.done` | `turnId` | |
| `permission.request` | `requestId`, `toolCallId`, `toolName`, `args`, `description`, `expiresAtMs` | Carries real argument VALUES — authorization is value-aware (§2.2). |
| `permission.resolved` | `requestId`, `outcome` | `allowed` / `denied` / `timeout`. Fires on every resolution path so a dialog is never orphaned. |
| `delegation.progress` | `taskId`, `turnId`, `agent`, `status`, `note?` | `turnId` is the turn that **dispatched** the task, not necessarily the live one. |
| `playback.stop` | `turnId`, `reason` | The ONLY frame that may flush the client audio queue. |

### Client → gateway

`permission.response` `{ requestId, approved }` replaced `tool.confirm`. Clients
answer by `requestId`, so a late answer to a superseded prompt is trivially
ignorable.

## Audio queueing — a new turnId NEVER flushes

Because the gateway never interrupts its own TTS (spec §4.6), a follow-up turn's
audio arrives while the previous turn's audio may still be playing. Clients
**queue by `turnId`; they do not replace**. The queue is flushed *only* on
`playback.stop` (barge-in or interrupt — both user-initiated). A new
`turn.audio.start` with a different `turnId` must append, never fade or cancel.

Binary audio frames carry **no `turnId`** — the client attributes bytes to the
most recent `turn.audio.start`. The gateway therefore MUST bracket each turn's
audio (`start` → frames → `done`) before beginning the next turn's.

Text does **not** overlap the way audio does: one turn runs at a time per
session (§4.5), so a follow-up turn starts only after the previous one commits.
"Two bubbles" means one committed bubble plus one live bubble — never two
simultaneously streaming.

## Capability gate

The binary header + resume behaviour is advertised via the `stream.resume`
capability in `session.configure.capabilities.supports`. Clients that don't
advertise it get the legacy untagged-binary behaviour — protects older clients
and the not-yet-live ESP32 cube; web/mobile opt in independently.

## See also

Design rationale (build-not-buy, memory math, two-timer model):
`docs/superpowers/specs/2026-06-09-ws-resilience-and-chat-mirror-design.md`.
