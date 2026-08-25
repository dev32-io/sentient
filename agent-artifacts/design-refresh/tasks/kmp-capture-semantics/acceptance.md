# Task Acceptance: Implement capture-aware KMP voice uplink and talk-state semantics

## Deliverables

- Give iOS and existing Android voice callers a serialized capture engine that emits identified start/end/cancel controls, stops frames before terminal, and implements Hold, Send, Cancel, and Auto transitions safely.

## Acceptance

- Manual Send emits one matching AudioEnd after all frames stop; Cancel emits one matching AudioCancel and no AudioEnd.
- Hold-to-Auto emits end(old manual ID) before start(new semantic ID); Auto exit ends its semantic ID.
- A stale or duplicate terminal action cannot stop a newer capture.
- No binary frame is emitted after a capture terminal control.
- No Android UI source file changes and existing Android voice UI behavior remains compatible.

## Boundary Proof

- Common tests pin state-machine and serialized-uplink invariants, including races and teardown.
- Android compilation/unit tests prove additive shared compatibility without visual work.
