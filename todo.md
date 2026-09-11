# TODO

This root list tracks current cross-project gaps. Dated investigations and
completed migration findings remain in their historical documents.

## Reliability

- Make side-effecting tool execution crash-safe: persist in-flight task state,
  use idempotency keys where supported, and fail closed when restart recovery
  cannot determine whether an action ran.
- Preserve background-task outcomes across gateway restarts instead of relying
  only on a resident `SessionRuntime`.
- Continue regression coverage for reconnect, session attachment, steering,
  and live-versus-replay convergence as concrete defects are found.

## Security and privacy

- Make the shared capability path check symlink-safe before another filesystem
  surface depends on its lexical path comparison.
- Keep extending inbound content screening at actual trust boundaries without
  treating model output as authorization.
- Define the audience and privacy contract required before private memory is
  spoken on communal hardware.

## Clients

- Complete physical acoustic voice-loop validation on Android and iOS,
  including echo cancellation, barge-in, playback queueing, and interruption.
- Align the ESP32 cube with the complete current session protocol and continue
  extracting its reusable firmware SDK.

## Operations

- Keep production install, upgrade, rollback, addon recovery, and loopback-only
  exposure checks reproducible on the Apple-silicon Mac target.
- Keep Docker addon images and native Python/model artifacts pinned and
  build-time supplied; production installation must not fetch dependencies.

Current architecture and direction live in [`ARCHITECTURE.md`](ARCHITECTURE.md)
and [`ROADMAP.md`](ROADMAP.md). The detailed native migration log remains in
[`docs/native-todo.md`](docs/native-todo.md); verify any item there against
current source before acting because it also preserves closed and dated
findings.
