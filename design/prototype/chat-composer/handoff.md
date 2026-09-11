# Chat composer implementation handoff

## Outcome

- Implement the reviewed responsive composer, attached task shelf, purpose-built controls, voice mini component, and visible feedback shown by these isolated references.
- Each PNG has a transparent surrounding canvas; the composer face, task shelf, control slates, crown facets, waveform pod, shadows, focus rings, and semantic glows retained inside the crop are part of the reviewed component anatomy.
- Keep Preact, SwiftUI, and Compose implementations native. The prototype and rendered references are visual and behavioral authority, not production dependencies.

## Prototype

- Entry point: `design/prototype/chat-composer/index.html` — approved desktop and phone composer review surface.
- Source styling and behavior: `design/prototype/chat-composer/chat-composer.css` and `design/prototype/chat-composer/chat-composer.js`.
- Composite transparent references over the canonical Dusk canvas when reviewing contrast and directional depth.

## Composer references

- `design/prototype/chat-composer/handoff/static/composer--idle--desktop.png` — desktop composer with an empty draft and microphone action.
- `design/prototype/chat-composer/handoff/static/composer--focus--desktop.png` — desktop composer owning visible textarea focus emphasis.
- `design/prototype/chat-composer/handoff/static/composer--tts-off--desktop.png` — desktop composer with spoken responses disabled.
- `design/prototype/chat-composer/handoff/static/composer--text-ready--desktop.png` — desktop composer with a sendable text draft.
- `design/prototype/chat-composer/handoff/static/composer--multiline--desktop.png` — auto-grown desktop composer containing a multiline draft.
- `design/prototype/chat-composer/handoff/static/composer--responding--desktop.png` — desktop composer with contextual response Stop visible.
- `design/prototype/chat-composer/handoff/static/composer--tasks--desktop.png` — desktop composer joined to the collapsed task shelf.
- `design/prototype/chat-composer/handoff/static/composer--task-travel-open--desktop.png` — desktop composer with the running travel task disclosed.
- `design/prototype/chat-composer/handoff/static/composer--task-draft-open--desktop.png` — desktop composer with the completed draft task disclosed.
- `design/prototype/chat-composer/handoff/static/composer--task-permission-open--desktop.png` — desktop composer with the approval-needed task disclosed.
- `design/prototype/chat-composer/handoff/static/composer--hold-send--desktop.png` — held desktop capture with Send selected as the release fallback.
- `design/prototype/chat-composer/handoff/static/composer--hold-cancel--desktop.png` — held desktop capture with Cancel selected.
- `design/prototype/chat-composer/handoff/static/composer--hold-auto--desktop.png` — held desktop capture with Auto selected.
- `design/prototype/chat-composer/handoff/static/composer--auto--desktop.png` — desktop persistent Auto listening state.
- `design/prototype/chat-composer/handoff/static/composer--auto-responding--desktop.png` — desktop Auto listening while contextual response Stop remains available.
- `design/prototype/chat-composer/handoff/static/composer--hold--reduced-motion.png` — static Reduced Motion held-capture state.
- `design/prototype/chat-composer/handoff/static/composer--auto--reduced-motion.png` — static Reduced Motion Auto state.
- `design/prototype/chat-composer/handoff/static/composer--idle--compact.png` — compact composer with an empty draft and touch-sized microphone action.
- `design/prototype/chat-composer/handoff/static/composer--focus--compact.png` — compact composer owning visible textarea focus emphasis.
- `design/prototype/chat-composer/handoff/static/composer--text-ready--compact.png` — compact composer with a sendable text draft.
- `design/prototype/chat-composer/handoff/static/composer--multiline--compact.png` — auto-grown compact composer containing a multiline draft.
- `design/prototype/chat-composer/handoff/static/composer--responding--compact.png` — compact composer with contextual response Stop visible.
- `design/prototype/chat-composer/handoff/static/composer--hold-send--compact.png` — held compact capture with Send selected.
- `design/prototype/chat-composer/handoff/static/composer--hold-cancel--compact.png` — held compact capture with Cancel selected.
- `design/prototype/chat-composer/handoff/static/composer--hold-auto--compact.png` — held compact capture with Auto selected.
- `design/prototype/chat-composer/handoff/static/composer--auto--compact.png` — compact persistent Auto listening state.
- `design/prototype/chat-composer/handoff/static/composer--auto-responding--compact.png` — compact Auto listening with response Stop available.

## Task shelf references

- `design/prototype/chat-composer/handoff/static/task-shelf--summary--desktop.png` — attached desktop task shelf with no detail disclosed.
- `design/prototype/chat-composer/handoff/static/task-shelf--travel-open--desktop.png` — task shelf with the running travel detail disclosed.
- `design/prototype/chat-composer/handoff/static/task-shelf--draft-open--desktop.png` — task shelf with the completed draft detail disclosed.
- `design/prototype/chat-composer/handoff/static/task-shelf--permission-open--desktop.png` — task shelf with approval-needed detail and review action.
- `design/prototype/chat-composer/handoff/static/task-shelf--running--reduced-motion.png` — static Reduced Motion running-task signal.
- `design/prototype/chat-composer/handoff/static/task-shelf--permission-open--compact.png` — compact one-column approval-needed task disclosure.

## Voice-control references

- `design/prototype/chat-composer/handoff/static/voice-control--idle--desktop.png` — isolated desktop microphone control at rest.
- `design/prototype/chat-composer/handoff/static/voice-control--hold-send--desktop.png` — isolated desktop held-capture pod with Send selected.
- `design/prototype/chat-composer/handoff/static/voice-control--hold-cancel--desktop.png` — isolated desktop held-capture pod with Cancel selected.
- `design/prototype/chat-composer/handoff/static/voice-control--hold-auto--desktop.png` — isolated desktop held-capture pod with Auto selected.
- `design/prototype/chat-composer/handoff/static/voice-control--auto--desktop.png` — isolated desktop persistent Auto pod.
- `design/prototype/chat-composer/handoff/static/voice-control--idle--compact.png` — isolated compact microphone control at rest.
- `design/prototype/chat-composer/handoff/static/voice-control--hold-send--compact.png` — isolated compact held-capture pod with Send selected.
- `design/prototype/chat-composer/handoff/static/voice-control--hold-cancel--compact.png` — isolated compact held-capture pod with Cancel selected.
- `design/prototype/chat-composer/handoff/static/voice-control--hold-auto--compact.png` — isolated compact held-capture pod with Auto selected.
- `design/prototype/chat-composer/handoff/static/voice-control--auto--compact.png` — isolated compact persistent Auto pod.

## Internal control references

- `design/prototype/chat-composer/handoff/static/composer-control--attachment--rest.png` — attachment control at rest.
- `design/prototype/chat-composer/handoff/static/composer-control--attachment--hover.png` — attachment control under precise-pointer hover.
- `design/prototype/chat-composer/handoff/static/composer-control--attachment--focus.png` — keyboard-focused attachment control.
- `design/prototype/chat-composer/handoff/static/composer-control--attachment--pressed.png` — pressed attachment control.
- `design/prototype/chat-composer/handoff/static/composer-control--tts-on--rest.png` — spoken-response toggle in its on state.
- `design/prototype/chat-composer/handoff/static/composer-control--tts-on--focus.png` — keyboard-focused spoken-response toggle.
- `design/prototype/chat-composer/handoff/static/composer-control--tts-off--rest.png` — spoken-response toggle in its off state.
- `design/prototype/chat-composer/handoff/static/composer-control--microphone--rest.png` — microphone action at rest.
- `design/prototype/chat-composer/handoff/static/composer-control--microphone--hover.png` — microphone action under precise-pointer hover.
- `design/prototype/chat-composer/handoff/static/composer-control--microphone--focus.png` — keyboard-focused microphone action.
- `design/prototype/chat-composer/handoff/static/composer-control--microphone--pressed.png` — pressed microphone action at capture onset.
- `design/prototype/chat-composer/handoff/static/composer-control--send--rest.png` — text Send action at rest.
- `design/prototype/chat-composer/handoff/static/composer-control--send--focus.png` — keyboard-focused text Send action.
- `design/prototype/chat-composer/handoff/static/composer-control--send--pressed.png` — pressed text Send action.
- `design/prototype/chat-composer/handoff/static/composer-control--stop--rest.png` — contextual response Stop at rest.
- `design/prototype/chat-composer/handoff/static/composer-control--stop--focus.png` — keyboard-focused response Stop.
- `design/prototype/chat-composer/handoff/static/composer-control--stop--pressed.png` — pressed response Stop.

## Feedback references

- `design/prototype/chat-composer/handoff/static/composer-toast--attachment-selected.png` — attachment-selection confirmation.
- `design/prototype/chat-composer/handoff/static/composer-toast--auto-on.png` — persistent Auto activation confirmation.
- `design/prototype/chat-composer/handoff/static/composer-toast--response-stopped.png` — explicit response-interruption confirmation.

## Motion references

- `design/prototype/chat-composer/handoff/recordings/composer--idle-to-text-ready/` — ordered frames for the trailing action changing from microphone to Send when text appears.
- `design/prototype/chat-composer/handoff/recordings/composer--single-to-multiline/` — ordered frames for vertical textarea and composer growth around a multiline draft.
- `design/prototype/chat-composer/handoff/recordings/task-shelf--reveal/` — ordered frames for the task shelf joining the composer from above.
- `design/prototype/chat-composer/handoff/recordings/task-shelf--running-pulse/` — ordered frames for the running-task activity signal.
- `design/prototype/chat-composer/handoff/recordings/voice-control--microphone-to-hold/` — ordered frames for microphone-to-capture-pod shape morphing.
- `design/prototype/chat-composer/handoff/recordings/voice-control--crown-open/` — ordered frames for the aperture crown and staggered facets unfolding from the held pod.
- `design/prototype/chat-composer/handoff/recordings/voice-control--send-to-auto-target/` — ordered frames for target selection and semantic seam travel from Send to Auto.
- `design/prototype/chat-composer/handoff/recordings/voice-control--hold-to-auto/` — ordered frames for the crown folding into persistent Auto mode.
- `design/prototype/chat-composer/handoff/recordings/voice-control--hold-waveform-loop/` — ordered frames for held-capture waveform activity.
- `design/prototype/chat-composer/handoff/recordings/voice-control--auto-loop/` — ordered frames for persistent Auto waveform and activity treatment.

## Behavior and accessibility

- The textarea grows vertically without an independent face. Enter sends; Shift+Enter inserts a newline. A non-empty draft changes the shared trailing action from microphone to Send.
- Activating a non-control area of the composer focuses the textarea and places the caret at the draft end. The composer owns visible focus; the textarea does not add a second focus surface.
- Pointer-down starts capture immediately. A quick tap enters persistent Auto, while a held release defaults to Send unless the user deliberately selects Auto or Cancel.
- Keep the held target order Auto, Cancel, Send. Shape, position, label, and material must reinforce the active target without depending on color or haptics.
- Auto is a persistent mode. Activating its pod again exits Auto; keyboard and assistive activation must support this toggle without requiring a drag gesture.
- Response Stop exists in focus order only while Sentient is responding. It recedes during physically held capture but may remain beside persistent Auto. Stopping a response does not imply cancellation of background tasks.
- The task shelf remains structurally joined above the composer and discloses at most one task detail at a time. Permission review opens its own permission surface; the task detail itself does not authorize the action.
- Announce listening onset, target changes, Auto on or off, Send, Cancel, capture failure, attachment selection, permission failure, and response interruption with concise platform-native semantics.
- If capture cannot start, return to the idle microphone without losing or disabling the text draft.
- Under Reduced Motion, replace shape travel, crown unfolding, pulsing, orbiting, stagger, and repeated waveform motion with immediate state changes and clear static signals.
- Preserve visible keyboard focus, touch-safe targets, 200% web zoom, native large-text settings, and comprehension without motion, tint, glow, or haptic feedback.

## Exceptions

- Current production gesture reducers use a left/right drag-to-lock interaction and do not implement tap-to-latch Auto. Native implementation remains blocked until the replacement state-machine contract is reviewed.
- Define an equivalent non-pointer Send and Cancel path and platform screen-reader instructions before shipping held capture; the approved Auto toggle alone is not sufficient.
- Confirm platform haptic patterns, target-entry thresholds, and the semantic consequence of disabling Auto during native implementation.
- Attachment upload behavior, partial speech-to-text, permission presentation, and production audio transport remain outside this visual handoff.
