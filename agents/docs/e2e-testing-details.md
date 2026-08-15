# E2E testing — details

Local smoke uses the real stack: the gateway runs natively, while managed addon services run under the gateway's system orchestrator. Browser tests drive the outward door at `https://localhost/`; production is observation-only.

## Bringup

```bash
source scripts/env.sh
bun run dev &
until curl -sk -o /dev/null -w "%{http_code}" https://localhost/ | grep -q 200; do sleep 1; done
```

Use Playwright MCP against `https://localhost/`, not the diagnostic gateway port. The local self-signed certificate is handled by the configured browser profile. `bun --watch` is the development restart path; never use `bun --hot`.

For mobile, use the same stack: the Android emulator fallback is `wss://10.0.2.2:443/api/v1/ws`, while iOS simulator traffic uses the configured host endpoint. Build/install the app, then run the repository's Maestro flow. Physical devices, device sensors, paid providers, and production user actions belong in operator follow-up.

## Matrix

Run each applicable case at desktop `1280x900` and mobile `390x844`. Record screenshot, console messages, and network requests when the contract matters.

```markdown
| Case | Viewport | Pre-state | Action | Expected result |
|---|---|---|---|---|
| Fresh session | both | no sessions | open chat | empty state and no warning |
| Follow-up while audio plays | desktop | active turn | send text | second turn queues; first audio is not cut off |
| Reconnect | both | attached session | restart local gateway | SDK reconnects and resumes or snapshots |
```

Prefer Playwright interactions (`browser_click`, `browser_fill`, `browser_press_key`) to DOM-evaluated clicks. Use `browser_console_messages` and `browser_network_requests` as evidence, not just a screenshot. Reset local state between cases rather than reusing a fixture session.

## Boundaries

- Smoke tests do not mock the gateway, native runtime, store, or addon services.
- Do not inject chats or probe a production assistant. On production, inspect health and logs only.
- Keep secrets, prompts, transcripts, and other user content out of captured logs and evidence.
