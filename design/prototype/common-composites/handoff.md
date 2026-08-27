# Common composites handoff

## Outcome

- Implement the approved bounded composites as native Preact, SwiftUI, and Compose patterns under `DESIGN.MD`.
- Treat each isolated PNG below as the visual authority for one implementation-preview target. Each PNG has a transparent surrounding canvas; any plate or well retained inside the crop is part of the composite’s reviewed anatomy, not image background. Composite the PNG on the canonical Dusk canvas when reviewing contrast, float separation, and directional depth.
- Keep these patterns generic and composable. Do not expand them into complete pages, chat, composer, calendar, permission workflows, or product-specific flows.

## Prototype

- Entry point: `design/prototype/common-composites/index.html`.
- Composite anatomy and responsive behavior: `design/prototype/common-composites/common-composites.css`.
- Reference interactions and transitions: `design/prototype/common-composites/common-composites.js`.
- Local foundation snapshot: `design/prototype/common-composites/vendor/`; production must use native foundation components rather than this copied CSS or JavaScript.
- Primitive visual contract: `design/prototype/foundation-components/handoff.md`.

## Static references

### Pane header

- `design/prototype/common-composites/handoff/static/pane-header--preferences--rest.png` — Pane header reference: preferences; rest.

### Tabs

- `design/prototype/common-composites/handoff/static/tabs--preference-sections--advanced-selected.png` — Tabs reference: preference sections; advanced selected.
- `design/prototype/common-composites/handoff/static/tabs--preference-sections--general-selected.png` — Tabs reference: preference sections; general selected.
- `design/prototype/common-composites/handoff/static/tabs--preference-sections--privacy-focus.png` — Tabs reference: preference sections; privacy focus.
- `design/prototype/common-composites/handoff/static/tabs--preference-sections--privacy-selected.png` — Tabs reference: preference sections; privacy selected.

### Breadcrumb bar

- `design/prototype/common-composites/handoff/static/breadcrumb-bar--preferences--compact.png` — Breadcrumb bar reference: preferences; compact.
- `design/prototype/common-composites/handoff/static/breadcrumb-bar--preferences--desktop.png` — Breadcrumb bar reference: preferences; desktop.

### Mobile header

- `design/prototype/common-composites/handoff/static/mobile-header--privacy--rest.png` — Mobile header reference: privacy; rest.

### Local navigation

- `design/prototype/common-composites/handoff/static/local-navigation--settings--account-current.png` — Local navigation reference: settings; account current.
- `design/prototype/common-composites/handoff/static/local-navigation--settings--general-current.png` — Local navigation reference: settings; general current.
- `design/prototype/common-composites/handoff/static/local-navigation--settings--privacy-current.png` — Local navigation reference: settings; privacy current.
- `design/prototype/common-composites/handoff/static/local-navigation--settings--privacy-focus.png` — Local navigation reference: settings; privacy focus.
- `design/prototype/common-composites/handoff/static/local-navigation--settings--privacy-hover.png` — Local navigation reference: settings; privacy hover.

### Settings group

- `design/prototype/common-composites/handoff/static/settings-group--general--rest.png` — Settings group reference: general; rest.

### Setting row

- `design/prototype/common-composites/handoff/static/setting-row--range--62.png` — Setting row reference: range; 62.
- `design/prototype/common-composites/handoff/static/setting-row--segmented--default-selected.png` — Setting row reference: segmented; default selected.
- `design/prototype/common-composites/handoff/static/setting-row--segmented--expert-selected.png` — Setting row reference: segmented; expert selected.
- `design/prototype/common-composites/handoff/static/setting-row--select--english-closed.png` — Setting row reference: select; english closed.
- `design/prototype/common-composites/handoff/static/setting-row--select--english-open.png` — Setting row reference: select; english open.
- `design/prototype/common-composites/handoff/static/setting-row--select--spanish-selected.png` — Setting row reference: select; spanish selected.
- `design/prototype/common-composites/handoff/static/setting-row--toggle--off.png` — Setting row reference: toggle; off.
- `design/prototype/common-composites/handoff/static/setting-row--toggle--on.png` — Setting row reference: toggle; on.

### Settings editor

- `design/prototype/common-composites/handoff/static/settings-editor--vertical--saved.png` — Settings editor reference: vertical; saved.
- `design/prototype/common-composites/handoff/static/settings-editor--vertical--unsaved.png` — Settings editor reference: vertical; unsaved.

### Media action card

- `design/prototype/common-composites/handoff/static/media-action-card--icon--focus.png` — Media action card reference: icon; focus.
- `design/prototype/common-composites/handoff/static/media-action-card--icon--hover.png` — Media action card reference: icon; hover.
- `design/prototype/common-composites/handoff/static/media-action-card--icon--rest.png` — Media action card reference: icon; rest.
- `design/prototype/common-composites/handoff/static/media-action-card--image--focus.png` — Media action card reference: image; focus.
- `design/prototype/common-composites/handoff/static/media-action-card--image--hover.png` — Media action card reference: image; hover.
- `design/prototype/common-composites/handoff/static/media-action-card--image--rest.png` — Media action card reference: image; rest.
- `design/prototype/common-composites/handoff/static/media-action-card--user-sage--focus.png` — Media action card reference: user sage; focus.
- `design/prototype/common-composites/handoff/static/media-action-card--user-sage--hover.png` — Media action card reference: user sage; hover.
- `design/prototype/common-composites/handoff/static/media-action-card--user-sage--rest.png` — Media action card reference: user sage; rest.
- `design/prototype/common-composites/handoff/static/media-action-card--user-terra--focus.png` — Media action card reference: user terra; focus.
- `design/prototype/common-composites/handoff/static/media-action-card--user-terra--hover.png` — Media action card reference: user terra; hover.
- `design/prototype/common-composites/handoff/static/media-action-card--user-terra--rest.png` — Media action card reference: user terra; rest.

### Pin entry

- `design/prototype/common-composites/handoff/static/pin-entry--4-digit--checking-reduced-motion.png` — Pin entry reference: 4 digit; checking reduced motion.
- `design/prototype/common-composites/handoff/static/pin-entry--4-digit--checking.png` — Pin entry reference: 4 digit; checking.
- `design/prototype/common-composites/handoff/static/pin-entry--4-digit--empty.png` — Pin entry reference: 4 digit; empty.
- `design/prototype/common-composites/handoff/static/pin-entry--4-digit--one-digit.png` — Pin entry reference: 4 digit; one digit.
- `design/prototype/common-composites/handoff/static/pin-entry--4-digit--partial.png` — Pin entry reference: 4 digit; partial.
- `design/prototype/common-composites/handoff/static/pin-entry--4-digit--success.png` — Pin entry reference: 4 digit; success.

### Verification code

- `design/prototype/common-composites/handoff/static/verification-code--empty--focus.png` — Verification code reference: empty; focus.
- `design/prototype/common-composites/handoff/static/verification-code--empty--rest.png` — Verification code reference: empty; rest.
- `design/prototype/common-composites/handoff/static/verification-code--filled--rest.png` — Verification code reference: filled; rest.

### Rate-limit notice

- `design/prototype/common-composites/handoff/static/rate-limit-notice--verification--rest.png` — Rate-limit notice reference: verification; rest.

### Identity list row

- `design/prototype/common-composites/handoff/static/identity-list-row--invited--rest.png` — Identity list row reference: invited; rest.
- `design/prototype/common-composites/handoff/static/identity-list-row--navigable--focus.png` — Identity list row reference: navigable; focus.
- `design/prototype/common-composites/handoff/static/identity-list-row--navigable--hover.png` — Identity list row reference: navigable; hover.
- `design/prototype/common-composites/handoff/static/identity-list-row--navigable--rest.png` — Identity list row reference: navigable; rest.
- `design/prototype/common-composites/handoff/static/identity-list-row--selected--rest.png` — Identity list row reference: selected; rest.

### Overflow action row

- `design/prototype/common-composites/handoff/static/overflow-action-row--current--rest.png` — Overflow action row reference: current; rest.
- `design/prototype/common-composites/handoff/static/overflow-action-row--long-title--rest.png` — Overflow action row reference: long title; rest.
- `design/prototype/common-composites/handoff/static/overflow-action-row--plain--coarse-rest.png` — Overflow action row reference: plain; coarse rest.
- `design/prototype/common-composites/handoff/static/overflow-action-row--plain--focus-within.png` — Overflow action row reference: plain; focus within.
- `design/prototype/common-composites/handoff/static/overflow-action-row--plain--hover.png` — Overflow action row reference: plain; hover.
- `design/prototype/common-composites/handoff/static/overflow-action-row--plain--rest.png` — Overflow action row reference: plain; rest.

### Overflow menu

- `design/prototype/common-composites/handoff/static/overflow-menu--open-archive--open.png` — Overflow menu reference: open archive; open.
- `design/prototype/common-composites/handoff/static/overflow-menu--rename-duplicate-delete--open.png` — Overflow menu reference: rename duplicate delete; open.
- `design/prototype/common-composites/handoff/static/overflow-menu--view-details-copy--open.png` — Overflow menu reference: view details copy; open.

### Reorderable list

- `design/prototype/common-composites/handoff/static/reorderable-list--dragging.png` — Reorderable list reference: dragging.
- `design/prototype/common-composites/handoff/static/reorderable-list--drop-target.png` — Reorderable list reference: drop target.
- `design/prototype/common-composites/handoff/static/reorderable-list--keyboard-moved.png` — Reorderable list reference: keyboard moved.
- `design/prototype/common-composites/handoff/static/reorderable-list--saved--rest.png` — Reorderable list reference: saved; rest.

### Filter bar

- `design/prototype/common-composites/handoff/static/filter-bar--default--compact.png` — Filter bar reference: default; compact.
- `design/prototype/common-composites/handoff/static/filter-bar--default.png` — Filter bar reference: default.
- `design/prototype/common-composites/handoff/static/filter-bar--offline-selected.png` — Filter bar reference: offline selected.
- `design/prototype/common-composites/handoff/static/filter-bar--ready-selected.png` — Filter bar reference: ready selected.
- `design/prototype/common-composites/handoff/static/filter-bar--shared-selected.png` — Filter bar reference: shared selected.
- `design/prototype/common-composites/handoff/static/filter-bar--sort-open.png` — Filter bar reference: sort open.

### Notice

- `design/prototype/common-composites/handoff/static/notice--error--compact.png` — Notice reference: error; compact.
- `design/prototype/common-composites/handoff/static/notice--error--rest.png` — Notice reference: error; rest.
- `design/prototype/common-composites/handoff/static/notice--info--rest.png` — Notice reference: info; rest.
- `design/prototype/common-composites/handoff/static/notice--warning--compact.png` — Notice reference: warning; compact.
- `design/prototype/common-composites/handoff/static/notice--warning--rest.png` — Notice reference: warning; rest.

### Loading state

- `design/prototype/common-composites/handoff/static/loading-state--settings--active.png` — Loading state reference: settings; active.
- `design/prototype/common-composites/handoff/static/loading-state--settings--reduced-motion.png` — Loading state reference: settings; reduced motion.

### Empty state

- `design/prototype/common-composites/handoff/static/empty-state--settings--rest.png` — Empty state reference: settings; rest.

### Stale banner

- `design/prototype/common-composites/handoff/static/stale-banner--saved-results--checking.png` — Stale banner reference: saved results; checking.
- `design/prototype/common-composites/handoff/static/stale-banner--saved-results--rest.png` — Stale banner reference: saved results; rest.

### Status text

- `design/prototype/common-composites/handoff/static/status-text--attention--rest.png` — Status text reference: attention; rest.
- `design/prototype/common-composites/handoff/static/status-text--error--rest.png` — Status text reference: error; rest.
- `design/prototype/common-composites/handoff/static/status-text--live--reduced-motion.png` — Status text reference: live; reduced motion.
- `design/prototype/common-composites/handoff/static/status-text--live--rest.png` — Status text reference: live; rest.
- `design/prototype/common-composites/handoff/static/status-text--offline--rest.png` — Status text reference: offline; rest.
- `design/prototype/common-composites/handoff/static/status-text--ready--rest.png` — Status text reference: ready; rest.

### Apply bar

- `design/prototype/common-composites/handoff/static/apply-bar--applying--active.png` — Apply bar reference: applying; active.
- `design/prototype/common-composites/handoff/static/apply-bar--dirty--rest.png` — Apply bar reference: dirty; rest.
- `design/prototype/common-composites/handoff/static/apply-bar--done--success.png` — Apply bar reference: done; success.

### Disclosure

- `design/prototype/common-composites/handoff/static/disclosure--advanced-options--closed.png` — Disclosure reference: advanced options; closed.
- `design/prototype/common-composites/handoff/static/disclosure--advanced-options--open.png` — Disclosure reference: advanced options; open.
- `design/prototype/common-composites/handoff/static/disclosure--data-storage--closed.png` — Disclosure reference: data storage; closed.
- `design/prototype/common-composites/handoff/static/disclosure--data-storage--open.png` — Disclosure reference: data storage; open.

### Context menu

- `design/prototype/common-composites/handoff/static/context-menu--settings--first-item-focus.png` — Context menu reference: settings; first item focus.
- `design/prototype/common-composites/handoff/static/context-menu--settings--open.png` — Context menu reference: settings; open.

### Tooltip

- `design/prototype/common-composites/handoff/static/tooltip--help--visible.png` — Tooltip reference: help; visible.

### Dialog

- `design/prototype/common-composites/handoff/static/dialog--confirm-change--desktop-open.png` — Dialog reference: confirm change; desktop open.
- `design/prototype/common-composites/handoff/static/dialog--confirm-change--mobile-sheet.png` — Dialog reference: confirm change; mobile sheet.

### Toast

- `design/prototype/common-composites/handoff/static/toast--saved--compact-visible.png` — Toast reference: saved; compact visible.
- `design/prototype/common-composites/handoff/static/toast--saved--desktop-visible.png` — Toast reference: saved; desktop visible.

### Validated field group

- `design/prototype/common-composites/handoff/static/validated-field-group--mixed-validation--rest.png` — Validated field group reference: mixed validation; rest.

### Validated field

- `design/prototype/common-composites/handoff/static/validated-field--confirmation--error.png` — Validated field reference: confirmation; error.
- `design/prototype/common-composites/handoff/static/validated-field--recovery-phrase--valid.png` — Validated field reference: recovery phrase; valid.
- `design/prototype/common-composites/handoff/static/validated-field--supporting-note--counter.png` — Validated field reference: supporting note; counter.

### Inline secret editor

- `design/prototype/common-composites/handoff/static/inline-secret-editor--access-key--editing.png` — Inline secret editor reference: access key; editing.
- `design/prototype/common-composites/handoff/static/inline-secret-editor--access-key--read.png` — Inline secret editor reference: access key; read.
- `design/prototype/common-composites/handoff/static/inline-secret-editor--access-key--saving.png` — Inline secret editor reference: access key; saving.
- `design/prototype/common-composites/handoff/static/inline-secret-editor--managed-value--disabled.png` — Inline secret editor reference: managed value; disabled.

### Stepper

- `design/prototype/common-composites/handoff/static/stepper--step-1--current.png` — Stepper reference: step 1; current.
- `design/prototype/common-composites/handoff/static/stepper--step-2--current-compact.png` — Stepper reference: step 2; current compact.
- `design/prototype/common-composites/handoff/static/stepper--step-2--current.png` — Stepper reference: step 2; current.
- `design/prototype/common-composites/handoff/static/stepper--step-3--current.png` — Stepper reference: step 3; current.
- `design/prototype/common-composites/handoff/static/stepper--step-4--current.png` — Stepper reference: step 4; current.

### File upload

- `design/prototype/common-composites/handoff/static/file-upload--drop-zone--dragging.png` — File upload reference: drop zone; dragging.
- `design/prototype/common-composites/handoff/static/file-upload--drop-zone--focus.png` — File upload reference: drop zone; focus.
- `design/prototype/common-composites/handoff/static/file-upload--selected--64-percent.png` — File upload reference: selected; 64 percent.
- `design/prototype/common-composites/handoff/static/file-upload--uploaded--success.png` — File upload reference: uploaded; success.
- `design/prototype/common-composites/handoff/static/file-upload--uploading--40-percent.png` — File upload reference: uploading; 40 percent.

### Results list

- `design/prototype/common-composites/handoff/static/results-list--appended.png` — Results list reference: appended.
- `design/prototype/common-composites/handoff/static/results-list--loading-more.png` — Results list reference: loading more.
- `design/prototype/common-composites/handoff/static/results-list--page-1--compact.png` — Results list reference: page 1; compact.
- `design/prototype/common-composites/handoff/static/results-list--page-1.png` — Results list reference: page 1.

### Skeleton list

- `design/prototype/common-composites/handoff/static/skeleton-list--loading.png` — Skeleton list reference: loading.
- `design/prototype/common-composites/handoff/static/skeleton-list--reduced-motion.png` — Skeleton list reference: reduced motion.

### No-results state

- `design/prototype/common-composites/handoff/static/no-results--empty.png` — No-results state reference: empty.

### Bulk selection

- `design/prototype/common-composites/handoff/static/bulk-selection--all-selected.png` — Bulk selection reference: all selected.
- `design/prototype/common-composites/handoff/static/bulk-selection--mixed-selected.png` — Bulk selection reference: mixed selected.
- `design/prototype/common-composites/handoff/static/bulk-selection--none-selected.png` — Bulk selection reference: none selected.

### Responsive data table

- `design/prototype/common-composites/handoff/static/responsive-data-table--compact.png` — Responsive data table reference: compact.
- `design/prototype/common-composites/handoff/static/responsive-data-table--desktop.png` — Responsive data table reference: desktop.

### Responsive data row

- `design/prototype/common-composites/handoff/static/responsive-data-row--attention--desktop.png` — Responsive data row reference: attention; desktop.
- `design/prototype/common-composites/handoff/static/responsive-data-row--offline--desktop.png` — Responsive data row reference: offline; desktop.
- `design/prototype/common-composites/handoff/static/responsive-data-row--ready--desktop.png` — Responsive data row reference: ready; desktop.

## Motion references

Frames are ordered by filename. Every frame preserves one composite boundary.

- `design/prototype/common-composites/handoff/recordings/apply-bar--dirty-to-done/` — Apply bar moving from dirty through applying to success.
- `design/prototype/common-composites/handoff/recordings/dialog--open-desktop/` — Desktop dialog entering from its source.
- `design/prototype/common-composites/handoff/recordings/dialog--open-mobile/` — Compact dialog entering as a bottom sheet.
- `design/prototype/common-composites/handoff/recordings/disclosure--closed-to-open/` — Disclosure expanding from its summary.
- `design/prototype/common-composites/handoff/recordings/file-upload--progress/` — Upload progress moving from zero to completion.
- `design/prototype/common-composites/handoff/recordings/inline-secret-editor--read-to-edit/` — Inline secret editor changing from read view to editing.
- `design/prototype/common-composites/handoff/recordings/local-navigation--general-to-privacy/` — Local-navigation selection moving from General to Privacy.
- `design/prototype/common-composites/handoff/recordings/overflow-menu--open/` — Overflow menu opening from its row action.
- `design/prototype/common-composites/handoff/recordings/pin-entry--complete-to-success/` — Pin entry progressing through completion, checking, and success.
- `design/prototype/common-composites/handoff/recordings/reorderable-list--keyboard-move/` — Keyboard reorder moving an item to its new position.
- `design/prototype/common-composites/handoff/recordings/results-list--loading-to-appended/` — Incremental results changing from loading to an appended row.
- `design/prototype/common-composites/handoff/recordings/select--closed-to-open/` — Select popup opening from its trigger.
- `design/prototype/common-composites/handoff/recordings/skeleton-list--shimmer/` — Representative skeleton loading cycle.
- `design/prototype/common-composites/handoff/recordings/status-text--live-pulse/` — Representative live-status pulse.
- `design/prototype/common-composites/handoff/recordings/stepper--step-2-to-step-3/` — Stepper continuity from the second step to the third.
- `design/prototype/common-composites/handoff/recordings/tabs--general-to-privacy/` — Tab selection moving from General to Privacy.
- `design/prototype/common-composites/handoff/recordings/toast--open/` — Toast entering from its anchored corner.

## Behavior and accessibility

- Preserve native semantics, platform target minimums, visible keyboard focus, predictable dismissal, focus containment where applicable, and focus restoration after temporary surfaces close. Hover is supplementary and never required to discover an action.
- Broad rows keep text and icons fixed during hover and selection. Overflow actions reserve their space; precise-pointer reveal does not move row content, and coarse input retains visible access.
- Media action cards continue immediately and have no persistent selected state. Their dominant visual, label, and one coherent hover response remain a single action target.
- Tabs and local navigation move one continuous selection surface. Menus, selects, disclosures, dialogs, tooltips, and toasts preserve their spatial source; Reduced Motion uses an immediate complete state.
- Status text and notices pair plain language with icon, shape, or elevation so meaning never depends on semantic color, glow, or motion alone. Validation, stale content, loading, saving, upload, and apply states preserve useful content and name what is happening.
- Reorderable lists expose a dedicated handle, support pointer and arrow-key movement, update position labels, and announce the result concisely. Reordering never depends on animation or gesture discovery.
- Pin entry preserves numeric keyboard behavior, deletion, progress announcements, and automatic submission on completion. Verification codes preserve paste, autofill, numeric filtering, explicit submission, and entered content during rate limiting.
- Bulk selection uses native checkbox semantics, including mixed and disabled states. Complete visible labels remain part of their semantic targets. Responsive data rows expose equivalent labels and actions when columns stack.
- Visible copy never uses all-caps styling. Routine controls remain at least 14px and supporting text at least 12.5px; the 11px step is optional expert telemetry only.
- Validate production implementations at 200% web zoom, native large-text settings, Reduced Motion, and increased contrast. Compact references document approved recomposition, not a cross-platform page shell.

## Exceptions and open boundaries

- The current Pin fixture does not provide an approved error appearance; implementations still require bounded, explicit error recovery before shipping that state.
- Verification invalid, submitting, and success appearances are not approved by this prototype.
- Upload failure, retry, cancellation, security policy, file-type policy, persistence, and backend progress contracts remain product and implementation decisions.
- Stepper blocked-state appearance, data virtualization, very large collection performance, and cross-device reorder persistence are not defined here.
- Product-specific permission and destructive dialog content requires contextual review rather than direct reuse of the generic shell.
- Platform-specific APIs, component names, and ownership boundaries remain implementation decisions.
