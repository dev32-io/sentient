# Chat composer prototype

ID: `chat-composer`

Open `index.html` through the Visual Companion or a local static server. It is the single review surface for the composer, including the wide composition and simulated `390px` phone frame.

Approved implementation handoff: [`handoff.md`](./handoff.md)

## Boundary

- The supplied legacy composer in `sentient-design/sentient-responsive-prototype.html` and `sentient-design/sentient-responsive-mobile- prototype.html` remains the composition authority: one frame, transparent auto-growing text field, attachment, spoken-response toggle, contextual Stop, and one shared microphone/send action.
- Stop is present only while Sentient is actively responding.
- The shared action displays the microphone when the draft is empty and becomes Send when text exists.
- Enter sends and Shift+Enter inserts a newline.
- Task pills, one-at-a-time detail expansion, attachment selection feedback, TTS state, focus response, action morph, and Reduced Motion behavior remain represented.
- The raised composer surface uses a darker concave center, asymmetric warm shoulder, and directional ember cast. The textarea has no independent face or focus outline; the composer owns focus emphasis.
- Pointer input anywhere on the composer face other than an interactive control immediately focuses the textarea and places the caret at the end of the draft.
- Composer controls are purpose-built for this composite rather than direct foundation button instances. They still use the current Dusk palette, established typography, elevated-slate physics, visible focus, minimum type floors, and current accessibility language from `DESIGN.md`.
- The review-state controls and mobile frame are prototype tooling, not production chrome.
- Current production code informs implementation feasibility and wire behavior but does not override this approved visual direction.
- This bounded prototype excludes chat messages, navigation, permission-dialog design, attachment upload implementation, partial STT text, and production audio transport.
- `vendor/` is a self-contained foundation snapshot used by the review shell.

## Microphone mini component

The microphone, waveform, and voice choices behave as one compact internal component:

- Capture begins immediately on pointer-down.
- The microphone slate morphs from a compact square into a wider, sharply cut capture pod; the microphone glyph contracts into a state-shaped ember nucleus while an inline waveform expands through the new space.
- After a brief reveal delay, the parent’s top edge unfolds into a softened **aperture crown**: rounded Auto, Cancel, and Send facets that share one spine and read as pieces grown from the capture pod rather than adjacent buttons.
- A quick tap latches Auto and keeps listening.
- A held press defaults to Send on release. The crown orders Auto, Cancel, Send from left to right, keeping Send closest to the microphone while Auto requires the most deliberate drag.
- Auto uses a restrained sage material and a dedicated Auto glyph to distinguish persistent listening from ember commitment and clay cancellation.
- Selecting Auto folds Cancel and Send back into the parent, retaining the same waveform measure in a sage Auto pod. Tapping that pod again disables Auto and morphs it back to the original microphone.
- The textarea, attachment, TTS, and contextual Stop controls recede only while the microphone is physically held. Auto restores the composer, and contextual Stop may reappear alongside the active Auto pod.
- The softened crown hinges open in perspective and a localized semantic seam travels beneath the selected facet. Shape, position, material, and motion all reinforce selection.
- Staggered facet movement, target magnetism, waveform motion, shape morphing, pressed depth, and restrained haptic ticks create continuity without turning the mini component into a separate composer.
- Wide and phone compositions use the same component and state model with touch-safe targets.
- This deliberately changes current production semantics, which use a left/right drag rail and do not yet implement tap-to-latch Auto. Implementation requires a reviewed state-machine change, not a visual-only swap.

This is an approved visual and interaction contract, not production code. See `handoff.md` for implementation requirements and open blockers.
