### Task 17: the second E2E round — what the first one never looked at

**Wave 10 · model: opus · driven by the agent in a real browser, local dev stack only**

Round 1 (tasks 9, 10, 12) drove the 2.0 spec's 13-row matrix and the tool surface. It left
three kinds of hole, and this round closes the two that a browser can reach:

1. **Never driven at all** — auth sad paths, error paths, settings persistence.
2. **Code that landed AFTER the last round** — tasks 15 and 16 changed the model resolution,
   the delegation gate, the permission dialog and the feed. None of it has been driven.
3. **Needs a microphone** — `voice-roundtrip`, `barge-in`. **Out of scope**, owner's call;
   they go to the manual handoff at the end of this file, not into the matrix.

**Standing constraints for every row (owner's rules, not suggestions):**
- Tool calls are **reads or temp-writes only**. No `ha_call_service`, no `ma_playback` /
  `ma_play_media` / `ma_volume` — do not start audio in someone's house. Ask for the *state*
  of a light, never toggle it. Write to a scratch path, never modify an existing file.
- **Local dev stack only.** Never Playwright against prod (`mini0.lan` / `sentient.dev32.io`).
- Local PIN is `1234`. Not a secret, but never print a real credential.
- Kill only sentient's own processes, by identified pid. Never a broad `pkill`.

**Pre-flight, every session:** `bun qa/web/stack-integrity.ts` → `RESULT PASS`. A row driven
against a degraded stack proves nothing. Evidence under
`qa/web/evidence/2026-08-01-e2e-round-2/`.

**The oracle rule, restated because it is what this branch keeps re-learning:** a green signal
is worth exactly what its oracle checks. Write the oracle before the fix, and after the fix
re-check that it can still fail. "A bubble appeared" is not an oracle. "A follow-up turn
fired" is not an oracle. Read what the reply *says*.

---

## The matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `auth-wrong-pin` | desktop 1280×900 | logged out | submit a wrong PIN | inline error, stays on login, no partial session | `auth` failure logged; no `principal.minted` |
| `auth-logout` | desktop | authed with history | log out, then log back in | feed returns intact after re-login | new `principal.minted`; store rehydrate; same conversation id |
| `newchat-red` | desktop | authed, non-empty feed | click "+ new chat" | **KNOWN RED (D15)** — records the observed behaviour, does not pass | `session.new` → existing id; `session-boundary.clear-drain`; `refreshMessages` |
| `model-selection` | desktop | authed | read Settings → Model, send a turn | reply arrives | `orchestrator.provider.resolved source="profile"` names **the model settings shows**; `[provider:openai] stream-start` agrees |
| `model-switch-live` | desktop | authed, mid-session | change the model in Settings, Apply, send another turn **without reconnecting** | reply arrives | next turn's `provider.resolved` names the **new** model — the T16 per-request contract |
| `delegate-deny` | desktop | authed | ask for a delegated task, **deny** the prompt | assistant says it was declined and does not retry | `pdp.confirm-resolved confirmed=false`; **no** `hermes-runner.run.start`; a tool result marked declined |
| `delegate-dialog-args` | desktop | authed | trigger the delegation prompt, read it | the **full** `taskPrompt` is visible, one row per argument, long values scroll rather than truncate | `permission-broker.request argKeys=agent,taskPrompt` |
| `bg-no-card` | desktop | authed | approve a delegation, wait for completion | **no** system-event card in the feed; a follow-up reply appears | `turn-emitter.turn-started trigger="background-completion"`; `document.querySelectorAll('.system-event').length === 0` |
| `tool-error-path` | desktop | authed | call a read tool with arguments that must fail (a non-existent entity id) | the reply says **what** failed; no crash, no silent empty answer | `isError=true` on the dispatch; the loop continues to a final answer |
| `tool-server-down` | desktop | authed, one MCP addon stopped | ask for something that needs that server | a graceful "cannot reach" answer, not a hang | dial failure logged with a reason; turn still terminates |
| `tools-breadth` | desktop | authed | exercise read-only tools not yet driven (calendar/todo reads, more HA reads, MA reads) | each answer matches ground truth from `qa/web/tool-truth.ts` | `isError=false` on every dispatch |
| `settings-persist` | desktop | authed | edit a Soul field, Apply, reload | the edited value survives the reload | write logged; re-render on boot |
| `mobile-390-recheck` | mobile 390×844 | authed | walk the feed, the drawer, the permission dialog | no horizontal scroll; dialog fits; no clipped controls | — |

**`newchat-red` is a recording row, not a pass/fail row.** D15 is deferred to the
multi-conversation project and its web half is traced in `docs/native-todo.md`. Drive it to
capture what the user actually sees, then leave it red.

---

## Manual handoff — needs the owner's hands

These cannot be driven headlessly and are **not** counted as covered by this round. Both are
already recorded in `docs/native-todo.md` § 4.

1. **`voice-roundtrip`** — speak a query, hear the answer. Oracle: the transcript matches what
   you said, the reply is *about* it, and TTS speaks it. Check `stt` and `turn-voice.audio.*`
   in `~/.sentient/gateway/logs/$(date +%F).log`.
2. **`barge-in`** — with TTS speaking, start talking over it. Oracle: audio stops promptly, the
   turn aborts with `cutoff="barge-in"`, and **any background task keeps running** (that is the
   distinction from Stop, which cancels them). A fake audio device cannot reproduce the acoustic
   echo path that this row is really testing.
