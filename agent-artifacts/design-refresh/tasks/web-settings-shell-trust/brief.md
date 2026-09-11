# Task Brief: Refresh the Web Settings shell, account/admin panes, and Diagnostics trust boundary

## Contribution Goal

Migrate Settings navigation, apply feedback, account/member/secret/get-app states, and technical status presentation to shared components while keeping authorization and persistence unchanged.

## Boundary — Included

- Settings page/pane/sidebar responsive shell, dirty/apply/restart feedback, Account, Get the app, Members, Secrets, Diagnostics, service readiness hooks/presentation, role-aware navigation, and trust-safe copy.

## Required Work

- 1. Migrate settings-view, sidebar, apply bar, and owned panes to web-foundation-components. Keep desktop sidebar and narrow native-feeling pane navigation usable at 200% zoom; essential actions remain visible and focus restores on pane/overlay dismissal.
- 2. Preserve draft ownership, dirty indicators, batched apply, applying/applied/already-applying/failure/retry states, reload persistence, and the existing APPLY_BAR_KEYS behavior. Do not move settings data into local duplicate stores.
- 3. Preserve Account identity/PIN behavior, Get-app coming-soon/download behavior, Members loading/not-admin/roster/slot cap/add/promote/demote/delete confirmations, and Secrets presence-only/edit/apply feedback. Never render/log secret values, PINs, tokens, or credentials.
- 4. Keep admin navigation presentation-only: navGroupsFor may hide admin panes, but backend authorization remains authoritative. Add tests for admin and non-admin rendering and 403 recovery.
- 5. Remove implementation names/versions from SidebarStatus and ordinary pane labels/copy. Add an explicit Diagnostics destination using existing use-service-versions/use-system-readiness data where appropriate; Diagnostics may show sanitized component names, versions, unknown/unavailable states, and recovery details without claiming readiness that is not observed.
- 6. Update stale QA expectations that require Hermes in ordinary Settings. Tools/Memory household copy is handled by web-settings-soul-voice, but this task owns the navigation/status contract and new Diagnostics selectors.
- 7. Use no page-local colors/type/radii/shadows/motion. Create task-owned CSS rather than editing soul-pane style files. Keep visible unfinished controls intentional and nonfunctional.
- 8. Add focused tests for navigation groups, responsive pane transitions, dirty/apply state machine, harmless setting persistence seam, account PIN validation states, member authorization, secret presence-only rendering, Diagnostics unknown/failure/version states, and absence of ordinary-navigation implementation names.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Settings root is gateway/webui/src/components/settings/settings-view.tsx; nav ownership is sidebar/nav-config.ts, sidebar-nav.tsx, sidebar-status.tsx; apply ownership is apply-bar/**.
- This task owns panes/account-pane.tsx, members-pane.tsx, secrets-pane.tsx, secret-row.tsx, get-app-pane.tsx, and a new Diagnostics pane. Soul/Voice panes are owned by web-settings-soul-voice.
- Current sidebar-status and use-service-versions expose Sentient/Hermes/STT/TTS names and versions in ordinary navigation. Technical implementation names belong in Diagnostics, not household navigation.

## Boundary — Excluded

- Memory/Personalities/Voice/Audio/Model/Tools/System Prompt/Advanced pane internals
- Chat, Calendar, shell app.tsx, backend settings APIs, or authorization redesign
- New behavior for coming-soon controls
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes shared settings primitives/common composites and existing settings data hooks.
- Produces refreshed settings shell and trust-safe Diagnostics while retaining existing pane contracts for the soul/voice task.
