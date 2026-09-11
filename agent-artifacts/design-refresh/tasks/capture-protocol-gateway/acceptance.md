# Task Acceptance: Add capture-aware audio protocol, Web SDK mediation, and gateway commit/cancel semantics

## Deliverables

- Make each audio capture explicitly identifiable so Send commits, Cancel discards, stale terminal commands are harmless, and canceled manual speech can never become conversational input.

## Acceptance

- A canceled capture cannot create a store entry, model turn, tool call, or TTS request.
- The first matching terminal action wins; stale terminal commands cannot affect a newer capture.
- No binary frame is sent by the Web SDK after terminal and no gateway frame is accepted while capture is closed.
- Legacy clients using captureId-less start/end retain current behavior; capture-aware clients always send IDs.
- All logs and test evidence remain content-free and sanitized.

## Boundary Proof

- Protocol serialization tests pin old/new wire compatibility.
- Web SDK tests pin terminal races, generation latching, and no frames after terminal.
- Gateway unit/integration tests prove commit gating, cancel discard, stale callback isolation, and no conversational submission.
