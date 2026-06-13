# E2E — Resume Conversation Continuity (warm reconnect)

**Date:** 2026-06-12 · **Gateway:** 1.11.2 (local macOS Docker stack) · **App:** Android debug (mobile-sdk 0.1.1) · **Device:** emulator-5554 (Pixel_3a_API_34)

**Fix under test:** on a warm WS reconnect the mobile SDK sends `conversationId`
in `session.configure`; the gateway seeds a re-anchor (`pendingNewSessionId`)
before the `recovered:true` early-return so the next message CONTINUES the same
Hermes conversation instead of forking.

## Reproduction procedure (warm reconnect on the emulator)

The emulator cannot drop the gateway WS via WiFi toggle (eth0), and there is no
client-side WS-drop debug fault. Airplane-mode DOES sever connectivity to the
host (`ping 10.0.2.2 → Network unreachable`) while leaving the gateway process
(and its warm device buffer) alive — yielding the exact `recovered:true` warm
reconnect. Procedure:

1. `maestro test qa/mobile/flows/android/04c-reconnect-continue-login-send.yaml`
2. `adb shell cmd connectivity airplane-mode enable` ; wait ~12s ; `adb shell cmd connectivity airplane-mode disable`
3. Tap the **"Connection lost. Tap to reconnect"** banner (the app does not
   auto-reconnect after a cold network drop — observation, see below).
4. `maestro test qa/mobile/flows/android/04c-reconnect-continue-followup.yaml`
5. Assert from `docker exec sentient-gateway sh -c 'cat /app/logs/$(date +%F).log'`.

## Result: GREEN

Both Maestro flows passed. Gateway log trail (verbatim):

```
# Turn 1 — establishes CONV_A
20:59:52 dispatch.end  cycleId=cycle-1  conversationId="c56491f7-36a0-4c63-9225-9934bfe556ef"

# Warm reconnect — the fix firing
21:05:13 [ws:session-configure] resume.reanchor  sessionId="s-mqbu0zqi-..."  conversationId="c56491f7-36a0-4c63-9225-9934bfe556ef"  source="configure"
21:05:13 [ws:resume]            resume.recovered  deviceId="57d3bef7-..."  epoch=1  fromSeq=15 toSeq=14  replayCount=0   # recovered:true (warm)

# Follow-up — CONTINUES CONV_A, no fork
21:06:14 dispatch.begin  userMessagePreview="What is my favorite number?"
21:06:21 dispatch.end    conversationId="c56491f7-36a0-4c63-9225-9934bfe556ef"   # SAME as turn 1
#        dispatch.session-new.lazy  → ABSENT (no fork)
```

- Same `conversationId` on both turns → thread continued.
- `resume.reanchor source=configure` → the SDK's new `conversationId` field drove the re-anchor.
- No `dispatch.session-new.lazy` → the prod fork signature is gone.
- Assistant reply referenced "42" (context retained) — screenshots: `01-first-turn.png`, `02-followup-continues.png`.
- No conversation/reconnect-path WARN/ERROR (only pre-existing infra noise: docker-pull, missing policy file, no HA token, gateway-side optional LLM disabled).

## Observations / follow-ups (out of scope for this fix)

- **Manual tap to reconnect:** after a cold network drop the app shows
  "Connection lost. Tap to reconnect" and reconnects on tap, not automatically.
  This is the existing mobile reconnect UX (orthogonal to the continuity fix).
  Worth a separate look at auto-reconnect-on-presence if it adds friction.

## iOS leg — flagged for follow-up

The fix lives in shared `commonMain` (mobile-sdk): `SessionConfigure.conversationId`
+ `SdkLifecycle.sendConfigure` + the `SentientSdk` hook are the identical code
path on iOS. The gateway is platform-agnostic. The Android run above exercises
that shared code end-to-end. The iOS app was NOT rebuilt/run here (the sim holds
the pre-fix build; an iOS app rebuild + Maestro is a separate effort). Recommend
an iOS-device/simulator smoke of the same scenario as follow-up; behavior is
expected identical given the shared SDK.
