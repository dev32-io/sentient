# Web SDK mirror contract details

This file expands `.claude/rules/mobile-shared.md` for SDK protocol parity.

The mobile SDK and web SDK mirror the gateway's exact JSON type strings, fields, optionality, and binary framing. Cross-check `shared/protocol`, `shared/web-sdk`, and `shared/mobile-sdk` before changing a frame. Audio remains raw PCM binary; control messages remain JSON.

Current session-related client variants include:

- `PermissionResponse` (`permission.response`)
- `ConversationActivate` (`conversation.activate`)
- `SessionNew` (`session.new`)

`SessionsList` and `SessionSwitch` are not WebSocket frames; session listing and management use REST, while activation uses `ConversationActivate`. The current event surface includes `TurnDone`; preserve its existing wire/event mapping rather than introducing a similarly named replacement.

Keep transport state separate from cognition/audio events. Continuous transport state belongs in `StateFlow`; streamed deltas and one-shot events use the established buffered event surface. Match web SDK behavior and test wire serialization when a protocol variant changes.
