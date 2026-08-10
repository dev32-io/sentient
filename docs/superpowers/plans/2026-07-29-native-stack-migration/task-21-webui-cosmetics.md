### Task 21: the three cosmetic findings from E2E round 2

**Wave 11 · model: sonnet · no behaviour changes, all user-visible**

Evidence: `docs/native-todo.md` § 1 (*Small code and documentation debt*), and `qa/web/evidence/2026-08-01-e2e-round-2/group-e-mobile-390.md` / `group-b-model-and-settings.md`.

**Files:** `gateway/webui/src/styles/components.css`, `gateway/webui/src/components/settings/settings-view.tsx`, `gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts`.

---

- [ ] **Step 1 — a long unbroken token is clipped instead of wrapping**

`components.css:417` sets `.message-bubble__text-wrap { overflow: hidden }` and nothing in `.bubble-text__md` (lines ~447-496) sets `overflow-wrap` / `word-break`. A bare URL in a reply simply disappears past the edge of the bubble — not wrapped, not scrollable, **gone**.

The fix pattern is already in the same file: `.tool-inline-detail__preview` (line ~592) uses `overflow-wrap: anywhere`. Apply the same to the bubble text. Match the existing approach; do not invent a new one.

**Carry the oracle lesson into whatever check you write.** The page-level `document.documentElement.scrollWidth <= window.innerWidth` test **passes** on this defect, because `overflow: hidden` suppresses the very scroll the check looks for. It was only found by walking the ancestor chain and comparing each element's `scrollWidth` against its `clientWidth`. An oracle that cannot fail on the defect is not an oracle.

- [ ] **Step 2 — "Apply & Restart" restarts nothing**

The Model pane's button says **"Apply & Restart"** and the surrounding copy says *"Agent will restart to apply."* Nothing restarts: `apply/orchestrator.ts` says so in its own comment (*"there is no process to restart"*), and three measured applies took **8-12 ms**.

Fix the user-facing copy, and the stale doc-comments in `settings-view.tsx` and `apply-bar/apply-bar-machine.ts` that still describe the retired Hermes-worker restart pipeline. A comment describing a deleted mechanism is how the `delegateTask` and `mcp-policy` false rationales survived — do not leave a third.

Keep the apply-bar's dirty-gating contract exactly as it is: visible iff a Soul-group field is dirty, never on Account/Members. It is verified and it is an oracle in `qa/web/oracles.md`.

- [ ] **Step 3 — composer tap targets at phone width**

Measured at 390×844: voice control 32×32, mute 32×32, send 28×28 — shrunk further by `@media (max-width: 620px)` (`components.css:~1240`) from an already-sub-44px desktop default.

All three clear WCAG 2.5.8 AA's 24 px floor, so this is comfort, not compliance. Raise the **touch target** toward 44 px at phone widths without necessarily growing the icon — padding and a larger hit area achieve it while leaving the visual design alone.

Check the composer still fits at 390 px with the enlarged targets. If a genuine trade-off appears between fitting the row and hitting 44 px, say what you chose and why rather than silently picking one.

- [ ] **Step 4 — verify live at both viewports**

As **Ada** (PIN `1234`), at 1280×900 **and** 390×844:
- ask for something whose answer contains a long URL, and confirm it wraps rather than vanishing — check `scrollWidth` vs `clientWidth` on the bubble's own subtree, not just the page;
- open Settings → Model and confirm the copy no longer promises a restart, and that apply still works;
- confirm the composer controls are comfortably tappable and nothing is clipped.

Screenshots at each into `qa/web/evidence/2026-08-01-e2e-round-2/`.

- [ ] **Step 5 — gate, commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/webui && bun run test 2>&1 | tail -4)
```
