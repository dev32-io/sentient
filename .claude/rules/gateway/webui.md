---
paths:
  - "gateway/webui/src/**/*.ts"
  - "gateway/webui/src/**/*.tsx"
---
# Web UI guardrails

- The WebSocket hook owns server state; do not duplicate it into component stores. Keep view state local and derive computed values.
- Leaf components are pure and receive state/actions; effects and data loading stay at screen/container boundaries.
- Voice capture and playback use AudioWorklets and the established PCM/ring-buffer path, not `MediaRecorder`. Barge-in stops playback, clears buffered audio, and signals the gateway.
- Mic denial must leave a usable text-only client. COOP/COEP headers remain intact where `SharedArrayBuffer` is required.
- Use semantic HTML and accessible controls. Validate responsive behavior at desktop and mobile-sized browser viewports against the local stack.
