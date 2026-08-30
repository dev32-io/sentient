# Wire Contract (`@sentient/protocol`)

The zod schemas in `src/messages.ts`, `src/sessions.ts`, and
`src/conversation.ts` are authoritative for the gateway ↔ client contract.
This document records sequencing, lifecycle, and rendering rules that are not
obvious from individual schemas.

## Transport boundary

The WebSocket at `/api/v1/ws` carries the live session:

- authentication and `session.configure`;
- text/mic input and TTS audio;
- `turn.*`, committed conversation updates, task state, permissions, and
  delegation progress;
- session draft/create/activate controls;
- interrupt, ping/pong, command refusal, and resume coordination.

The implemented sessions REST surface is intentionally small:

- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:id/messages`

`conversation.activate` changes the live WebSocket attachment and produces
`session.switched`; the client then loads committed history through the messages
route. Search, rename, delete, and preferences are not part of this sessions
REST handler. Do not infer endpoints from event schema names.

## Durable session, connection, and draft identities

A durable `sessionId` is server-minted and opaque. One `SessionRuntime` and one
append-only store partition serve that session; multiple connections can attach
as windows onto it.

A WebSocket connection has a separate connection id exposed as
`session.ready.sessionId`. It dies with that socket and is not a conversation
id.

A connection with no durable session receives `session.draft { draftKey }`.
The draft creates no session row or runtime. Its first user message mints the
durable session and produces `session.created`. Re-presenting the draft key in
`session.configure.conversationId` preserves mint idempotency across reconnect.

## `session.configure`

This is the first client frame after authentication. Relevant fields are:

- `clientType` — required: `webui`, `cube`, or `mobile`.
- `deviceId` — required stable device identifier.
- `surfaceId` — optional window/app-instance identifier; defaults to
  `deviceId`. It scopes client pending-message dedupe and diagnostics, not
  authorization, runtime ownership, or the replay journal.
- `capabilities.supports` — client capability strings.
- `conversationId` — optional durable session id or draft key currently shown.
  A durable id is accepted only if it exists in the authenticated caller's own
  store.
- `resume` — optional `{ epoch, lastSeq }`; there is no separate
  `stream.resume` client frame.

After a successful durable-session attach, the gateway sends
`session.attached { sessionId, generation }`. Current clients stamp that pair on
bound commands (`text.input`, `audio.start`, `audio.end`, `interrupt`, and
`permission.response`). Both fields are optional so a draft's first message and
older clients can bind implicitly to the connection's current attachment; a
half-present or stale pair is answered explicitly with `command.rejected`, never
silently dropped.

## Two outbound lanes

Outbound frames belong to one of two delivery lanes:

| Lane | Owner | Sequenced/journaled | Delivery |
|---|---|---|---|
| Session | durable session | Yes | Identical bytes fan out to all attached windows |
| Connection | WebSocket | No | Only the socket the frame answers |

Session-lane frames include turn lifecycle/text/audio brackets,
`conversation.entry`, `tasklist.state`, permissions, delegation progress,
`playback.stop`, and `session.title`.

Connection-lane frames include auth, `session.ready`, `session.attached`,
`command.rejected`, resume coordination, draft/create/switch answers, errors,
pong, and `conversation.snapshot`. A snapshot contains conversation content but
is an attach answer that replaces one window's mirror; it must not be fanned out
or replayed to peers.

A window joining an already active turn can also receive unsequenced,
unjournaled reconstruction frames for that in-flight state. Therefore `seq` and
`epoch` are optional in the schemas: absence means the frame is outside the
session journal, not that it is invalid.

## Session journal, `seq`, and `epoch`

Each durable session has one byte-bounded journal and one monotonic `seq` space.
A session frame is validated, allocated, encoded, and journaled once, then the
same bytes are delivered to every attached window. Each window keeps its own
cursor.

- `seq` — highest-order key within that journal, starting at 1. JSON session
  frames carry it at the top level; binary output carries it in the header.
- `epoch` — identifies the journal instance. A fresh journal receives a new,
  never-reused process-global epoch. Reconnecting to a retained journal keeps
  its epoch; reconnect itself does not increment it.

The journal evicts oldest frames at its byte cap. Resume succeeds only when the
requested epoch still names the retained journal and all frames after
`lastSeq` remain contiguous.

### `stream.resumed`

When `session.configure` carries `resume`, the gateway answers:

```json
{
  "type": "stream.resumed",
  "recovered": true,
  "epoch": 7,
  "fromSeq": 42,
  "toSeq": 57
}
```

- `recovered: true` — `session.ready` is sent unsequenced, then the resume ack,
  then missed journal frames verbatim in sequence order. The existing client
  mirror is preserved and frames are applied idempotently.
- `recovered: false` — the epoch mismatched, no durable session journal was
  available, the cursor was beyond the head, or an eviction gap existed. The
  client resets its cursor and the gateway follows with normal readiness plus a
  fresh committed snapshot.

## Binary gateway audio header

Gateway → client journaled audio prepends a fixed 9-byte header:

```text
┌──────────────────────────────┬────────────┬──────────────────────┐
│ 8-byte big-endian u64        │ 1 byte     │ N bytes              │
│ seq                          │ type       │ payload              │
└──────────────────────────────┴────────────┴──────────────────────┘

 type 0x01 = audio
```

`epoch` is carried on JSON coordination frames, not in this header. The client
uses `seq` for ordering/deduplication and routes the payload to the currently
open `turn.audio.start` bracket. Client → gateway microphone binary frames do
not use this outbound journal header.

## Native turn model

A turn is one serialized run of the gateway's native ReAct loop:

1. a user or background-completion stimulus is appended to the store;
2. `SessionRuntime` emits `turn.started` with a server-minted `turnId`;
3. the loop re-reads the store each iteration, streams text, and may dispatch
   foreground or background tools through the broker;
4. the final reply is committed and the turn completes, or a user cancellation
   commits a partial with a cutoff.

There is at most one active turn per durable session. Input appended while it
runs can be observed by a later iteration; input not consumed by the settled
turn starts a back-to-back turn.

### Gateway → client turn frames

| Frame | Contract |
|---|---|
| `turn.started` | `{ turnId, trigger }`, where trigger is `user` or `background-completion`. |
| `turn.text.delta` | `{ turnId, text, replyId? }`; `turnId` is required and `replyId` is the live bubble key. |
| `turn.completed` | `{ turnId }`; clears every open bubble belonging to that turn. |
| `turn.aborted` | `{ turnId, cutoff }`, cutoff `interrupt` or `barge-in`; also clears every open bubble of the turn. |
| `turn.audio.start` | `{ turnId, encoding, sampleRate }`; opens the attribution bracket for following binary audio. |
| `turn.audio.done` | `{ turnId }`; closes that turn's audio bracket. |
| `playback.stop` | `{ turnId, reason }`; the only frame that flushes queued client audio. |

A new turn never flushes or preempts earlier TTS. Clients queue complete audio
brackets in order. Only user barge-in or interrupt produces `playback.stop`.

## `replyId` and conversation entries

`turnId` identifies execution; `replyId` identifies a rendered assistant
bubble. A single turn may narrate, call a tool, and answer in several stored
assistant stretches that fold into one reply. If a user message lands mid-turn,
the runtime rotates `replyId`, so one turn can legitimately produce two
assistant rows separated by the user row.

Client rules:

1. Key in-flight assistant buffers by `replyId` after the first stamped delta.
   `turn.started` may seed an empty turn-keyed placeholder; the first delta
   adopts it while empty.
2. Suppress/upsert the committed twin by `replyId`/`entryId`, never by
   `turnId` alone.
3. Clear all live buffers for a turn on `turn.completed` or `turn.aborted`.

`conversation.entry` carries `{ item, turnId?, replyId? }`. Assistant items also
carry `replyId` so attach snapshots and REST history retain the bubble identity
without a frame sidecar. `entryId` is stable and comes from the same gateway
store projection on live, snapshot, and REST paths; clients upsert by it.

`conversation.snapshot { items }` is a full replacement of the committed
mirror. It is sent on fresh/non-recovered attach, including an empty snapshot
for a draft boundary. `conversation.entry` is the incremental durable commit.
Tool calls and tool results never appear as conversation feed items.

## Tool, permission, and delegation frames

`tasklist.state` is the full current composer-strip state:

```text
{ turnId: string | null,
  items: [{ id, toolName, kind, status, argsPreview, startedAtMs, endedAtMs? }] }
```

`kind` is `foreground` or `background`; `status` is `running`, `done`, or
`error`. Full state is last-one-wins. `argsPreview` is renderable user content
and must never be logged.

A value-aware confirmation uses:

- `permission.request { requestId, toolCallId, toolName, args, description,
  expiresAtMs }`
- client `permission.response { requestId, approved }`
- `permission.resolved { requestId, outcome }`, with `allowed`, `denied`, or
  `timeout`

Clients answer by `requestId`; every resolution path closes the prompt.

Background delegated work uses
`delegation.progress { taskId, turnId, agent, status, note? }`. Its `turnId` is
the dispatching turn, not necessarily the currently active turn. Interrupt and
barge-in stop the turn and TTS but do not cancel background work.

## Client frame inventory

After authentication, client JSON frames are:

- `session.configure`
- `audio.start`, `audio.end`, and binary microphone audio
- `text.input`
- `permission.response`
- `interrupt`
- `ping`
- `session.new`
- `conversation.activate`
- `user.preferences.patch`

Use the exported zod schemas for exact required/defaulted fields and limits.
Do not add aliases or convenience envelopes outside those schemas.
