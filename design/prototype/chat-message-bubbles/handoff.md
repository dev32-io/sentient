# Chat message bubbles implementation handoff

## Outcome

- Implement the reviewed assistant and user message language as a calm, readable conversation surface under the authority of `DESIGN.md`.
- Preserve clear role, identity, chronology, streaming, completion, and interruption without turning messages into generic cards or attaching unrelated tool activity.
- Keep Preact, SwiftUI, and Compose implementations native. The prototype is a visual, semantic, responsive, and motion contract—not a shared runtime dependency.
- Keep composer controls, task strips, tool details, permissions, navigation, and complete-page layout outside this implementation scope.

## Source

- Entry point: `design/prototype/chat-message-bubbles/index.html`.
- Message anatomy, material, responsive behavior, and motion: `design/prototype/chat-message-bubbles/chat-message-bubbles.css`.
- Interactive state and streaming simulation: `design/prototype/chat-message-bubbles/chat-message-bubbles.js`.
- Foundation snapshot: `design/prototype/chat-message-bubbles/vendor/`; production must consume native foundation components and canonical identity assets rather than copied prototype code.
- Durable authority: `DESIGN.md`.
- Primitive contract: `design/prototype/foundation-components/handoff.md`.
- Visual inspiration only: `sentient-design/sentient-responsive-prototype.html` and `sentient-design/sentient-responsive-mobile- prototype.html`.
- Current web behavior: `gateway/webui/src/components/chat/message-bubble.tsx`, `gateway/webui/src/components/chat/bubble-text.tsx`, and `gateway/webui/src/components/chat/interrupt-chip.tsx`.
- Current cross-platform reveal contract: `shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/RevealReducer.kt`.
- No checkpoint snapshot was created; the current prototype entry point is the reviewed state.

## Behavior

- Every message exposes role, author, and chronology semantically. Visible metadata remains only `Sentient · <time>` or `<person> · <time>`; thinking, responding, and completion do not add visible state badges above the bubble.
- Assistant identity uses the canonical idle, thinking, and responding artwork. User identity consumes the reviewed elevated-slate avatar primitive, preserves one tint per person, and uses only the approved `44` and `28` size tiers.
- Assistant and user faces share the same plate physics while retaining mirrored corner and tint treatment. User messages align toward the sending side; assistant messages preserve the primary reading edge.
- Ordinary content uses the established 15px body measure. Rich content supports sanitized headings, paragraphs, emphasis, lists, links, code, and long-token wrapping without changing the message’s semantic container.
- Thinking uses the thinking artwork plus an accessible status announcement. Responding uses the responding artwork, a streaming caret, progressively revealed text, and a directional ember cast that breathes on the artwork’s `1.55s` cycle.
- A responding bubble keeps one stable responsive width—up to `62ch` and bounded by the available mobile width. New text only increases block size. A separate visual surface grows behind naturally laid-out text so no line is clipped while height transitions.
- The prototype reveal carries fractional character progress between animation frames and slows as it approaches the available content. Production must preserve the existing no-stall/no-loss reveal invariant rather than copying prototype timing constants blindly.
- Reduced Motion shows the complete responding text immediately, removes the caret, synchronized pulse, and size travel, and retains a clear static active face.
- Interruption remains explicit in content with calm consequence-aware language. Preserve the current protocol distinction between interruption and barge-in even if product copy is refined.
- Same-speaker continuation may visually group adjacent assistant messages without losing each message’s semantic article or chronological position. A day/time divider remains separate from message content.
- Message bubbles do not expose hover-only actions, reactions, copy controls, or overflow menus in this reviewed scope.
- Tool and task activity remains outside message bubbles because it may not have a stable owning message.
- Meet platform target sizes, maintain visible link focus, support 200% web zoom and native large-text settings, and preserve comprehension without tint, pulse, caret, or animation.

## Decisions

- The older `sentient-design/` prototypes provide composition inspiration only. Current Dusk tokens, type floors, casing, elevated-slate construction, identity assets, and accessibility rules come from `DESIGN.md`.
- Bubble faces are stable plates, not keys. They do not move or gain an interaction outline on hover.
- User and assistant roles are distinguished by alignment, corner geometry, material tint, identity, and metadata—not color alone.
- The responding face grows vertically only. Width expansion during typing was rejected because it creates visual instability and performs poorly on narrow screens.
- Streaming text is never clipped to make a size transition work. The background surface follows the natural content geometry instead.
- Canonical avatar graphics communicate visible assistant state; redundant visible state pills above the bubble were rejected. Accessibility labels and status announcements remain required.
- Speaking/responding shadow motion shares the canonical artwork’s `1.55s` cycle. The message face does not scale or swell.
- All visible metadata follows normal casing. Supporting metadata remains at least 12.5px.

## Open

- **No blocker for implementing the reviewed message anatomy and states.**
- Production currently renders every message independently. Suppressing repeated avatars/metadata for same-speaker continuation requires an explicit grouping rule and stable chronology/accessibility tests.
- Exact web/iOS/Android streaming-rate projection should remain source-true to each platform’s shared reveal contract; the mock timing is demonstrative.
- Markdown sanitization, external-link policy, code overflow, and very long unbroken content require production boundary tests.
- Image-avatar loading, crop, failure, and privacy behavior remains undefined; use reviewed initial fallbacks until separately approved.
- Message actions, reactions, editing, retry, delivery state, attachments, citations, and rich media are not approved by this prototype.
- Voice playback visualization beyond the synchronized responding treatment remains part of composer/voice design work.
- Explicit local-stack validation at desktop, compact phone, large phone, 200% zoom, native large text, Reduced Motion, and increased contrast remains required during implementation.
