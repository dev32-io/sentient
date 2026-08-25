# Chat message bubbles prototype

ID: `chat-message-bubbles`

Open `index.html` through the Visual Companion or a local static server. See `handoff.md` for the reviewed implementation brief.

## Boundary

- Covers assistant and user message anatomy, identity, metadata, conversation rhythm, same-role continuation, thinking, responding, completed, interrupted, rich Markdown, long content, and responsive composition.
- During active responding or speaking, the bubble’s ember cast breathes on the canonical responding avatar’s 1.55-second cycle. Streaming text reveals progressively inside a stable responsive width while the bubble grows smoothly only in block size around new lines. Reduced Motion shows the complete text in the same active face without pulse, caret, or size travel.
- This consolidated prototype and handoff define the reviewed message composition under the authority of `DESIGN.MD`.
- Preserves the current production contract in `gateway/webui/src/components/chat/message-bubble.tsx` and `bubble-text.tsx`: user/assistant roles, author and time metadata, Markdown content, accessible thinking state, and explicit interruption.
- User identity consumes the reviewed foundation elevated-slate avatar primitive unchanged, keeps one stable tint per person, and switches only through its approved 44px and 28px size tiers.
- Excludes the composer, voice input controls, task strips, tool details, permissions, navigation, complete-page chrome, reactions, and message action menus.
- Tool activity remains outside message bubbles because it may not have a stable owning message.
- `vendor/` is a self-contained snapshot of the reviewed foundation styles and canonical Sentient identity assets.

This is a responsive visual review artifact, not production code. Production implementations remain native to Preact, SwiftUI, and Compose and follow `DESIGN.MD`.
