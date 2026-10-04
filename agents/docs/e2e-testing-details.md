# E2E testing — details

Local smoke uses the real stack: the gateway runs natively, while managed addon services run under the gateway's system orchestrator. Browser tests drive the outward door at `https://localhost/`; production is observation-only.

## Local testing authority and persistent account

Local development is authorized for testing: create/edit local users, profiles and test data as needed without repeated approval. Verify the running gateway and its data roots are development, not production; a loopback URL alone is not proof. Normal test chats through the account's configured Ollama Cloud model are included. New paid-provider setup, billing changes, real hardware and production mutations require separate approval.

Preserve this usable local account across runs:

- Display name: `test`; role: `adult`.
- Model: Ollama Cloud, `deepseek-v4.1-flash:cloud` (DeepSeek V4.1).
- Local endpoint: `https://localhost/`.
- Credentials and current server-minted user ID: `$HOME/.sentient/cube-e2e/test-account.env`, mode `0600`, outside the repository. It exports `LOCAL_TEST_BASE_URL`, `LOCAL_TEST_USER_ID`, `LOCAL_TEST_PIN`, `LOCAL_TEST_MODEL_PROVIDER` and `LOCAL_TEST_MODEL_ID`. Load privately with shell tracing disabled; never print, hash, commit, or attach credentials to evidence.
- Baseline for text-only tests: audio replies off, memory background work off, all effective tools explicitly off. A catalog-only count or empty permission map is not a zero-tools proof; use the existing `qa/design-refresh/text-only-tools.ts` contract when setting up text-only coverage.

**Never delete `test`, including during teardown or because the current session created it.** Do not pass it to disposable-user runners or cleanup. Reuse it for ordinary local checks; use separately owned disposable accounts for account-deletion/destructive cases. Restore temporary profile changes and leave its login/model usable. Clean only test-created records, not unrelated account history. If the account is missing, restore it through supported local admin APIs and update the private handoff rather than replacing it with another disposable account. Never reset unrelated users or write auth stores directly.

## Bringup

```bash
source scripts/env.sh
bun run dev &
until curl -sk -o /dev/null -w "%{http_code}" https://localhost/ | grep -q 200; do sleep 1; done
```

Use Playwright MCP against `https://localhost/`, not the diagnostic gateway port. The local self-signed certificate is handled by the configured browser profile. `bun --watch` is the development restart path; never use `bun --hot`.

For mobile, use the same stack: the Android emulator fallback is `wss://10.0.2.2:443/api/v1/ws`, while iOS simulator traffic uses the configured host endpoint. Build/install the app, then run the repository's Maestro flow. Physical devices, device sensors, new paid-provider setup or billing changes, and production user actions belong in operator follow-up.

## Matrix

Run each applicable case at desktop `1280x900` and mobile `390x844`. Record screenshot, console messages, and network requests when the contract matters.

```markdown
| Case | Viewport | Pre-state | Action | Expected result |
|---|---|---|---|---|
| Fresh session | both | no sessions | open chat | empty state and no warning |
| Follow-up while audio plays | desktop | active turn | send text | second turn queues; first audio is not cut off |
| Reconnect | both | attached session | restart local gateway | SDK reconnects and resumes or snapshots |
```

Prefer Playwright interactions (`browser_click`, `browser_fill`, `browser_press_key`) to DOM-evaluated clicks. Use `browser_console_messages` and `browser_network_requests` as evidence, not just a screenshot. Use a fresh chat/session between cases and restore changed settings; resetting case state must not delete the persistent account.

## Boundaries

- Smoke tests do not mock the gateway, native runtime, store, or addon services.
- Do not inject chats or probe a production assistant. On production, inspect health and logs only.
- Keep secrets, prompts, transcripts, and other user content out of captured logs and evidence.
