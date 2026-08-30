# Web toast wave 4 evidence

## Outcome

Implemented and verified the production Web toast owner. No iOS or prototype/reference files were changed.

## Authority mapping

- **Reuse:** `ToastProvider` remains the owner of the append-only queue, `success | error` tones, 4000ms visible lifetime, manual dismissal API, and existing consumers. Existing Dusk tokens, `Icon`, and reverse-column stacking are reused.
- **Extend:** entries gain an optional supporting detail and an internal `visible | closing` phase. `show(message, tone?)` remains source-compatible; `detail` is an optional third argument. The host now uses the approved icon/title/detail/dedicated-dismiss anatomy and `role="status"`, `aria-live="polite"`, `aria-atomic="true"` semantics.
- **New local:** `components/common/toast.css` owns toast-only float material, 250ms corner-origin enter, 150ms exit, focus treatment, safe-area-aware responsive placement, contrast fallback, and Reduced Motion fallback.
- **Platform adaptation:** production keeps its existing 4000ms auto-dismiss trigger and multi-toast stacking because the handoff does not own production queue policy. Existing one-line consumer messages render as titles; supporting detail remains optional. Error keeps the production-owned tone and receives a non-color icon signal, but is not registered as an authority-backed visual-diff state because no generic error PNG exists.

## Visual gate

Profile: Web ODiff `0.56`, visible-alpha-union `<= 0.2%`, Dusk `#2B2621`, anti-aliasing ignored.

- Desktop visible: pass, `diffPercentage=0`, `diffCount=1`.
- Compact visible: pass, `diffPercentage=0`, `diffCount=1`.
- Open frames 0/62/125/188/250ms: all pass; counts `0/0/0/0/1`, each `diffPercentage=0`.
- Responsive/a11y probe: zero horizontal overflow at desktop, narrow, effective 200% browser-zoom viewport, and Reduced Motion configurations; status/live/atomic semantics and labelled dismiss control present; visible focus confirmed; Reduced Motion reports no animation.

## Checks

- Focused toast + visual registry tests: 55 passed.
- Full Web unit suite: 54 files, 387 tests passed.
- Web typecheck: passed.
- Web production build: passed (existing chunk-size advisory only).
- Visual tool tests: 10 passed.
- Design inventory check: passed.
- Design foundation generation/Web boundary checks: passed; aggregate command remains red on pre-existing iOS design-boundary violations outside this Web-only worktree.
- Full repository lint completed with pre-existing calendar non-null-assertion warnings; no toast diagnostic.
- `git diff --check`: passed.
