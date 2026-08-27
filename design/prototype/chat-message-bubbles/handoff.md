# Chat message bubbles implementation handoff

## Outcome

- Implement the reviewed assistant and user message anatomy, visible states, responsive composition, and motion shown by these isolated references.
- Each PNG has a transparent surrounding canvas; the bubble face, interruption marker, code well, identity surface, shadow, and active glow retained inside the crop are part of the reviewed component anatomy.
- Keep Preact, SwiftUI, and Compose implementations native. The prototype and rendered references are visual and behavioral authority, not production dependencies.

## Prototype

- Entry point: `design/prototype/chat-message-bubbles/index.html` — approved responsive message-bubble review surface.
- Source styling and behavior: `design/prototype/chat-message-bubbles/chat-message-bubbles.css` and `design/prototype/chat-message-bubbles/chat-message-bubbles.js`.
- Composite transparent references over the canonical Dusk canvas when reviewing contrast and directional depth.

## Static references

- `design/prototype/chat-message-bubbles/handoff/static/day-divider--today--desktop.png` — desktop day divider between chronological message groups.
- `design/prototype/chat-message-bubbles/handoff/static/day-divider--today--compact.png` — compact day divider.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--standard--desktop.png` — completed assistant message with desktop identity and metadata.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--standard--compact.png` — completed assistant message at compact width and avatar size.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--continuation--desktop.png` — grouped assistant continuation without repeated visible identity or metadata.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--continuation--compact.png` — compact grouped assistant continuation.
- `design/prototype/chat-message-bubbles/handoff/static/user-message--standard--desktop.png` — ordinary desktop user message aligned to the sending edge.
- `design/prototype/chat-message-bubbles/handoff/static/user-message--standard--compact.png` — ordinary compact user message.
- `design/prototype/chat-message-bubbles/handoff/static/user-message--long-request--desktop.png` — long desktop user request with bounded readable measure.
- `design/prototype/chat-message-bubbles/handoff/static/user-message--long-request--compact.png` — long compact user request with wrapping and truncated display metadata.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--rich-markdown--desktop.png` — desktop assistant response containing heading, emphasis, list, link, and code well.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--rich-markdown--compact.png` — compact rich assistant response.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--rich-markdown-link-focus--desktop.png` — rich assistant response with its inline link visibly keyboard-focused.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--thinking--desktop.png` — desktop thinking state with active identity and progress line.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--thinking--compact.png` — compact thinking state with stacked progress treatment.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--thinking--reduced-motion.png` — static Reduced Motion thinking treatment.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--responding-partial--desktop.png` — desktop responding state during a partial text reveal.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--responding-partial--compact.png` — compact responding state during a partial text reveal.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--responding--reduced-motion.png` — Reduced Motion responding state with complete text and no caret or pulse.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--complete--desktop.png` — desktop completed response after active state ends.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--complete--compact.png` — compact completed response.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--interrupted--desktop.png` — desktop interrupted response with explicit consequence marker.
- `design/prototype/chat-message-bubbles/handoff/static/assistant-message--interrupted--compact.png` — compact interrupted response.

## Motion references

- `design/prototype/chat-message-bubbles/handoff/recordings/assistant-message--thinking-loop/` — ordered frames for the complete thinking message, including identity and progress activity.
- `design/prototype/chat-message-bubbles/handoff/recordings/assistant-message--responding-reveal/` — ordered frames for progressive text reveal and vertical-only bubble growth at a stable inline size.
- `design/prototype/chat-message-bubbles/handoff/recordings/assistant-message--responding-breathe/` — ordered frames for the synchronized responding identity and directional ember-cast cycle.

## Behavior and accessibility

- Expose every message as its own semantic chronological item with role, author, and time. A visually grouped continuation remains an independent message in reading and accessibility order.
- Use the canonical Sentient idle, thinking, and responding assets. Preserve one stable reviewed tint per user and switch only between the approved 44px and 28px avatar tiers shown here.
- Announce thinking and responding state accessibly without adding a redundant visible state badge. Do not rely on avatar motion, caret, glow, or tint as the only state signal.
- Keep responding width stable. Reveal text without clipping or loss, and grow only in block size as natural line wrapping requires.
- Under Reduced Motion, reveal the complete response immediately and remove repeated motion, caret blinking, cast breathing, and size travel while retaining a clear active state.
- Preserve link focus visibility, sanitized Markdown boundaries, long-token wrapping, and code overflow behavior at 200% web zoom and native large-text settings.
- Interruption copy must remain explicit and consequence-aware; do not conflate interruption with authorization or completion.
- Message actions, reactions, editing, retry, delivery state, attachments, citations, rich media, tool activity, tasks, permissions, composer controls, and page chrome remain outside this reviewed handoff.

## Exceptions

- Same-speaker continuation needs an explicit production grouping rule with stable chronology and accessibility tests before repeated identity or metadata is suppressed.
- Exact streaming rates remain platform-native and must preserve each shared reveal contract’s no-stall and no-loss invariants; the ordered frames demonstrate appearance and progression rather than prescribing timer constants.
- Image-avatar loading, crop, failure, and privacy behavior remains unresolved; use the reviewed initial fallback until separately approved.
