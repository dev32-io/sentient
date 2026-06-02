# End-to-End Smoke Rules

> When a rule is unclear, read `agents/docs/e2e-testing-details.md`.

E2E smoke is part of feature development, not a follow-up step. A feature is not done until every smoke case is green.

- The agent owns smoke. Drive it via Playwright MCP against the running local stack before declaring a feature done.
- Smoke against a real running stack — local Docker (`deploy/macos/`) is the default. Never smoke against mocks.
- Cover the viewport matrix every run: desktop (1280×900) + mobile-sized (390×844) via `browser_resize`. Real iOS Safari / native mobile browser is out of agent scope; flag any iOS-only case for operator/user follow-up.
- Cover happy AND sad / edge paths — empty states, error fallbacks, concurrent actions, reconnect, cross-tab where applicable.
- Use the project's free credentials (HA, MA, Ollama, web search) for setup. Never burn paid services (Fish Audio, paid LLMs) in smoke unless the feature specifically depends on them.
- Capture evidence: screenshots at decision points, console messages, network requests where contract matters. Save under `.playwright-mcp/` or the feature's screenshot dir.
- A case is green only when the user-visible behavior AND the underlying log trail (no unexpected WARN / ERROR) match the spec.
- Every spec AND every implementation plan MUST contain a concrete e2e matrix INLINE — one row per feature/area touched. A doc with no matrix is a wish, not a spec/plan. Never scatter the matrix into separate files.
- Matrix is a table, fixed columns: `Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail`. Reference reusable cases by short name from `agents/docs/testing-knowledge.md`; don't duplicate bodies.
- Do NOT skip cases. If a case is unreachable in chromium (iOS-Safari-only behavior, real-device sensors, paid-service dependencies), flag it explicitly in handover for follow-up.
- Pi / production smoke is out of agent scope. Verify rebuild + container health + log-level smoke (curl, `docker logs`) only. Playwright runs on the dev machine against the local stack, never against prod.
- Reuse and extend the case library in `agents/docs/testing-knowledge.md`. New reusable cases go there, indexed by the surface they exercise.
- Pre-handover gate: every case green, evidence captured, lint + typecheck + unit-tests clean, deployable artifact built. No partial green.
