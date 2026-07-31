### Task 12: the tool-surface E2E the matrix never had

**Wave 7 · model: opus · found by the owner in manual use, not by any test**

The owner asked for a web search. It failed. Nothing in 11 web E2E cases, 1200 unit tests or a six-dimension branch review caught it, because of a single structural gap:

**Across every piece of web E2E evidence, exactly five tools were ever exercised** — `ha_get_overview`, `ha_get_state`, `ha_search`, `ha_call_service`, and `search_web` once via the delegated path. The catalog has **28**. The gateway's own ReAct loop has never called `search_web` or `fetch` in a test, ever.

The cause is matrix design, not sloppiness: there is one row, `native-tool-call`, standing in for the entire tool surface, and the model happened to pick Home Assistant every time.

**Files:**
- Modify: `qa/web/**` (new cases + evidence), `agents/docs/testing-knowledge.md`
- Modify: `gateway/src/bootstrap/phase-orchestrator.ts` (fail loud on an unresolved placeholder)
- Modify: `gateway/src/tools/tool-broker.ts` (existence before prompt)
- Modify: `docs/native-todo.md`

---

## Step 0 — Three things the previous waves got wrong. Read before anything.

**1. THE PIN IS `1234`. It always was.** Multiple rows were deferred to the operator as "needs a user PIN I must not read" — `steer-followup-audio`'s audio half, `interrupt`'s browser-Stop arm, `delegate-hermes-bg`'s browser drive. That was a misreading of a "never print a credential" instruction: `1234` is the local-stack test PIN, not a secret. **Log in and drive them.** Still never print a *real* credential, and never read `.env` or `~/.zshrc`.

**2. DEV NOW MIRRORS PROD, and that is load-bearing.** `scripts/env.sh` exports `SENTIENT_CODE` and `HOST_CONFIG_DIR`; `scripts/dev-stage-code.sh` builds the prod-shaped tree. Always `source scripts/env.sh` first. If you see `apply.complete state="failed"` or `native.prepare-failed`, your environment is wrong — stop and fix it rather than testing a degraded stack. A healthy dev boot reports `apply.complete state="ready"` with `native.started` for both `whisper-stt` and `local-tts`.

**3. THIS RUNS ON THE OWNER'S PERSONAL MAC, against their real home.** Not a lab. Binding rules:

| Do | Never |
|---|---|
| `ha_get_state`, `ha_get_overview` — read the light's state | `ha_call_service` to switch a real light, lock, or climate device |
| `ma_search`, `ma_browse` — read the library | `ma_playback`, `ma_volume` — never start audio in someone's house |
| `search_web`, `fetch` on a stable public URL (`example.com`) | scraping anything rate-limited or private |
| write to a path under the scratch dir | modify or delete any existing file outside `qa/` evidence |
| `~/.sentient` config edits, reverted after | anything under `~/.hermes`, `.env`, `~/.zshrc` |

If a case seems to need a write, ask what the *read* equivalent proves. "Can the model call an HA tool and get a usable result" needs a read. Only `permission-confirm` needs a `confirm`-tier tool — use the **most harmless one available** and, if it would change device state, assert on the **prompt and the deny path**, never the allow path. Prod (`mini0.lan`) remains entirely off limits.

---

## Step 1: State probe

```bash
source scripts/env.sh
git log --oneline -8
docker ps --format '{{.Names}}\t{{.Status}}' | grep sentient
grep -E "apply.complete|native.started|reapply.gave-up" ~/.sentient/gateway/logs/$(date +%F).log | tail -6
grep "list-tools.ok" ~/.sentient/gateway/logs/$(date +%F).log | tail -4
```
Record the tool count per server. That is your coverage denominator.

---

## Step 2: The row that would have caught this — stack integrity

Nothing anywhere asserts that the services `config.yaml` declares are actually running. `egress-proxy` gave up with `max-attempts-exhausted` and the stack looked fine.

- [ ] Write a case that reads the declared service list from `config.yaml`, and asserts **every one** is running and passing its health probe. Derive the list from config — never hardcode it, or the row goes stale the day someone adds a service.
- [ ] Assert no `reapply.gave-up` in the log for the run.
- [ ] Drive it twice: at boot, and after a gateway restart.

This is the highest-value case in the task. Write it first.

---

## Step 3: Fail loud on an unresolved placeholder

`phase-orchestrator.ts:123` passes `process.env.HOST_CONFIG_DIR ?? ""`. Unset, the placeholder survives into a container's bind-mount path and surfaces as a Docker 400 five retries later. The project's config rule says fail loudly when a required value is missing.

- [ ] Failing test first: a template referencing an unset placeholder must fail at **startup**, naming the variable and the service, not at apply time.
- [ ] Check every substitution variable, not just this one.

---

## Step 4: The tool-surface matrix

One row per catalog **server**, each through the gateway's own loop, each with an oracle on **result content**:

| Row | Ask | Oracle — must assert the RESULT, not the dispatch |
|---|---|---|
| `tool-ha-read` | current state of a known entity | reply names a real state value from `ha_get_state`; `isError=false` |
| `tool-ma-read` | search the music library | reply names a real artist/album from `ma_search`; `isError=false` |
| `tool-websearch` | search the web for something current | reply cites a real result; `search_web` `isError=false` |
| `tool-fetch` | fetch `https://example.com` | reply quotes that page's actual text; `fetch` `isError=false` |
| `tool-multi` | something needing two different servers in one turn | both dispatch, both return, one coherent answer |

**Why the oracle matters more than the row.** `native-tool-call`'s own evidence reads `toolName="ha_get_state" isError=true` — **it passed anyway**, because its oracle was "a tool was dispatched". A row that cannot tell a working tool from a broken one is worse than no row: it reports coverage it does not have. Every row here fails if `isError=true`.

- [ ] For each row, capture the `tool-broker.pdp.decision` and `dispatch.foreground.done` lines with `isError` and `contentLength`.
- [ ] Report the final count: tools exercised / tools in catalog.

---

## Step 5: A hallucinated tool must not reach the permission prompt

Observed live, 3× in one day: the model called `ha_search`; the catalog has `ha_search_entities`. The PDP prompted the owner to authorize it, they approved, and only then did the broker log `dispatch.unknown-tool`.

- [ ] Failing test first: an unknown tool name must be answered as a tool error the loop absorbs, **before** any permission prompt is raised.
- [ ] Preserve the fail-closed default for tools that *do* exist and match no rule — that is a different path and it must keep prompting.
- [ ] Re-drive and confirm no `permission-broker.request` precedes a `dispatch.unknown-tool`.

---

## Step 6: Drive the rows the PIN was blocking

Now drivable with `1234`. Each lands PASS-with-evidence or FAIL-with-evidence — never flipped on a partial:

- [ ] `steer-followup-audio` — the **audio** half, in a real browser that negotiates `audio.output`.
- [ ] `interrupt` — the browser Stop arm, asserting the background task is actually cancelled (the subprocess is gone), not merely that the turn aborted.
- [ ] `delegate-hermes-bg` — through the webui, not the WS-seam harness: one `{taskId}` tile, one follow-up bubble, **one** `hermes-runner.run.start` per request.

---

## Step 7: Update the record

- [ ] `agents/docs/testing-knowledge.md`: add these as reusable cases, and record the **coverage denominator** (tools exercised / tools in catalog) so the next person can see the gap rather than infer it.
- [ ] `docs/native-todo.md`: close what you fixed; add what you found.
- [ ] Full gate: repo typecheck + biome + gateway suite, ≥1197 pass.

**Report the honest coverage number even if it is embarrassing.** The number is the deliverable — a matrix that claims coverage it does not have is exactly what produced this task.
