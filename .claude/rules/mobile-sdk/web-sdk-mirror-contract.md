---
paths: ["shared/mobile-sdk/**"]
---
# web-sdk Mirror Contract

- `shared/mobile-sdk` mirrors the ROLE and surface of `shared/web-sdk`: same status states, same connector capabilities, same wire frames, same gate semantics (SpeechGate/EchoGate/AudioPreRollRing/IdleDetector).
- Wire-frame shapes are the contract with the gateway — mirror the EXACT message `type`s and fields web-sdk uses (auth, session.configure, session.ready, conversation.*, connector.audio.*, cycle.*, ping/pong, interrupt). Do NOT invent envelopes.
- When the gateway protocol changes, web-sdk and mobile-sdk change together. Cross-check `shared/web-sdk/src/` before altering a frame.
- Pure state machines are ported from web-sdk with identical transition tables; port the web-sdk unit tests as commonTest to pin parity.
- Logger tag root is `["sentient", "mobile-sdk", ...]`, matching web-sdk's `createLogger` shape.

> Details: agents/docs/mobile-sdk/web-sdk-mirror-contract-details.md
