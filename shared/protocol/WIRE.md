# Wire Contract (`@sentient/protocol`)

The authoritative gateway ↔ client (web / mobile / cube) wire contract. The
zod schemas in `src/` are the source of truth; this file documents the parts a
reader can't infer at a glance. Keep it in lockstep with `src/messages.ts` and
`src/sessions.ts`.

## Transport boundary — WS vs REST

A standing architectural rule, not just for one feature:

- **WebSocket** carries the **live chat session ONLY**: mic audio in, TTS audio
  out, the live conversation stream (`conversation.entry`, `cycle.*`,
  `cognition.status`, `task.update`, `tool.confirm_request`), `ping`/`pong`,
  `interrupt`, and the resume handshake. *Everything on the WS push channel is
  seq-stamped and replay-buffered.*
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

## Capability gate

The binary header + resume behaviour is advertised via the `stream.resume`
capability in `session.configure.capabilities.supports`. Clients that don't
advertise it get the legacy untagged-binary behaviour — protects older clients
and the not-yet-live ESP32 cube; web/mobile opt in independently.

## See also

Design rationale (build-not-buy, memory math, two-timer model):
`docs/superpowers/specs/2026-06-09-ws-resilience-and-chat-mirror-design.md`.
