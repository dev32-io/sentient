# Device Registry + Steward Capability Access — Design Plan

> **Status:** Design/planning. Not ready to implement — gates on Phase B landing and on the Steward agent being real. Written now to prevent Phase B from painting us into a corner.

**Goal:** Give the Steward agent (the always-on system Hermes profile with `role: "steward"`) the ability to address physical devices in the home directly — "play an alarm on the kitchen speaker" — without going through any user's PersonSession. Devices that are currently serving as someone's conversation window should still be reachable by the Steward, with well-defined arbitration for the "both want the speaker" case.

**Concrete motivating UX:** ESP32 with speaker in the kitchen. While Alice is cooking, it's her window into her assistant. While Alice is out, Steward detects motion and plays an alert sound through the same hardware. Same device, different owners, no conflict.

---

## Architectural separation

Today (after Phase B2): one WS = one `DeviceAttachment` = one subscription to a `PersonSession`. Device identity and subscription identity are conflated because they happen to have the same lifetime.

For Steward access and future stable-device identity (ESP32 firmware knows its own name), we need three concepts:

| Concept | Owner | Lifetime | Example |
|---|---|---|---|
| **Device** | `DeviceRegistry` | persists while hardware is registered — may outlive any single WS | `esp32-kitchen-01` |
| **Subscription / DeviceAttachment** | `PersonSession` | lives for the duration of a user-conversation membership | kitchen-esp32 is alice's TTS target right now |
| **Capability invocation** | Steward via MCP | one-shot (play this audio once) | `device.alarm("esp32-kitchen-01", "intruder")` |

**PersonSession subscription is optional.** A device can be registered and reachable by the Steward without ever being attached to any user's PersonSession. This is important for sensor-only devices (PIR, door contact) and for shared speakers in semi-public spaces.

---

## Device capabilities

At register time, a device declares what it can do. Capability strings (subset to start):

- `audio.output` — has a speaker the gateway can play arbitrary PCM/audio on.
- `audio.input` — has a mic we can capture from.
- `sensor.motion` — emits motion events.
- `sensor.door` — emits open/close events.
- `ui.display` — can show text (character/OLED).

The Steward's MCP allowlist includes device tools that filter by capability: `device.list_with(capability)`, `device.play({id, audio|text})` (requires `audio.output`), etc. Sensor events flow in the other direction (device → gateway → Steward via ambient stream).

---

## Steward MCP tools (gateway-exposed)

New tools on the gateway MCP server, served via the same unix socket. Allowlisted in the steward profile only:

- `device.list()` → array of `{id, capabilities, busy, attached_to_profile|null}`.
- `device.play({id, audio_url|text, priority})` → plays audio on `id`. `text` synthesizes via TTS first; `audio_url` is a pre-rendered asset (e.g. `alarm.wav`).
- `device.alarm({id, preset})` → convenience for recognized alarm presets (intruder, fire, water). Just plays a baked asset at high priority.
- `device.speak({id, text, as="steward"})` → speaks text as the Steward. Distinct voice profile so the user can tell it's not their assistant.
- `device.set_led({id, pattern})` — later, for visual alerts.

All invocations go through a **gateway-side output arbitrator** that resolves conflicts when the device is already playing something.

---

## Arbitration rules

The device has one speaker. Two potential output sources:

1. **User TTS** (from the user's PersonSession the device is subscribed to).
2. **Steward capability invocation** (from MCP `device.play`).

Proposed priority tiers:

| Tier | Example | Behaviour vs. lower tiers |
|---|---|---|
| `emergency` | `device.alarm("intruder")` | Preempt everything, including user TTS mid-word. |
| `high` | `device.speak("The door just opened.")` | Preempt user TTS (clean cutoff at sentence boundary if possible). |
| `normal` | User TTS reply | Default. Steward `normal`-tier asks go to queue. |
| `background` | `device.speak("Laundry is done.", tier="background")` | Wait for user TTS to finish, then play. Drop if still queued after timeout. |

Arbitration lives in the gateway, not in the Steward agent. The Steward just declares what it wants; the gateway enforces priority. Each device's speaker is a serialized channel.

---

## Subscription-independent access

When the Steward invokes `device.play({id})`, the gateway:

1. Looks up the device by ID in `DeviceRegistry`.
2. If device is offline → returns failure, Steward can retry or log.
3. If device is online → routes audio frames to the device's WS regardless of subscription state.
4. If the device is currently subscribed to a user's PersonSession:
   - Arbitrator checks priority.
   - If Steward wins → sends `connector.audio.interrupt` (new) to the device, plays Steward audio, then restores.
   - If Steward loses / ties → queue behind the PersonSession's current cycle.

---

## Implementation phases (later, not now)

### Phase D1 — Device identity in the WS protocol
- [ ] Client sends `device_id` on connect (URL param, mirror of `?profile=`). Missing device_id → ephemeral ID (current web SDK behaviour).
- [ ] `DeviceRegistry` class keyed by device_id; tracks WS lifecycle, capabilities, attached profile (nullable).
- [ ] `DeviceAttachment` becomes a subscription primitive that references `Device` + `PersonSession`; `Device` has its own lifetime now.

### Phase D2 — Device capability declaration
- [ ] Device capabilities declared in `session.configure` or a new `device.register` message.
- [ ] Capability schema shared type in `shared/protocol`.

### Phase D3 — Gateway-side output arbitrator
- [ ] Single-writer serialized output queue per `Device` with `audio.output`.
- [ ] Priority tiers as above. Preempt / queue / drop rules by tier.
- [ ] Tests for each combination of source tier × current-output tier.

### Phase D4 — Steward MCP tool surface
- [ ] Implement `device.list`, `device.play`, `device.alarm`, `device.speak` handlers.
- [ ] Gate by the steward role in the MCP policy.
- [ ] Steward profile YAML gets these tools allowlisted.

### Phase D5 — Sensor capability → Steward ambient stream
- [ ] Devices with `sensor.motion` / `sensor.door` emit events; gateway forwards to the Steward's Hermes session as ambient context.
- [ ] Steward can then reason + invoke `device.alarm` as a reaction.

---

## What this means for Phase B

Phase B should NOT:
- Assume every DeviceAttachment has a PersonSession (future: may have none).
- Tie `DeviceAttachment.attachmentId` to `sessionId` (ws lifetime) *permanently* — it's fine as a starting value, but don't build code that requires them to be identical.
- Build output fan-out (B4) in a way that can't later be extended to priority arbitration.

Phase B SHOULD:
- Keep DeviceAttachment's interface narrow: send / sendBinary / ttsTarget. That's all the arbitrator needs to plug in later.
- Leave PersonSession's `attach/detach` methods generic — they don't care about device identity.

No Phase B commits need to change based on this plan, but I'll make sure none of them preclude the future extension.

---

## Decisions captured

- Devices are first-class, separate from PersonSession. PersonSession subscription is one use for a device, not its identity.
- Steward accesses devices directly through gateway MCP tools, not by attaching to a PersonSession.
- Arbitration is gateway-side, priority-tiered.
- Steward speaks with a distinct voice so users don't confuse Steward output with their assistant.
- Sensor input flows via the ambient stream into the Steward Hermes session; it's not a new transport.
