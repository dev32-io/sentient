# Testing Rules

> When a rule is unclear, read `agents/docs/testing-details.md`.

Tests exist as a defensive mechanism against model drift. A test is worth keeping ONLY if it pins one of:

- **Wire / protocol contract** at a process boundary (gateway↔SDK, gateway↔Hermes, gateway↔MCP, STT/TTS provider wire).
- **FSM / invariant** with a documented learning in `agents/docs/*-details.md` or `agents/docs/learnings.md`.
- **Security boundary** (auth, token verification, prompt injection defense, log sanitization).
- **`@live` flow** (vitest test against a real service — STT, TTS, Hermes — kept separate from the unit suite, gated on credentials).

Do NOT write a test for: pure utilities, factory wiring, DI plumbing, TypeScript types, constants, CSS class names, copy strings, or internal collaborators of the unit under test. If a failure mode would surface at the next consumer or in smoke, no unit test is needed.

- Connector / wire-protocol tests MUST mock the exact message types the server emits, not a convenient envelope. Mocks that drift from protocol reality hide silent production failures that only surface in browser smoke.
- Borderline tests get deleted, not kept.
- Browser / end-to-end smoke is owned by the agent and driven by Playwright MCP — see `.claude/rules/e2e-testing.md`. The reusable case library lives in `agents/docs/testing-knowledge.md`.

## Voice Pipeline Test Philosophy

- State machines are the source of truth. Every behavior traces to a state transition.
- Test the contract, not the wiring. Feed typed inputs, assert typed outputs. Never mock internals.
- Pure functions don't need mocks. State machines, classifiers, resolvers, codecs — test directly.
- Zero-cost by default. No API keys in any unit test. `@live` tests are the exception and run separately.
- Test sad paths harder than happy path. Barge-in, disconnect, timeout, double-event, abort-during-transition.
- Exhaustiveness over coverage %. Verify every reachable state is reachable, every state has an exit, every waiting state has timeout guard.
