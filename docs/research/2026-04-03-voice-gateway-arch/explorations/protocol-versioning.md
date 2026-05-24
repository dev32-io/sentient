# Protocol Sub-Decision: Protocol Versioning

## Parent Decision Area
`client-gateway-protocol` — this is a sub-decision extracted during decomposition.

## Decision Area
Whether and how to version the WebSocket protocol for future-proofing. Clients and the gateway will evolve at different rates — what happens when a new message type is added, a field changes, or the framing rules evolve?

## Key Questions

1. **Is versioning needed at all?** With 5 users and full control over all clients, can we just update everything at once?
2. **Negotiation**: If we version, when and how is the version negotiated?
3. **Backwards compatibility**: Must old clients work with new gateway versions?
4. **Forward compatibility**: Must old gateways tolerate unknown message types from new clients?
5. **Granularity**: Version the whole protocol (v1, v2) or version individual message types?

---

## Context: Who Controls the Clients?

This is a family project. The gateway runs on the RPi5 (one instance). The clients are:

- **Desktop app**: Self-authored, self-deployed — updated by the developer (you)
- **Web app**: Served from the gateway or a local server — updated by reloading the page
- **Mobile app**: Self-authored — updated manually on family phones

**Key insight**: The developer controls both the gateway and all clients. There is no third-party client ecosystem. There are no external API consumers. There is no backwards-compatibility contract with strangers.

---

## Approaches

### A. No Formal Versioning — Additive Compatibility (Recommended)

No version number. The protocol evolves additively. Rules:

1. **New message types**: Gateway and clients ignore unknown message types (log a warning, don't crash). This means new message types can be added to the gateway before all clients are updated.
2. **New fields on existing messages**: Clients and gateway ignore unknown fields. New fields are always optional — required fields are never added to existing message types.
3. **Removing message types or fields**: Only done when all clients have been updated. Since the developer controls all clients, this is a deployment coordination step, not a protocol version issue.
4. **Binary frame format changes**: The binary-frames-are-always-audio rule is a foundational invariant that never changes. If a second binary payload type is ever needed, it's multiplexed via a 1-byte type prefix (but this is unlikely — audio is the only binary data).

**Implementation:**

```python
# Gateway: ignore unknown message types
handler = HANDLERS.get(data.get("type"))
if handler:
    await handler(session, data)
else:
    logger.warning("unknown_message_type", type=data.get("type"), user=session.user)
    # Don't send error — old gateway, new client is fine
```

```javascript
// Client: ignore unknown message types
ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        const handler = handlers[msg.type];
        if (handler) handler(msg);
        else console.warn('Unknown message type:', msg.type);
    } else {
        // Binary = audio, always
        playAudioFrame(event.data);
    }
};
```

**Pros:**
- **Zero overhead** — no version field, no negotiation, no capability exchange
- **Works for the actual scale** — 1 developer, 5 users, all clients self-controlled
- **Additive changes are natural** — JSON is inherently forward-compatible (unknown fields are ignored)
- **Sufficient for years** — the protocol will stabilize quickly; most changes will be adding new message types for new tool capabilities

**Cons:**
- **Breaking changes require coordination** — must update all clients before deploying a breaking gateway change. Acceptable: the developer is one person.
- **No machine-readable contract** — you can't ask "does this client support tool.confirm?" without actually sending it. Acceptable: you know what your clients support.

### B. Version Number in session.start

Client sends a protocol version during auth. Gateway validates compatibility.

```json
{"type": "session.start", "token": "...", "protocol_version": 1}
```

Gateway responds with negotiated version:
```json
{"type": "session.ready", "session_id": "...", "protocol_version": 1}
```

**Pros:**
- Clear contract — both sides agree on the version
- Gateway can reject outdated clients: "Please update your app"
- Enables version-specific behavior on the gateway

**Cons:**
- **Ceremony for nothing** — with one developer and 5 users, version mismatches are resolved by "hey Dad, update the app"
- **Version number management** — when to bump? Every new message type? Every breaking change? Semantic versioning for a WebSocket protocol?
- **Partial compatibility is hard** — v2 might add 3 new features; a client at v1.5 (manually updated halfway) doesn't fit cleanly into v1 or v2
- **Gateway must support multiple versions** — even temporarily, code branches per version are complexity with no audience

### C. Capability Negotiation

Client declares capabilities at session start. Gateway responds with its capabilities. Each side only sends message types the other supports.

```json
// Client
{"type": "session.start", "token": "...", "capabilities": ["audio", "text", "tool_confirm", "barge_in"]}

// Gateway
{"type": "session.ready", "capabilities": ["audio", "text", "tool_confirm", "barge_in", "voice_switch"]}
```

**Pros:**
- Fine-grained — each client can support a different subset
- Graceful degradation — gateway doesn't send tool.confirm to a client that doesn't support it
- Future-proof for hypothetical third-party clients

**Cons:**
- **Massive over-engineering** — this is the approach for protocols with hundreds of clients from different vendors (XMPP, Matrix). For 5 family devices under one developer's control, it's absurd.
- **Testing combinatorics** — N capabilities × 2 (supported/not) = 2^N configurations to test
- **Dynamic behavior** — gateway behavior changes based on client capabilities, making debugging harder
- **No real use case** — all clients will support all capabilities because one person builds them all

---

## Analysis & Recommendation

### Recommendation: Approach A (No Formal Versioning — Additive Compatibility)

This is the classic YAGNI decision. Formal versioning solves the problem of coordinating changes between many independent parties. This project has **one** developer controlling **all** parties.

**The rules are simple:**
1. Ignore unknown message types (log, don't crash)
2. Ignore unknown fields on known messages
3. New required fields → new message type
4. Breaking changes → update all clients, then deploy gateway (or vice versa — deploy order doesn't matter when unknown types are ignored)

**If versioning becomes needed later** (e.g., the project opens up to third-party clients), adding a `protocol_version` field to `session.start` is a 5-line change. The additive compatibility rules make this a non-breaking addition.

### Protocol Stability Expectation

The message types defined in the parent exploration (`session.start`, `audio.start`, `audio.end`, `text.input`, `barge_in`, `tool.confirm`, `response.start`, `response.text`, `response.end`, `error`, `ping`, `pong`) will stabilize within the first few weeks of development. After that, changes will be additive (new message types for new features), not modifications to existing types. Formal versioning for a stable protocol is pure waste.
