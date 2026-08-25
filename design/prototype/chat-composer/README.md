# Chat composer prototype

ID: `chat-composer`

Open `index.html` through the Visual Companion or a local static server.

## Boundary

- This first-pass mockup intentionally treats the supplied legacy composer in `sentient-design/sentient-responsive-prototype.html` and `sentient-design/sentient-responsive-mobile- prototype.html` as the composition and interaction authority.
- It directly preserves the prototype anatomy: composer frame, optional task shelf joined above the frame, transparent auto-growing text field, attachment, spoken-response toggle, flexible voice hint, contextual Stop, and one shared microphone/send action. Stop is present only while Sentient is actively responding.
- The shared action displays the microphone when the draft is empty and becomes Send when text exists. Tap toggles hands-free listening; holding for roughly 420ms enters hold-to-talk; release completes the voice-note demonstration.
- Enter sends and Shift+Enter inserts a newline, matching the supplied web prototype.
- Task pills, one-at-a-time detail expansion, attachment selection feedback, TTS state, focus lift, action morph, and Reduced Motion behavior follow the supplied prototype.
- Compact layouts retain the prototype’s five-column `44px 44px 1fr 44px 44px` action row and single-column task detail.
- The current surface keeps the raised composer silhouette but adds a darker concave center, asymmetric warm shoulder, and directional ember cast so the broad graphite face has character without becoming another nested input well. Focus changes only the composer’s single directional glow; the inner text field remains visually integrated with the face.
- Pointer input anywhere on the composer face other than an interactive control immediately focuses the text area and places the caret at the end of the draft.
- Composer controls are purpose-built for this composite rather than direct foundation button instances. They still use the current Dusk palette, Fraunces/DM Sans/JetBrains Mono hierarchy, elevated-slate key physics, visible focus, minimum type floors, and current accessibility language from `DESIGN.md`.
- The review-state controls above the stage are prototype tooling only and are not part of the production composer.
- Current production composer code remains useful for later implementation feasibility and wire behavior, but it does not override this approved visual direction in the mockup.
- This bounded prototype does not include chat messages, navigation, complete-page chrome, permission-dialog design, attachment upload implementation, partial STT text, or production audio transport.
- `vendor/` is a self-contained snapshot used only by the review shell; the target composer controls are defined in `chat-composer.css`.

This is an intentionally faithful visual reconstruction for review, not production code. A handoff will be written only after the composer direction is approved.
