# Sentient 2.0 — Remaining Work (Slices 5–9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Sentient 2.0 native orchestrator — voice on the native stream, a coherent 2.0 client wire contract, permission dialogs on all three surfaces, turn-queued audio, compaction, and the full 13-row E2E matrix green.

**Architecture:** Plans 1+2 delivered build-order slices 0–4 (security core, session store, `SessionRuntime` + native ReAct loop, provider client, MCP client, `ToolBroker`, `delegateTask`, cancellation core). This plan delivers slices 5–9. One task freezes the complete 2.0 wire contract; every other task consumes it as a fixed seam. Gateway-side work fans out only where file sets are disjoint; client SDK work precedes client UI work; E2E runs serialized against the single local stack.

**Tech Stack:** Bun + TypeScript (gateway, `shared/protocol`, `shared/web-sdk`), Preact (`gateway/webui`), Kotlin Multiplatform (`shared/mobile-sdk`, `shared/mobile-data`), Compose/M3 (`android/`), SwiftUI (`ios/`), zod, `bun:sqlite`, Playwright MCP (web E2E), Maestro (native E2E).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch:** `feature/native-orchestrator`. Never push to `main` or `develop`. Commit format `type(scope): description`, one logical change per commit.
- **Turn identity is `turnId`.** The 2.0 wire has no `cycleId`. `SessionRuntime` mints `turnId = crypto.randomUUID()` per turn. Every rename sweep goes `cycleId → turnId`, never the reverse.
- **Every outbound gateway frame MUST be constructed and validated through `gatewayMessageSchema`** in `shared/protocol/src/messages.ts`. Today `ws-turn-emitter.ts` and `ws-session-configure.ts` bypass zod entirely via `ws.send(JSON.stringify(objectLiteral))`. A frame added to the schema but sent unvalidated leaves the schema decorative — that is a task failure, not a nit.
- **Fail-closed permission.** A permission timeout is never an implicit approval. Timeout → deny → the model receives a "permission request timed out" tool result. A throw inside `requestConfirm` is already treated as deny in `tool-broker.ts`; preserve that.
- **Permission timeout is 2 minutes, config-tunable.** New config keys go under `orchestrator:` in `gateway/config.yaml` + `shared/config/src/schemas/orchestrator-config.ts`. **Never** add keys under the legacy `cerebrum:` block (its own comment forbids it). Every config value carries an inline comment with valid range. No magic numbers in source.
- **The gateway never stops its own audio (§4.6/§7.2).** Audio is flushed *only* on barge-in (mic onset) or interrupt (UI Stop). A new `turnId` must NEVER cancel, fade, or replace in-flight audio — it queues behind it.
- **Do not modify tuned constants.** `gateway/src/adapters/stt/local-stt-adapter.ts`'s `setTurnMode` dedup logic and `STT_DEFAULT_TURN_MODE`; VAD thresholds; `AudioPipeline`'s hold-defer / lazy-arm / drain-watch machinery beyond the queueing change itself. Reuse these files as-is.
- **Preserve the cancellation invariants.** `cancellation.ts` + `session-runtime.ts` carry a double-commit guard (`signal.aborted || turn.settled`) and a terminal-completion race fix (`onTurnCommitting` fires synchronously before the async `onTurnSettled` clears `inFlight`), both with dedicated regression tests. Read both file headers in full before touching `turnText` accumulator reset points. `interrupt()`'s unconditional `background.cancelAll()` (fires even when `turn === null`) is intentional — do not "optimize" it into an early return.
- **Logging:** every new file imports a tagged logger reflecting its hierarchy. No bare `console.*` in shipped gateway or browser code (browser uses `createLogger([tags])` from `@sentient/web-sdk`). Log every state change, boundary decision, and fallback with a `reason`. Truncate string previews to ≤120 chars. Never log user/chat content on mobile at any level — ids, lengths, types only (`PrivacyGuardTest` enforces this).
- **Testing bar (`.claude/rules/testing.md`):** a test is worth keeping only if it pins a wire/protocol contract at a process boundary, an FSM/invariant with a documented learning, a security boundary, or is an `@live` flow. Do NOT write tests for pure utilities, DI plumbing, types, or constants. Borderline tests get deleted, not kept.
- **`@live` tests are gated on `RUN_LIVE=1`** and resolve provider keys from the operator's secrets store via `getActiveLlm()` — **never** from an env var, and **never** print a key value.
- **E2E is agent-owned.** Web → Playwright MCP (viewports 1280×900 + 390×844). Native mobile → Maestro via `qa/mobile/run-e2e.sh --tags <t1,t2>`, one warm batch per tag set, NEVER one invocation per flow. Never Playwright against native mobile. Never any E2E against prod.
- **Local dev stack only.** `deploy/macos/` is fair game to rebuild/restart. `~/.sentient` may be read; treat `~/.sentient/gateway/config/config.yaml` as operator-owned (edit in place, never clobber from the repo template). Production (`mini0.lan` / `sentient.dev32.io`) is observational-only and out of scope for this plan.
- **Delete stale references as you go.** Several files still carry dead references to purged modules (`speak-effect.ts`, `broadcaster`, `connector.audio.*` in config comments, `WIRE.md`'s entire contents). Fixing the code without fixing its stale comment is an incomplete task.

---

## The Frozen Wire Contract (authored in Task 1 — every other task consumes it)

Task 1 is the trunk. It exists so that voice, permission, delegation, cancellation, and both client SDKs never have to renegotiate frame shapes. **No task after Task 1 may add or rename a frame** without an explicit plan amendment.

### Gateway → client

| Frame | Payload | Replaces |
|---|---|---|
| `turn.started` | `{ turnId, trigger: "user" \| "background-completion" }` | `cycle.started`, `response.turn.started` |
| `turn.text.delta` | `{ turnId, text }` | `message.delta`, `response.text.delta` (which lacked `turnId` — a real bug) |
| `turn.completed` | `{ turnId }` | `cycle.completed`, `message.done`, `response.text.done` |
| `turn.aborted` | `{ turnId, cutoff: "interrupt" \| "barge-in" }` | `cycle.aborted` |
| `turn.tool.update` | `{ turnId, toolCallId, toolName, status: "running" \| "done" \| "error", taskId?, argsPreview, startedAtMs, endedAtMs? }` | `task.update` |
| `turn.audio.start` | `{ turnId, encoding: "opus" \| "pcm", sampleRate }` | `connector.audio.start` |
| `turn.audio.done` | `{ turnId }` | `connector.audio.done` |
| `permission.request` | `{ requestId, toolCallId, toolName, args, description, expiresAtMs }` | `tool.confirm_request` |
| `permission.resolved` | `{ requestId, outcome: "allowed" \| "denied" \| "timeout" }` | *(new — lets the client dismiss the dialog when the server resolves first)* |
| `delegation.progress` | `{ taskId, turnId, agent, status: "running" \| "done" \| "error", note? }` | *(new)* |
| `playback.stop` | `{ turnId, reason: "barge-in" \| "interrupt" }` | same frame, rekeyed `cycleId → turnId` |

Retained unchanged: `auth.ok`, `session.ready`, `error`, `pong`, `session.expired`, `sessions.*`, `stream.resumed`. `conversation.snapshot` / `conversation.entry` are retained but rekeyed `cycleId → turnId`.

### Client → gateway

| Frame | Payload | Note |
|---|---|---|
| `permission.response` | `{ requestId, approved }` | Replaces `tool.confirm` |

Retained unchanged: `session.configure` (incl. `resume`), `audio.start` (`turnMode`), `audio.end`, `text.input`, `interrupt`, `session.end`, `ping`, `session.new`, `conversation.activate`.

### Binary frames

Unchanged layout, documented at the top of `messages.ts`: 8-byte BE u64 seq + 1-byte type (`0x01` = audio) + N-byte payload. Inbound binary = mic audio → STT. Outbound binary = TTS audio → client. These are separate paths; inbound binary is **not** routed through the outbound emitter.

---

## Task Index & Execution Waves

Dependencies are strict. Tasks inside a wave touch disjoint file sets and are safe to run concurrently.

| Wave | Tasks | File | Rationale |
|---|---|---|---|
| 1 | T1 wire contract | `task-1-wire-contract.md` | Trunk. Alone. Everything downstream references it. |
| 2 | T2 voice | `task-2-voice.md` | gateway WS/runtime + stt/tts trees |
| 2 | T3 compaction | `task-3-compaction.md` | gateway store/loop/config — **shares `session-runtime.ts` with T2, see R12** |
| 2 | T4 web client (4a web-sdk + 4b webui) | `task-4-web-client.md` | `shared/web-sdk` + `gateway/webui` — **merged, see R1** |
| 2 | T5 KMP SDK | `task-5-kmp-sdk.md` | `shared/mobile-sdk` + `shared/mobile-data` |
| 3 | T6 permission PDP + frame producers | `task-6-permission-gateway.md` | gateway files freed by T2 landing |
| 3 | T8 Android UI | `task-8-android.md` | `android/` only — consumes T5's surface |
| 3 | T9 iOS UI | `task-9-ios.md` | `ios/` only — consumes T5's surface |
| 4 | T10 reconnect/replay journal | `task-10-reconnect.md` | Re-enters `ws-handlers.ts`/`ws-helpers.ts` after T2 + T6 |
| 5 | T11 E2E web | `task-11-e2e-web.md` | Serialized — one stack owns `:8888` |
| 5 | T12 E2E native | `task-12-e2e-native.md` | Serialized — one device per Maestro batch |

**Hard serialization facts** (not preferences): `shared/protocol/src/messages.ts` is consumed by four packages — one writer, ever. `shared/mobile-sdk` compiles into both Android and iOS — one writer, ever. One gateway owns `:8888`; one simulator/emulator per Maestro batch — E2E cannot fan out.

---

## Plan-Owner Reconciliations

The task authors worked in parallel against the frozen contract and surfaced genuine cross-task conflicts. These are the binding resolutions. Where a task body disagrees with this section, **this section wins**.

**R1 — T4 and T7 are ONE task (`task-4-web-client.md`), not two.** `lefthook` `pre-commit` runs `scripts/quality-gate.sh typecheck` → `bun run --filter '*' typecheck`, which **includes `@sentient/webui`**. The `cycleId → turnId` and connector renames break 5 webui files, so a web-sdk-only commit cannot pass the gate — it would block every commit in the repo. They land as one commit series. (Android/iOS are *not* in that filter, so T5/T8/T9 legitimately stay split and may leave Kotlin/Swift red until their UI tasks land; a Gradle/Xcode build gate runs at end of Wave 3 instead.)

**R2 — The audio queue lives in the SDK, not the app.** T4a's `shared/web-sdk/src/turn-audio-queue.ts` is authoritative; T4b **deletes** `gateway/webui/src/adapters/cycle-audio-queue.ts` rather than rewriting it. Both authors independently implemented a FIFO; only one survives. This mirrors the KMP side, where queueing lives in `commonMain`'s `AudioPipeline` and the app layer is a turn-agnostic byte sink — consistent with the web-sdk-mirror-contract.

**R3 — Text does not stream concurrently; audio does.** §4.5 guarantees one turn at a time per `SessionRuntime`, so a follow-up turn starts only *after* the previous turn commits — two assistant bubbles are never *streaming* simultaneously. §7.2's "two bubbles" = one committed bubble + one live bubble. What *does* overlap is **audio playback** (turn 2's audio queues behind turn 1's still-playing audio). T5's one-live-bubble model is correct; T4's per-turn in-flight map is retained as text-loss protection, not as concurrent rendering. Neither SDK needs a list-shaped live surface.

**R4 — Binary audio frames carry no `turnId`.** The SDK attributes bytes to the most recent `turn.audio.start`. Therefore the gateway **MUST** bracket each turn's audio (`start` → frames → `done`) before starting the next turn's. T2 owns this invariant; T5 depends on it. Stated here because neither task can enforce it alone.

**R5 — Config placement is by domain, superseding the blanket wording in Global Constraints.** Orchestrator *behavior* keys (permission timeout, compaction) go under `orchestrator:`. Session/transport keys (T10's `replay_journal_max_bytes`, `replay_journal_retention_ms`) go under `session:` — `GatewayServices` exposes `session: SessionConfig` but never exposes the orchestrator block, and `cfg.orchestrator` is optional while gap-fill must work on any connection. Both new keys carry zod `.default()` so existing operator configs keep booting. **Never `cerebrum:`** — that clause stands unchanged.

**R6 — Accepted renames.** T4's `TaskStatusConnector → ToolStatusConnector` (+ `TaskSnapshotItem → ToolCallSnapshotItem`, capability `task.status → tool.status`, dedup key `taskId → toolCallId`) and T5's `CycleErrorConnector → TurnErrorConnector` (capability `cycle.error → turn.error`) are both approved: the frame, the key, and the status union all changed, so keeping the old names would leave classes named after retired constructs. No gateway code pins client capability strings.

**R7 — One seq space for JSON and binary.** T10's `sendAudioFrame(ws, payload): number` supersedes T1's `sendAudioFrame(ws, seq, payload): boolean`, and T1's local `audioSeq` counter in `ws-turn-emitter.ts` is deleted. Both client SDKs feed a single resume cursor from both paths, so two counters would corrupt gap detection. T1 ships unsequenced JSON frames; T10 restores sequencing for both.

**R8 — `requestConfirm` keeps its `Promise<boolean>` signature.** T6 encodes the unanswerable third outcome (timeout / socket close / turn abort) as a rejection carrying `ConfirmUnavailableError`, which `tool-broker.ts` forwards to the model verbatim. This keeps the locked PDP seam narrow. An aborted prompt reports on the wire as `outcome: "denied"` — the fail-closed reading, and the only one the frozen contract's three-value enum admits.

**R9 — No transcript frame exists in 2.0.** T1 deletes `connector.transcript.final` and `connector.cancelled`. The user's spoken text reaches the client as a committed `conversation.entry`, not as a live partial. Consequence: **speech appears only once committed**, with no live partial-transcript UI. That is a deliberate simplification of the frozen contract, not an oversight — reopening it requires a plan amendment and a new frame.

**R10 — `ToolUpdate` gains `argsPreview?: string`.** `turn.tool.update` requires it and `react-loop.ts`'s `ToolUpdate` carried no argument data, so the emitter could otherwise only ever send `""`. T1 adds it and populates from `call.function.arguments` truncated to 120 chars. T6's Step 1 pre-flight grep makes its own equivalent step a no-op if T1 already landed it.

**R11 — T6 adds one `confirm` rule to `gateway/mcp-policy.yaml`** (`ha_call_service`). No rule in the tree currently produces a `confirm` decision, so without it the entire permission path — dialog, timeout, fail-closed deny — is unreachable in E2E. This is required for T11/T12 to have anything to test.

**R12 — T2 and T3 are NOT disjoint: both write `gateway/src/runtime/session-runtime.ts`.** The wave table originally called T3 "disjoint from T2" while `task-2-voice.md` claims to be "the only Wave-2 writer of … `gateway/src/runtime/session-runtime.ts`" and `task-3-compaction.md`'s Files section authorizes the same file. All three statements shipped; the collision was real, and it is the root cause of the scope-bleed erratum below. **Ownership split (binding):** T2 owns the `voice` dep, the `speech: TurnVoiceStream | null` field on `InFlightTurn`, and every `voice.begin` / `speech.pushText` / `speech.flush` / `speech.end` call site. T3 owns only the `maybeCompact` call in `onTurnSettled`, its two imports, the module-scope `COMPACTION_SUMMARIZER_PROMPT`, and the compaction paragraph in the file header. **Staging discipline (binding for every remaining wave):** these waves run against ONE shared working tree, so at commit time a task's tree can hold a sibling's uncommitted edits. Stage by explicit path *and* verify `git diff --cached` contains only hunks that task owns — never `git add -A`, and never sweep a file wholesale just because the task's Files list names it. If a sibling's hunks are unavoidably entangled in a shared file, commit them FIRST as their own `type(scope):` commit attributed to that task, then commit yours. The same collision class is latent in T6 ("gateway files freed by T2 landing") and T10 ("re-enters `ws-handlers.ts`/`ws-helpers.ts` after T2 + T6") — treat "freed by" as a sequencing hope, not a guarantee, and re-check before staging.

**Erratum — the T3 commit split (recorded; deliberately not rewritten).** The three compaction commits landed out of the order `task-3-compaction.md` Steps 5/13/18 specify. `c7d1647` (nominally "commit the config surface", whose only `session-runtime.test.ts` content should have been the `testConfig()` extension) already carried the whole Step-14 wiring test, and `5c42caa` ("run compaction at turn end") also carried T2's `session-runtime.ts` voice hunks. Two consequences: `bun test runtime/session-runtime.test.ts` is **red at `c7d1647` and at `2150e22`** — the wiring only lands at `5c42caa` — so neither is individually bisectable, and reverting the compaction feature alone would also revert a slice of T2. HEAD is green and the final tree is correct. History is **not** rewritten: six sibling-task commits from the same wave already sit on top of `5c42caa`, the wave orchestrator addresses those tasks by SHA, and the wave shares one working tree — a rebase would invalidate every downstream SHA and can destroy a concurrently-running sibling's uncommitted work, which is a strictly worse failure than a non-bisectable unpushed feature branch. **Remedy at integration time: squash-merge this branch into `develop`** (or squash `c7d1647..5c42caa` once the wave is provably idle), so the red intermediate states never enter `develop`'s permanent history. Flagged for the plan owner — this is a merge-time decision, not an implementer's to take.

**Erratum — the T5 commit split (recorded; deliberately not rewritten).** Same class as the T3 erratum, different cause: **consumers were committed before the commit that defines the types they consume.** `907601b` rewrites `AudioPipeline.kt` to construct `TurnAudioQueue`, `6830992` wires `PermissionConnector` / `DelegationProgressConnector` into `SdkConnectors.kt` + `SentientSdk.kt`, `41972e5` adds `PermissionPrompt` / `DelegationSnapshotItem`-typed passthroughs to `mobile-data`'s `ChatComponent.kt`, and `afe43bb` edits `PrivacyGuardTest.kt` inside that window — but all three class files (`audioio/TurnAudioQueue.kt`, `connectors/PermissionConnector.kt`, `connectors/DelegationProgressConnector.kt`) land only at `ea87355`. Consequence: `./gradlew :shared:mobile-sdk:testDebugUnitTest` (and the iOS compile gate) fails with `Unresolved reference` at **`907601b`, `6830992`, `41972e5`, `afe43bb`** — `git bisect` across the range is broken and `git revert` of any single one of the four is unsafe. Only `aa4726e`, `ea87355` and HEAD are self-consistent; the final tree is correct and green (713 tests across `mobile-sdk` + `mobile-data`). History is **not** rewritten, for the reasons already recorded above and one more that is decisive: at fix time a sibling task was mid-commit in the shared tree (it landed `8d9838c` + `c2b24cf` during this repair), `git rebase` refuses to start on a dirty tree, and `git stash` / `reset` are forbidden to implementers here — so the rewrite was not merely risky but unavailable. **Remedy: the same squash-merge into `develop`.** **Prevention (binding for the remaining waves):** a commit may not reference a type its own tree does not define — when a task's steps create the consumer before the definition, fold both into ONE commit rather than committing the consumer first; "the step said commit here" is not a green gate, and the plan's per-step `Run: … Expected: green` line must actually be run at that commit.

### Open items carried into execution (not blocking authoring)

- **Hermes is not installed in the gateway Docker image.** `delegateTask`-dependent E2E rows (`delegate-hermes-bg`, `steer-midloop`, `steer-followup-audio`, `interrupt`'s background-cancel arm) may be blocked in `deploy/macos` until Hermes is provisioned inside or alongside the container. T11 carries a pre-flight probe and a documented BLOCKED path rather than assuming it works. **Needs an operator decision if the probe fails.**
- **Barge-in's acoustic mic-onset trigger cannot be driven in headless Chromium** without a fake-media-device capture flag. T11 drives the real UI gesture and falls back; T12 flags the mobile equivalent as follow-up. The mechanism itself is unit/FSM-tested via `cancellation.ts`.
- **`compact_threshold_tokens` defaults to 24000**, chosen against an unverified context window for `gpt-oss:20b-cloud`. Tune once the real window is known.
- **`keep_recent_turns` preserves recent turns verbatim inside the marker text**, losing their `role`/`tool_call_id` structure, because `model-projection.ts` slices positionally. Making the projection slice by `compactedThroughSeq` is the cleaner long-term shape and a small change — deferred, not forgotten.

---

## Task Bodies

One file per task in this directory. Each is independently testable and ends in a commit.
