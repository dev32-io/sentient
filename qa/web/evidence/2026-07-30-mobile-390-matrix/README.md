# Mobile viewport (390×844) — real re-drive of the 2.0 web matrix

Closes the coverage gap left by the first Task-9 pass (which spot-checked one screenshot at
mobile width and handed the rest forward). Every row below was **driven at 390×844 against the
live native stack** — real gateway (`bun src/main.ts`, `:8888`), real Vite webui (`:5173`), real
`gpt-oss:20b-cloud` provider calls, real `home_assistant` MCP over loopback, real local-tts
(Qwen3-TTS) Opus audio. No mocks, no replayed fixtures.

User driven: **Grace** (`u_1eee01a4`, non-admin member) — a real second user, so the mobile pass
doubles as a member-scoped run of the same rows the desktop pass drove as admin.

## MANDATORY procedure note — resize alone is not a mobile check

`browser_resize(390,844)` on an already-loaded page leaves the app in a **stale layout**: the
first screenshot taken that way showed the whole shell clipped ~53px to the left (bubble text cut
mid-word, composer placeholder reading "sage Sentient"). That artifact is NOT the product's
mobile layout. **Always `browser_navigate` (reload) after the resize, then assert.** The
first pass's single mobile screenshot was taken in exactly this stale state, which is why its one
observation ("last chip visually truncated") read as a layout smell rather than the intended
scrollable row it actually is.

Verified-intentional at 390 (measured, not eyeballed):
- `.suggestion-chips` — `overflow-x: auto`, `scrollWidth 511 > clientWidth 370` → horizontally
  scrollable chip row by design. Resolves the first pass's open cosmetic note.
- `.tool-strip__pills` — `overflow-x: auto`, `scrollWidth 344 > clientWidth 332` → tool pills are
  a scrollable strip; a pill clipped at the right edge is the design, not a break.

## Case results at 390×844

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail | Result |
|---|---|---|---|---|---|---|
| native-turn-happy | 390×844 | 2-item session, fresh load | send a text message | reply renders, bubble survives `turn.completed`, no clipping | one `turnId` through `turn-voice.begin`→`turn-started`→`react-loop.start`→`stream-end`→`turn-completed`→`audio.done` | **PASS** |
| native-tool-call | 390×844 | after turn 1 | ask for an HA overview | tool pill running→done on the bubble, real HA answer wraps at 390 | `pdp.decision action="allow" rule="allow_ha_get_overview"`→`mcp.call-tool.ok`→`tool-dispatch.foreground` | **PASS** |
| permission-confirm-web (Allow) | 390×844 | mid-turn side-effecting call | tap Allow in the bottom-sheet dialog | dialog blocks the turn, then the service really fires | `pdp.decision action="confirm"`→`permission-broker.request`→`permission-resolved outcome="allowed"`→`mcp.call-tool.ok` | **PASS** |
| permission-confirm-web (Deny) | 390×844 | mid-turn side-effecting call | tap Deny | tool declines, model says it can't execute | `permission-resolved outcome="denied"`, model informed | **PASS** |
| permission-confirm-web (timeout) | 390×844 | dialog open, no response | wait 120s | auto-deny | `outcome="timeout"` | **not re-driven at 390 — see "deliberately not re-driven"** |
| interrupt (turn+TTS stop) | 390×844 | TTS mid-synthesis (`audio-start` fired, `audio-done` not) | tap Interrupt (28×28 at x341-369, in viewport) | audio stops instantly | `cancellation.no-turn-in-flight cutoff="interrupt"`→`audio.cancel`→`playback-stop reason="interrupt"`→`playback.stop cutTurnCount=1`→`synthesize-aborted frameCount=3`→`audio.cancelled bytesSent=39003` | **PASS** (7 ms client→server) |
| reload-convergence | 390×844 | 14-article session w/ 4 tool pills + permission entries | hard reload | identical feed, all tool pills present | `replay-registry.fresh epoch=7`→`conversation-snapshot itemCount=18 throughSeq=22` | **PASS** (14/14 articles, 4/4 pills, first+last identical) |
| compaction-continue | 390×844 | — | — | — | — | **not re-driven at 390 — see below** |
| restart-persistence | 390×844 | — | — | — | — | **not re-driven at 390 — see below** |
| multi-user-isolation | 390×844 | Grace (member) session | whole pass driven as Grace | no Ada data anywhere in Grace's feed | Grace's own `conversationId`/store throughout: `c::u_1eee01a4::…` | **PASS (data-isolation arm)**; user-switch arm not driven at 390 — see below |
| delegate-hermes-bg / steer-followup-audio / interrupt(bg-cancel) / barge-in | 390×844 | — | — | — | — | **BLOCKED at every viewport** — same root causes the desktop pass root-caused (no `hermes profile create` for a new user; fresh profile has no bound model; no barge-in UI trigger exists). Viewport is irrelevant to all four. |

Screenshots (local only — `.gitignore` excludes `*.png` repo-wide, same as the desktop evidence
dirs; the committed artifact is this README plus the log excerpts):
`00-baseline-ok-shell-scrollleft-0.png`, `01-defect-shell-shifted-53px.png`,
`02-native-turn-happy.png`, `03-native-tool-call.png`, `04a-interrupt-control-visible.png`,
`04b-after-interrupt.png`, `05a-permission-dialog.png`, `06-reload-convergence.png`.
Log excerpts (committed): `gateway-log-*.txt`.

### Deliberately not re-driven at 390, with the reason

- **permission-confirm timeout (120 s)** — the timer is a server-side `permission-broker`
  deadline (`timeoutMs=120000`, confirmed in this run's `permission-broker.request` line); the
  viewport cannot influence it, and the dialog it dismisses is the same `.app-dialog` proven to
  render and accept taps at 390 in the Allow/Deny arms. Re-driving would cost 2 minutes of wall
  clock to re-observe a desktop-proven server timer.
- **compaction-continue** — the trigger is `maybeCompact()` comparing `estimatedTokens` against
  `compact_threshold_tokens`, entirely server-side. Its client-visible surface is "the feed keeps
  rendering coherently", which the 14-article / 18-item mobile feed above already exercises.
  Independently, the summarizer round-trip is **broken** in this environment (desktop pass: 2/2
  `finishReason="length"` empty-summary skips), so no viewport can observe a completed compaction
  until that is fixed.
- **restart-persistence** — the resume protocol (`replay-registry`, snapshot refetch) is transport
  layer, identical at both viewports; the mobile `reload-convergence` row above exercises the same
  snapshot path (`resumed=false` → full snapshot). Re-driving the process restart would also
  re-trigger the known P1 native-driver `local-tts` spawn hang and take the TTS-dependent rows of
  this very pass down with it.
- **multi-user-isolation user-switch arm** — the header user-menu (`.user-menu__trigger`) does not
  open on click **at either viewport** (`aria-expanded` stays `"false"` at 390 *and* at 1280 in
  this browser session), so this is not a mobile-specific finding and is not claimed as a defect
  here — attribution needs the desktop switch path the first pass used. The isolation arm that
  *is* viewport-observable (a member's feed containing zero admin data, own `conversationId`) is
  green above.

## Real defect found by this pass (out of Task 9's owned files → handed off)

**`.app-shell` overflows the 390 px viewport by 53 px, and one tap on the right-most header
control shifts the entire app permanently off-screen with no way back.**

Measured, reproduced deterministically:

| Step | `.app-shell.scrollLeft` | hamburger (`Past chats`) x-range |
|---|---|---|
| fresh load at 390×844 | 0 | 14 → 58 (reachable) |
| one click on `.user-menu__trigger` (x 303–390, the right-most header control) | **53** | **−39 → 5 (off-screen, unreachable)** |

- `.app-shell` computed `overflow-x: hidden` with `scrollWidth 443 > clientWidth 390` → the layout
  simply does not fit 390 px, and because overflow is `hidden` there is **no scrollbar and no pan
  gesture** to undo the 53 px shift. Only a reload restores it.
- Consequence at mobile width: the "Past chats" button becomes untappable and the left 53 px of
  every bubble, the composer placeholder, and the brand mark are clipped mid-glyph
  (`01-defect-shell-shifted-53px.png` vs the clean `00-baseline-ok-shell-scrollleft-0.png`).
- Not present at desktop: at 1280×900 the same measurement gives `scrollWidth − clientWidth = 0`.
- Programmatically setting `scrollLeft = 0` restores the layout, confirming the shift — not a
  reflow — is the whole defect.

Root cause is webui CSS/layout (`.app-shell` overflow contract + topbar min-content width),
outside Task 9's owned files (`qa/web/**`, `agents/docs/testing-knowledge.md`, and the single
`compact_threshold_tokens` key). Recorded, not fixed. **Suggested fix shape:** make the topbar row
fit at 390 (collapse the user-menu to avatar-only / allow the brand block to shrink) and stop the
shell from being a horizontal scroll container at all (`overflow-x: clip` or `min-width: 0` on the
flex children) so a focus scroll cannot displace it.

## Stack notes for whoever picks this up

- The gateway process from the first pass was still live; `local-tts` was **not** running (the
  known P1: `apply.start` fired, `whisper-stt` started, `local-tts` never reached
  `native.started`, `apply.complete` never fired). Started it out-of-band for this pass —
  `capabilityServices/LocalTTSService/.venv/bin/python -m local_tts` with the `LOCAL_TTS_*` env
  from `deploy/mac-prod/native/local-tts.sh` — healthy on `:8771` in ~1 s, and every TTS row above
  then produced real Opus frames. That the manual spawn is instant while the gateway's own spawn
  hangs keeps the P1 pinned on `native-driver.spawnService()`, not on the service.
- Playwright note: `browser_click` on composer/dialog buttons was unreliable in this MCP session
  (same quirk the first pass hit); every interaction above was driven with a script-dispatched
  `element.click()` via `browser_evaluate`, which registered every time. The clicks are still real
  DOM clicks through the app's own handlers — the permission dialog's server-side
  `permission-resolved` line at +1 ms proves the app processed them.
