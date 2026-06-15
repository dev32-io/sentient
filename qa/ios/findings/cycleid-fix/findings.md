# cycleId render-key fix — iOS Maestro E2E findings

Branch: `feature/cycleid-render-projection-fix`
Date: 2026-06-15
Device: iPhone 14 Pro, iOS 26.5, sim UDID `2BB144EC-281C-4E5E-883F-65A21EF67056`
App: `io.dev32.sentient.debug` (0.1.3 build 2), SIGNED debug build.
Gateway: local Docker stack from this branch, TLS (wss) on localhost:8888.

Screenshots (PNG, gitignored repo-wide) live next to this file:
A1-turn1-reply, A2-reconnected, A3-followup-reply, B1-before-scroll,
B2-scrolled-up, B3-scrolled-back-down.

## Result summary

| Charter | Result | Notes |
|---------|--------|-------|
| A — reconnect-followup (part1 + part2) | PASS | Follow-up reply renders correctly; prior reply shown once, not duplicated/missing. Two distinct NUMERIC cycleIds. |
| B — scroll stability | PASS | Bottom reply correct after scroll up-to-top and back down; no stale row swap. |

## Charter A — follow-up render + cycleId uniqueness

User-visible (A3): conversation renders in order —
Kevin "Reply with exactly: ALPHA" -> Sentient "ALPHA"; Kevin "Reply with exactly: BRAVO"
-> Sentient "BRAVO". BRAVO reply under the BRAVO message; ALPHA reply still shown exactly
ONCE above it. Nothing missing, nothing duplicated. PASS.

Gateway log (clean part1+part2 run, session `s-mqewrky7-7dtvdbtt`):

    2026-06-15T00:45:17.091 [cerebrum:attention-gate] cycle dispatched | cycleId="1781509517090" ... sessionId="s-mqewrky7-7dtvdbtt"
    2026-06-15T00:45:17.092 [cerebrum:hermes-dispatcher] dispatch.begin | cycleId="1781509517090" userMessagePreview="Reply with exactly: ALPHA"
    2026-06-15T00:45:45.081 [cerebrum:attention-gate] cycle dispatched | cycleId="1781509545080" ... sessionId="s-mqewrky7-7dtvdbtt"
    2026-06-15T00:45:45.086 [cerebrum:hermes-dispatcher] dispatch.begin | cycleId="1781509545080" userMessagePreview="Reply with exactly: BRAVO"

- ALPHA cycleId = 1781509517090 (NUMERIC POSIX-ms).
- BRAVO cycleId = 1781509545080 (NUMERIC POSIX-ms).
- DISTINCT (~28 s apart), same continuing conversation.
- Whole-day log scan: ZERO client-facing cycleId="cycle-N". The only small-integer
  cycleIds belong to the [hermes-adapter-client:acp:per-profile-connection] namespace
  (Hermes internal ACP wire counter — expected, different namespace).

## Charter B — scroll stability

Built ALPHA + OCEANIC(long) + DELTA(long) so the list overflows. Scrolled to top (first
user message "Reply with exactly: ALPHA" visible — B2), then back to bottom (latest DELTA
reply still visible + correct — B3). No stale row swapped into the bottom slot. PASS.

## BLOCKER found and FIXED before testing could run

Pre-installed sim app could not log in: REST PIN auth returned 200 but the WS auth
handshake was rejected with code 1008 "first message must be type:auth". SDK logs:

    secure.token-store.ios: save-failed op=add status=-34018   (errSecMissingEntitlement)
    secure.token-store.ios: load-failed status=-34018
    transport.ws.ios: send-text length=26                       (Auth frame, EMPTY token)
    transport.ws.ios: closed-clean code=1008 reason=first message must be type:auth

The installed app was built with CODE_SIGNING_ALLOWED=NO, which strips the keychain
entitlement -> keychain save/load fail (-34018) -> empty WS auth token -> gateway rejects.
Known build artifact (docs/superpowers warn about it), NOT a product bug and unrelated to
the cycleId fix.

Fix: rebuilt + reinstalled a SIGNED debug app for the sim:

    xcodebuild -project SentientApp.xcodeproj -scheme SentientApp -configuration Debug \
      -destination 'platform=iOS Simulator,id=<UDID>' \
      CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES build

After reinstall: save-ok / load-ok tokenLength=279 / auth.ok / READY.

## Selector adaptations vs chat-smoke.yaml (stale ids there)

- Composer text field id is `composer-input`, NOT `chat-input` (source keeps chat-input
  only as an a11y-label alias; Maestro matches by identifier).
- Assistant reply bubble id is `assistant-bubble`; user bubbles are `message-bubble-0`.
  There is no `message-bubble-1`. Charters assert on reply TEXT, not bubble indices.
- Long replies matched by regex (.*OCEANIC.* / .*DELTA.*); a bare substring only matches a
  node whose whole a11y label equals it.
- Scrolling: explicit coordinate swipes in the list region are reliable; scrollUntilVisible
  can no-op on a partially-clipped bubble.
- Maestro launchApp is a COLD relaunch -> part2 must NOT relaunch; it continues part1's
  live process to keep the conversation.

## Flagged limitation (not a regression)

The original bug needed a resumable socket drop where the gateway session + conversation
SURVIVE but a FRESH AttentionGate is built for the next turn. On this build the
agent-reachable transport events do not cleanly hit that path: a full docker restart and
Maestro launchApp both produce configure.resume.skip-no-cursor -> a fresh empty chat
(mobile-lifecycle: chat rebuilt fresh on cold entry); a brief network blip leaves loopback
TCP intact (same gate). So the cross-gate colliding-id scenario is NOT cleanly reproducible
by agent-driven E2E here — it is covered server-side by the cycleId-uniqueness log assertion
and the mobile entryId-dedup unit guard. The user-visible no-missing/no-dup guarantee IS
verified (Charter A).
