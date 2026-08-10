# End-to-End Smoke Rules

> When a rule is unclear, read `agents/docs/e2e-testing-details.md`.

E2E smoke is part of feature development, not a follow-up step. A feature is not done until every smoke case is green.

- The agent owns smoke. Driver by surface: web (webui) → Playwright MCP; native mobile (Android + iOS apps) → Maestro. Drive against the running local stack before declaring a feature done.
- Smoke against a real running stack — `bun run dev` from the repo root (preflight builds the webui, bakes missing addon images, starts the gateway plus vite plus inbound-proxy) in dev, `launchctl` in prod. Never smoke against mocks.
- Native mobile E2E is Maestro against a simulator/emulator (`android` CLI / `adb`, `xcrun simctl`) — NEVER Playwright. Driver, selectors, log trail, and fault-arming live in the details + mobile-testing rules.
- Targeted tag-batch runs are THE execution model: one warm `maestro test` per selected tag set via `qa/mobile/run-e2e.sh --tags <t1,t2>`. NEVER one invocation per flow — cold JVM/device-attach cost is fixed per invocation and dominates at per-flow granularity.
- Plans' and specs' e2e matrices reference native-mobile cases by surface tag (e.g. `settings-voice`, `reconnect`), not by flow filename — tags are the addressable unit.
- New flows MUST carry real `tags:` from the taxonomy (surface + behavior — see `agents/docs/testing-knowledge.md`), a conditional login subflow (`runFlow: { when: ..., file: _helpers/login.yaml }`), and visibility waits ≤3000ms (longer only with an inline comment justifying the wait).
- Authoring workflow: Maestro MCP `inspect_screen` (compact hierarchy) ONCE per new screen → author all flows touching that screen → one batch run → fix residuals. NEVER write → run → dump-hierarchy → fix, one flow at a time.
- Web run covers the viewport matrix: desktop (1280×900) + mobile-sized (390×844) via `browser_resize` — web responsive only. Native app behavior is the Maestro suites, not a resized browser.
- Cover happy AND sad / edge paths — empty states, error fallbacks, concurrent actions, reconnect, cross-tab where applicable.
- Use the project's free credentials (HA, MA, Ollama, web search) for setup. Never burn paid services (paid LLMs) in smoke unless the feature specifically depends on them. STT (local Whisper) and TTS (local-tts / Qwen3-TTS) are BOTH on-host — free, no key or credit to guard; exercise them freely in smoke (the only remaining paid surface is the LLM provider).
- Capture evidence at decision points. Web → screenshots / console / network under the Playwright output dir. Native → Maestro output + simulator/emulator screenshots + the `logcat`/`os_log` trail under the mobile QA dir.
- A case is green only when the user-visible behavior AND the underlying log trail (no unexpected WARN / ERROR) match the spec.
- Every spec AND every implementation plan MUST contain a concrete e2e matrix INLINE — one row per feature/area touched. A doc with no matrix is a wish, not a spec/plan. Never scatter the matrix into separate files.
- Matrix is a table, fixed columns: `Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail`. Reference reusable cases by short name from `agents/docs/testing-knowledge.md`; don't duplicate bodies.
- Do NOT skip cases. If a case is unreachable in chromium (iOS-Safari-only behavior, real-device sensors, paid-service dependencies), flag it explicitly in handover for follow-up.
- **Production is observational-only — the guard binds to the prod *environment*, not a host type** (current prod: the Mac mini `mini0.lan` / `sentient.dev32.io`; formerly the Pi). On ANY prod env, agent actions are read-only: `docker compose ps`, `docker logs`, container/mount inspect, `curl` health. NEVER run Playwright/Maestro, test chats, writes, or data/schema mutation against prod. Rebuild/deploy to prod requires explicit per-action approval. Browser/native E2E runs on the dev machine against the LOCAL stack, never prod. (Note: the dev box and the prod box may BOTH be Macs — "it's a Mac" never means "fair game"; only the *local dev* stack is.)
- Reuse and extend the case library in `agents/docs/testing-knowledge.md`. New reusable cases go there, indexed by the surface they exercise.
- Pre-handover gate: every case green, evidence captured, lint + typecheck + unit-tests clean, deployable artifact built. No partial green.
