# Task Brief: Add capture-aware audio protocol, Web SDK mediation, and gateway commit/cancel semantics

## Contribution Goal

Make each audio capture explicitly identifiable so Send commits, Cancel discards, stale terminal commands are harmless, and canceled manual speech can never become conversational input.

## Boundary — Included

- Additive TypeScript wire schemas and bindings for capture-aware start/end/cancel.
- Web SDK connector lifecycle, capture identity, first-terminal-wins, frame-latch behavior, and old-client compatibility.
- Gateway per-connection capture state, manual transcript commit gate, semantic behavior preservation, cancel/disconnect discard, stale isolation, and sanitized diagnostics.
- Focused protocol, SDK, mediator, WebSocket routing, and STT-session tests.

## Required Work

- 1. Extend shared/protocol/src/messages.ts and tests so audio.start accepts optional captureId plus turnMode manual|semantic, audio.end accepts optional captureId, and audio.cancel requires a captureId for new-client use. Missing captureId on legacy start/end retains the existing one-implicit-capture-per-connection behavior; missing turnMode remains semantic. Do not weaken sessionId/attachmentGeneration mediation.
- 2. Update shared/web-sdk command binding and UserAudioInputConnector to generate or accept a stable opaque captureId per start, send captureId on all new controls, expose distinct commit and cancel operations, and enforce exactly one accepted terminal outcome. A stale/repeated end or cancel must be a no-op and cannot stop a newer capture.
- 3. Preserve the existing binary frame format. Enforce the stronger ordered invariant instead: invalidate/close the connector generation and stop accepting producer callbacks before terminal control is sent; no binary send occurs after end/cancel; no overlapping active captures exist. Add deterministic callback-generation tests rather than adding an unreviewed binary envelope.
- 4. Add a per-WebSocket capture FSM in the gateway path. Start establishes active id/mode; matching end is the only manual commit; matching cancel discards without flush or submission; first matching terminal wins; stale/mismatched terminals do nothing; a subsequent distinct start creates the next capture only after the prior terminal state is safe.
- 5. In SttSession, reject frames unless the microphone/capture is open. Attribute adapter callbacks by both the existing uplink epoch and capture identity. For manual mode, buffer sanitized transcript values and call runtime.submit({kind:'conversational', ...}) only after a matching accepted end and successful final flush. Cancel, disconnect, session leave, permission loss, or adapter failure must drop buffered manual text. Semantic mode retains existing Smart-Turn/finalization behavior.
- 6. Preserve input-floor, authenticated attachment, session binding, and authorization boundaries. A model/tool result is never authorization. Cancel affects only the identified user capture; it does not invoke assistant Interrupt or background-task cancellation.
- 7. Add sanitized structured diagnostics containing capture id, mode, byte counts, transitions, and reason only—never transcript, message, prompt, frame/audio bytes, token, or credentials.
- 8. Extend protocol/Web SDK/gateway tests for old start/end compatibility, explicit manual Send, manual Cancel, semantic end, duplicate/racing terminals, stale terminal after a new start, no frames after terminal, adapter callback after cancel, session switch/disconnect discard, and no runtime submission/tool/TTS trigger from canceled manual output.

## Integration Expectation

Deliver this contribution for integration in stage contracts-and-harness.

## Context

- Current TypeScript protocol is shared/protocol/src/messages.ts: audio.start carries optional turnMode, audio.end has no payload, and no audio.cancel exists.
- Web SDK control ownership is shared/web-sdk/src/connectors/user-audio-input-connector.ts and command stamping is in shared/web-sdk/src/sentient-sdk.ts. Binary audio remains ordered WebSocket data.
- Gateway routing and STT ownership are gateway/src/session-handlers/ws-handlers.ts, command-mediator.ts, session-binding.ts, and stt-session.ts. SttSession.discard already closes without flushing; current manual transcripts can submit before an explicit commit gate.

## Boundary — Excluded

- WebUI or iOS composer visuals and gestures
- KMP mobile serialization/uplink changes, owned by kmp-capture-semantics
- Automated microphone, STT service, TTS, acoustic, reconnection, or network-disruption E2E
- Android UI changes
- Assistant interrupt or background task cancellation redesign

## Interfaces and Dependencies

- Wire: audio.start(captureId, turnMode), audio.end(captureId), audio.cancel(captureId), with legacy captureId-less start/end accepted by the new gateway.
- Web SDK produces capture-aware start/commit/cancel methods and a generation-gated binary send seam for the later Web composer task.
- Gateway produces a typed per-connection capture outcome and only submits committed manual transcript or existing semantic transcript.
