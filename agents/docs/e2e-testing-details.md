# E2E Smoke — Details & Examples

The driver depends on the surface: **web** (webui) → Playwright MCP; **native mobile** (Android + iOS apps) → Maestro + `adb`/`xcrun simctl`. The rule file (`.claude/rules/e2e-testing.md`) defines the bar; this doc shows how to execute it well. Both surfaces smoke against the same `deploy/macos/` gateway stack.

## Bringup

Default stack: `deploy/macos/docker-compose.yml`. From the repo root:

```bash
source scripts/env.sh
HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml build gateway
HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml up -d
until curl -sk -o /dev/null -w "%{http_code}" https://localhost:8888/ | grep -q 200; do sleep 1; done
```

Open `https://localhost:8888` via Playwright MCP `browser_navigate`. The
self-signed cert is already trusted in the chromium profile that ships
with the MCP — no clickthrough needed.

## Native mobile bringup (Maestro)

Same gateway stack; the apps point at it (Android emulator loopback `wss://10.0.2.2:8888`, iOS sim via the LAN host). Drive with Maestro:

```bash
# Android: build+install debug, then run a flow (resource-id selectors)
adb install -r android/build/outputs/apk/debug/android-debug.apk
maestro test qa/mobile/flows/android/01-send-stream.yaml      # or: qa/mobile/run-e2e.sh
adb logcat -d | grep -i sentient                              # log trail (not browser console)
# Faults (debug build only): adb shell am broadcast -a io.sentient.debug.FAULT --es kind malformed-frame

# iOS: boot a sim, build via xcodebuild, run the flow (accessibilityIdentifier selectors)
xcrun simctl boot "iPhone 16 Pro"; maestro test qa/mobile/flows/ios/01-send-stream.yaml
# Login subflow: qa/mobile/flows/ios/login.yaml (avatar + PIN 1234). iOS has no fault-arming channel yet.
```

PIN for local test logins is `1234`. Known native gaps (iOS fault-arming, swipe rename/delete, physical-device reconnect) are flagged in the mobile-testing rules.

## Viewport matrix

Run every case at both viewports unless the feature is desktop-only or
mobile-only.

```text
desktop  → browser_resize(1280, 900)
mobile   → browser_resize(390, 844)   # iPhone 16 Pro physical width
```

For features that need additional breakpoints (tablet, narrow desktop),
add them to the matrix in the spec doc.

## Smoke matrix shape (inline in the spec AND the plan)

Every spec and every implementation plan defines its matrix inline as a
table (never a separate file). Native mobile e2e (Maestro / `android`
CLI) uses the same column shape; write driver flows at run time and save
evidence to the feature's screenshot dir.

```markdown
| Case                              | Viewport      | Pre-state          | Action                        | Expected user-visible           | Expected log trail              |
|-----------------------------------|---------------|--------------------|-------------------------------|--------------------------------|---------------------------------|
| Empty list, fresh user            | desktop+mobile| no sessions        | open drawer                   | empty-state copy renders       | no WARN / ERROR                 |
| Switch mid-cycle                  | desktop       | cycle streaming    | click old session in drawer   | bubbles re-render to old chat  | `cycle.aborted` then `snapshot` |
| Reconnect with stale session_id   | desktop       | sessionStorage set | kill+restart gateway          | drops to new chat              | one WARN: `session 404 fallback`|
```

Running the matrix is part of done. Capture evidence per row: screenshot
post-action, console messages, network requests if contract matters.

## Driving Preact / signals via Playwright MCP

Preact's onClick handlers run in the bubble phase. JavaScript-evaluated
`btn.click()` sometimes fails to fire the handler reliably. Prefer the
MCP's high-level interactions:

- `browser_click` over `evaluate_script` for buttons.
- `browser_fill` (or `browser_type`) over property-set + dispatch for
  textareas. The MCP simulates real input events.
- `browser_press_key` for Enter / Escape / Tab.

When you need to mutate state programmatically (seed localStorage,
inject a fixture session_id), use `browser_evaluate` — it has full DOM
access and persists across actions in the same page.

## Console + network capture

```text
browser_console_messages       # filter by tag prefix
browser_network_requests       # check WS handshakes, HTTP shape
```

Tag-filter examples for sentient:

- `[sentient.webui.audio-playback]` — audio path.
- `[sentient.webui.cycle-audio-queue]` — cycle serialization.
- `[sentient.web-sdk.presence]` — idle-detector transitions.
- `[sentient.webui.voice-client]` — SDK construction.
- `[sentient.sessions.*]` — sessions feature.

A case is green only when console + network match expectations. A
silent UI pass with WARN noise in the console is not green.

## Cross-tab smoke

Use `browser_tabs` to open a second tab to the same URL, drive both
tabs interleaved. Useful for BroadcastChannel / cross-tab sync flows
(e.g. delete in tab A, observe tab B's list).

## Reconnect / restart smoke

To exercise WS reconnect, kill the gateway container while a tab is
open:

```bash
docker compose -f deploy/macos/docker-compose.yml restart gateway
```

Wait for `/health` to come back, then verify the tab reconnected. The
SDK's exponential-backoff path is in `shared/web-sdk/src/sdk-reconnect.ts`.

## Pi / production smoke (NOT agent-driven)

Pi rebuild + health-check + log-level smoke only:

```bash
ssh kevinye@hacore.lan
cd ~/sentient && git pull && docker compose -f deploy/pi/docker-compose.yml \
  build gateway && docker compose -f deploy/pi/docker-compose.yml up -d gateway
docker compose -f deploy/pi/docker-compose.yml ps
docker compose -f deploy/pi/docker-compose.yml logs gateway --tail=200 \
  | grep -E "WARN|ERROR" || echo "clean"
```

Real-user smoke on Pi is the operator's job, not the agent's.

## When a case is genuinely unreachable

Cases the agent cannot reach in chromium MUST be flagged in handover:

- iOS Safari audio-session quirks (transient activation, AC ghost state).
- Real-device sensors (camera, mic permissions on physical hardware).
- Paid-service-dependent flows (Fish Audio TTS playback when no key is
  available).
- Real LAN multicast / mDNS discovery from outside the docker network.

Format: a `## Operator follow-up` section in the handover note, listing
each case with the smallest reproduction steps.

## Reusable case library

`agents/docs/testing-knowledge.md` is the project's catalog of reusable
smoke cases. Append new cases there with:

- **Scenario** — one paragraph.
- **Why added** — what regression / contract this guards.
- **Steps** — numbered, MCP-callable.
- **Expected** — user-visible + log-trail.

The case library is the source of truth across features; the per-spec
matrix references it instead of duplicating.

## Anti-patterns

- **Mocking in smoke.** Mocks belong in unit tests. Smoke runs against
  real services or it provides no defense.
- **Skipping the mobile viewport "because the feature looks desktopy".**
  Layout regressions land most often where the agent didn't look.
- **Declaring done without console evidence.** A passing UI screenshot
  with WARN noise is not green.
- **Reusing fixture sessions across cases.** Each case starts from a
  known pre-state; if needed, reset via Hermes `DELETE /api/sessions/{id}`
  or `rm -rf ~/.sentient/<...>` before the run.
- **Smoking against prod.** Use the local Mac stack. Pi push is verified
  by build + health + log smoke only.
