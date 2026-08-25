# Chat composer handoff

## Outcome

- Deliver one responsive chat composer for web, iOS, and Android that merges text send, hold-to-talk, and persistent Auto listening into the same trailing control.
- Preserve the approved composer anatomy, Dusk material language, contextual task shelf, TTS control, conditional response Stop, and integrated transparent textarea.
- Treat the microphone as a composer-internal mini component—not a separate overlay, sheet, or second composer.
- Keep native production ownership in Preact, SwiftUI, and Compose. The prototype is the visual, state, motion, and responsive contract rather than reusable production code.

## Source

- Review entry point: `design/prototype/chat-composer/index.html`
- Component and responsive styling: `design/prototype/chat-composer/chat-composer.css`
- Interaction reference: `design/prototype/chat-composer/chat-composer.js`
- Foundation snapshot used by the review shell: `design/prototype/chat-composer/vendor/`
- Durable visual authority: `DESIGN.MD`
- Existing implementation references:
  - `gateway/webui/src/components/dock/composer.tsx`
  - `gateway/webui/src/components/dock/mic-corner.tsx`
  - `gateway/webui/src/components/dock/mic-corner-gesture.ts`
  - `ios/App/Chat/composer/Composer.swift`
  - `ios/App/Chat/composer/MicCorner.swift`
  - `android/src/main/kotlin/io/sentient/android/chat/composer/ComposerRow.kt`
  - `android/src/main/kotlin/io/sentient/android/chat/composer/MicCorner.kt`

## Behavior

- **Text:** the textarea grows vertically without an independent face. Enter sends; Shift+Enter inserts a newline. The trailing microphone becomes Send while a non-empty draft exists.
- **Surface focus:** clicking a non-control area of the composer focuses the textarea. The composer owns the visible focus glow; the textarea has no separate outline or shine.
- **Voice onset:** pointer-down starts listening immediately. The microphone slate expands into the capture pod, the mic glyph contracts into an ember nucleus, and a full-width inline waveform appears.
- **Held capture:** after the brief reveal delay, the softened aperture crown unfolds from the pod in the order **Auto, Cancel, Send**. Send is selected by default and remains the release fallback when the pointer does not deliberately enter another target.
- **Target selection:** dragging across a target moves the semantic seam and changes material, shape tension, and optional platform haptic feedback. Releasing on Send commits, Cancel discards, and Auto enters persistent listening.
- **Auto:** selecting Auto folds the crown away while retaining the same waveform measure as held capture. The pod becomes sage, the trailing glyph becomes the Auto identity, and tapping the pod again disables Auto and restores the original microphone.
- **Auto accessibility:** keyboard or assistive activation of the idle microphone enters Auto; activating the Auto pod again exits it. Pointer drag is not required for this toggle path.
- **Response Stop:** Stop exists only while Sentient is responding. It recedes and leaves the focus order during physically held capture, but may remain visible beside the active Auto pod.
- **Attention:** textarea content, attachment, and TTS controls recede only during held capture. They return in Auto while the sage pod remains the authoritative listening signal.
- **Task shelf:** the shelf remains joined above the composer and discloses one task detail at a time. Stopping a foreground response does not imply cancellation of background tasks.
- **Responsive:** desktop uses the `238px` active pod; the simulated phone uses `198px`. Within each composition, Hold and Auto use identical waveform width and height. Mobile controls remain touch-safe and do not overflow the phone frame.
- **Motion:** use measured width/shape morphing, perspective crown unfolding, staggered child-facet emergence, a moving semantic seam, compact pressed depth, and restrained waveform motion. Reduced Motion keeps immediate state changes and a static waveform/state signal.
- **Failure and permission:** if capture cannot start, return to the idle microphone and keep the text draft usable. Permission request and denial presentation remain platform-native and outside this bounded visual study.
- **Accessibility:** announce listening onset, selected drag target, Auto on/off, send, cancel, permission failure, and response interruption. Labels remain authoritative without color or motion.

## Decisions

- The approved radio order is **Auto, Cancel, Send**; Auto is farthest from the microphone and requires the most deliberate held gesture.
- Send is the default held-release consequence.
- Auto is a persistent mode, not a terminal action. It uses sage rather than ember and has a dedicated Auto glyph.
- Cancel uses clay-red semantics; Send uses ember commitment.
- The child controls are rounded facets sharing one spine with the parent pod. They are not detached pills, a radial menu, or sharp polygonal blades.
- Hold and Auto preserve the same waveform measure even though their surrounding controls differ.
- Selecting Auto hides Cancel and Send; the Auto pod itself becomes the toggle for leaving Auto.
- Composer helper text is omitted because the mini component communicates state through shape, material, waveform, labels, and motion.
- The existing production drag rail is not the target visual interaction for this redesign.

## Open

- **Implementation blocker:** current production gesture reducers use a left/right drag-to-lock rail and do not implement tap-to-latch Auto. Approve and specify the replacement state-machine contract before native implementation begins.
- Define the non-pointer held-capture alternative and screen-reader instructions per platform; keyboard/assistive Auto toggle is approved, but equivalent Send/Cancel access must be verified.
- Confirm native haptic patterns and target-entry thresholds during platform implementation; do not encode browser vibration behavior as a cross-platform contract.
- Confirm whether disabling Auto commits the current semantic capture or ends it without a user-visible message; the prototype specifies the visual toggle but does not redefine wire semantics.
- Attachment upload behavior, partial STT text, permission surfaces, and production audio transport remain outside this handoff.
