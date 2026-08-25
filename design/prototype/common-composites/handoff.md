# Common composites implementation handoff

## Outcome

- Implement the reviewed bounded composites as reusable native patterns for Preact, SwiftUI, and Compose under the authority of `DESIGN.md`.
- Preserve the locked Dusk palette, established typography, elevated-slate material, recessed receivers, semantic state language, and user-friendly type floors.
- Keep these patterns generic and composable. Do not turn the prototype into a shared runtime dependency or expand it into complete pages, chat, calendar, composer, or product-specific workflows.

## Source

- Entry point: `design/prototype/common-composites/index.html`.
- Composite anatomy and responsive review styling: `design/prototype/common-composites/common-composites.css`.
- Reference interactions and transitions: `design/prototype/common-composites/common-composites.js`.
- Foundation snapshot: `design/prototype/common-composites/vendor/`; production implementations must consume native foundation components rather than this copied CSS or JavaScript.
- Durable authority: `DESIGN.md`.
- Primitive contract: `design/prototype/foundation-components/handoff.md`.
- No checkpoint snapshot was created; the current prototype entry point is the reviewed state.

## Behavior

- Page fragments, tabs, breadcrumbs, local navigation, settings groups, rows, filters, forms, and lists recompose without horizontal overflow. Broad rows never shift their content on hover.
- Image- and icon-dominant cards are immediate actions, not persistent selections. Hover uses one coherent face-tension response without bright outlines, nested glows, or competing avatar effects.
- Text rows reserve the trailing-action space and reveal the ellipsis on precise-pointer hover or focus-within. Keyboard and coarse-touch users always retain access without layout movement.
- Dropdowns, menus, disclosures, dialogs, tooltips, and toasts preserve their source relationship, provide predictable dismissal, restore focus where applicable, and use static state changes under Reduced Motion.
- Validation, saving, retry, upload, pagination, incremental loading, skeleton, and stale-content specimens name the current state and preserve useful user input or content during failure.
- Status text pairs explicit language with an elevated semantic light. Information uses sage, attention uses stronger amber, failure uses clay, and no state depends on color, glow, or motion alone.
- Notices use restrained semantic row tint plus a compact elevated icon face. Attention and failure carry more visual weight than ordinary information without side strips or broad solid fills.
- Bulk selection consumes the foundation checkbox, including checked, mixed, focused, and disabled states. The complete text label remains the semantic target.
- Reorderable lists expose a dedicated elevated handle. Support pointer dragging, arrow-key movement while the handle is focused, stable row content, position numbering, and concise live announcements.
- Pin entry uses square keypad keys, clear filled positions, bounded error feedback, and numeric input semantics. Verification codes preserve paste and automatic progression behavior without hiding errors in motion alone.
- Meet platform target minimums, preserve visible keyboard focus, remain usable at 200% web zoom and native large-text settings, and provide intentional Reduced Motion and increased-contrast fallbacks.
- Visible copy never uses all-caps styling. Routine labels and controls use at least 14px; supporting text and ordinary metadata use at least 12.5px.

## Decisions

- The prototype approves bounded composite roles, not page-specific styling or cross-platform pixel identity.
- Cards remain narrowly limited to image/icon-dominant login identity and future media-led entry points. General text content belongs in rows, plates, notices, or other explicit composites.
- Login identity cards proceed immediately and have no persistent selected state.
- Native expanded `<select>` rendering is not a review surface for the float material; production should still use platform-native behavior where it satisfies the semantic and visual contract.
- Semantic color remains localized. Ember is reserved for commitment, focus, selection, and genuine activity; sage, amber, and clay distinguish narrow status roles.
- Meaningful state changes use measured transitions, but spatial continuity must not become decorative animation.
- Chat messages, chat composer controls, calendar surfaces, permission workflows, and complete pages remain separate contextual design work.

## Open

- **No blocker for implementing the reviewed common composites.**
- Platform-specific APIs, component names, and ownership boundaries still need agreement during implementation planning.
- Data virtualization, very large collection performance, and cross-device persistence for reordered lists are not defined by this visual prototype.
- File upload security, file-type policy, cancellation, retry persistence, and backend progress contracts remain product/implementation decisions.
- Dialog and sheet content for product-specific permission or destructive workflows requires contextual review rather than direct reuse of the generic shell.
- Explicit browser smoke at 200% zoom and native large-text evaluation remains required during production implementation.
