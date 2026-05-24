# Protocol Sub-Decision: Message Dispatch Architecture

## Parent Decision Area
`client-gateway-protocol` — this is a sub-decision extracted during decomposition.

## Decision Area
How the WebSocket handler dispatches incoming messages to the correct handler logic. The current design is a flat `if/elif` dispatch loop inside `websocket_handler()` that will bloat as message types grow. This sub-decision determines the extensible dispatch pattern.

## Key Questions

1. **Dispatch pattern**: Flat if/elif, dictionary dispatch table, handler registry with decorators, or class-based message handlers?
2. **Message validation**: How to validate incoming JSON messages (required fields, types, unknown message rejection)?
3. **Handler isolation**: Should a crash in one message handler (e.g., `tool.confirm`) affect other message processing on the same connection?
4. **Ordering guarantees**: Audio frames must be processed in order; can control messages (barge-in) be prioritized over queued audio?
5. **Extensibility**: Adding a new message type should require minimal boilerplate — ideally just registering a handler function.

---

## Approaches

### A. Dictionary Dispatch Table

The simplest step up from if/elif: a `dict[str, Callable]` mapping message types to async handler functions.

```python
HANDLERS: dict[str, Callable] = {
    "session.start": handle_session_start,
    "audio.start": handle_audio_start,
    "audio.end": handle_audio_end,
    "text.input": handle_text_input,
    "barge_in": handle_barge_in,
    "tool.confirm": handle_tool_confirm,
    "ping": handle_ping,
}

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    session = SessionContext(ws)
    
    async for msg in ws:
        if msg.type == WSMsgType.BINARY:
            await session.pipeline.push_audio(msg.data)
        elif msg.type == WSMsgType.TEXT:
            data = json.loads(msg.data)
            handler = HANDLERS.get(data.get("type"))
            if handler:
                await handler(session, data)
            else:
                await ws.send_json({"type": "error", "code": "unknown_message", "message": f"Unknown type: {data.get('type')}"})
```

**Pros:**
- Dead simple — any Python developer understands it immediately
- O(1) dispatch (dict lookup vs if/elif chain)
- Easy to add new handlers: define function, add to dict
- Easy to test: each handler is a standalone async function with `(session, data)` signature
- No framework overhead

**Cons:**
- No built-in message validation — each handler must validate its own fields
- No middleware/hook point (e.g., "log every message before dispatch")
- Handler registration is manual (must add to dict explicitly)

### B. Decorated Handler Registry

Handlers register themselves via a decorator, with optional message schema validation.

```python
from dataclasses import dataclass
from typing import Any

registry: dict[str, tuple[Callable, type | None]] = {}

def message_handler(msg_type: str, schema: type | None = None):
    def decorator(fn):
        registry[msg_type] = (fn, schema)
        return fn
    return decorator

@dataclass
class SessionStartMsg:
    token: str
    audio_config: dict[str, Any] | None = None

@message_handler("session.start", schema=SessionStartMsg)
async def handle_session_start(session: SessionContext, data: SessionStartMsg):
    user = await authenticate(data.token)
    session.bind_user(user)
    await session.ws.send_json({"type": "session.ready", "session_id": session.id, "user": user.name})

@message_handler("barge_in")
async def handle_barge_in(session: SessionContext, data: dict):
    await session.pipeline.interrupt()
```

**Pros:**
- Self-documenting — handler, message type, and schema are colocated
- Schema validation happens before dispatch, centralizing error handling
- Adding a new handler = define function + decorator, no touching a central dict
- Enables auto-documentation of the protocol (iterate registry to list all message types)

**Cons:**
- Slightly more magic — decorator registration requires understanding the pattern
- Schema classes add boilerplate for simple messages (e.g., `barge_in` has no fields)
- Import-time side effects (decorator runs at import) — must ensure handler modules are imported

### C. Class-Based Message Handlers

Each message type gets its own handler class, similar to Django views or aiohttp handlers.

```python
class MessageHandler(ABC):
    @abstractmethod
    async def handle(self, session: SessionContext, data: dict) -> None: ...
    
    @abstractmethod
    def validate(self, data: dict) -> bool: ...

class SessionStartHandler(MessageHandler):
    async def handle(self, session, data):
        user = await authenticate(data["token"])
        session.bind_user(user)
        ...
    
    def validate(self, data):
        return "token" in data

# Registry
HANDLERS = {
    "session.start": SessionStartHandler(),
    "barge_in": BargeInHandler(),
    ...
}
```

**Pros:**
- Validation and handling colocated per message type
- Can carry state per handler type if needed (unlikely)
- Familiar to Django/aiohttp developers

**Cons:**
- Massive overkill — each handler is 1-5 lines of logic wrapped in a class + method + validate method
- ~15 message types × ~20 lines of class boilerplate = 300 lines of ceremony for maybe 60 lines of actual logic
- No benefit over plain functions for this use case — there's no polymorphism or state to leverage
- Adds an ABC import dependency and class hierarchy for no gain

---

## Message Validation

Regardless of dispatch pattern, incoming messages need validation. Options:

### Lightweight: Required-fields check

```python
REQUIRED_FIELDS = {
    "session.start": ["token"],
    "text.input": ["text"],
    "tool.confirm": ["tool_call_id", "approved"],
}

def validate(msg_type: str, data: dict) -> str | None:
    for field in REQUIRED_FIELDS.get(msg_type, []):
        if field not in data:
            return f"Missing required field: {field}"
    return None
```

This is sufficient for a family gateway with 5 users. Full JSON Schema validation (jsonschema, pydantic) is overkill — the only "untrusted" input is from family members' devices, not arbitrary API consumers.

### Pre-dispatch middleware

Wrap the dispatch with a validation + logging layer:

```python
async def dispatch(session, msg):
    data = json.loads(msg.data)
    msg_type = data.get("type")
    
    # Log
    logger.debug("recv", user=session.user, type=msg_type)
    
    # Validate
    error = validate(msg_type, data)
    if error:
        await session.ws.send_json({"type": "error", "code": "invalid_message", "message": error})
        return
    
    # Dispatch
    handler = HANDLERS.get(msg_type)
    if handler:
        try:
            await handler(session, data)
        except Exception as e:
            logger.error("handler_error", type=msg_type, error=str(e))
            await session.ws.send_json({"type": "error", "code": "internal_error", "message": "Processing failed"})
    else:
        await session.ws.send_json({"type": "error", "code": "unknown_message", "message": f"Unknown: {msg_type}"})
```

This adds handler error isolation (one handler crash doesn't kill the connection) and centralized logging with zero per-handler boilerplate.

---

## Control Message Priority

Audio frames arrive at 50fps. A barge-in must be processed immediately, not queued behind 20 buffered audio frames.

**Solution**: The current PoC already handles this naturally because `aiohttp`'s `async for msg in ws` yields messages in arrival order, and each message is processed before the next is read. Since barge-in cancels the pipeline task, subsequent audio frames hit a cancelled pipeline and are no-ops.

However, if we ever batch audio frames (e.g., buffering 5 frames before pushing to STT), control messages must bypass the buffer:

```python
if msg.type == WSMsgType.TEXT:
    # Control messages — always process immediately
    await dispatch(session, msg)
elif msg.type == WSMsgType.BINARY:
    # Audio — may be buffered
    session.audio_buffer.append(msg.data)
    if len(session.audio_buffer) >= BATCH_SIZE:
        await session.pipeline.push_audio_batch(session.audio_buffer)
        session.audio_buffer.clear()
```

This is already implicit in the binary-vs-text frame split — a design strength of the existing framing.

---

## Analysis & Recommendation

### Recommendation: Approach A (Dictionary Dispatch) + Pre-dispatch Middleware

For a 5-user family gateway with ~15 message types:

1. **Dictionary dispatch** — simplest, fastest, no magic. Each handler is a plain async function.
2. **Pre-dispatch middleware** — centralizes validation, logging, and error isolation in one place.
3. **Required-fields validation** — lightweight, sufficient for the trust model (family devices only).
4. **Skip class-based handlers** — the ceremony-to-logic ratio is terrible for this scale.
5. **Skip decorator registry** — marginally nicer than a dict, but adds import-time magic for negligible benefit with only ~15 message types.

The key insight: the WebSocket handler has **exactly two dispatch paths** — binary frames go directly to the audio pipeline, text frames go through JSON dispatch. This two-tier split is already clean. The message dispatch within the text path just needs to not be a growing if/elif block.

### Adding a New Message Type (Developer Experience)

With the recommended approach, adding a new message type requires:

1. Define an async handler function: `async def handle_new_thing(session, data): ...`
2. Add to dict: `"new.thing": handle_new_thing`
3. Optionally add required fields: `"new.thing": ["field1", "field2"]`

Three lines of registration for each new message type. Good enough.
