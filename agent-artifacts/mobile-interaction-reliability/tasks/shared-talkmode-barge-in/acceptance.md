# Task Acceptance: Make shared TalkMode authoritative for hold-to-talk barge-in

## Deliverables

- One hold press during assistant activity remains Hold, interrupts the active turn/playback, starts manual capture, and drives both native controls from shared TalkMode until release or a genuine shared failure transition.

## Acceptance

- A press during assistant TTS interrupts before requesting manual capture and shared TalkMode remains Hold
- The transient inactive projection caused by interrupt cannot reset Hold
- Release finalizes the manual turn; lock and continuous behavior remain intact
- Permission denial, real capture failure, disconnect, or teardown transitions shared TalkMode to Idle once
- Android and iOS controls render shared TalkMode and own no competing Idle/Hold/Continuous state
- No physical microphone step is required for task acceptance

## Boundary Proof

- TalkMode and seam integration tests pin ordering, transient state, failure, and idempotence
- Android and iOS gesture tests pin presentation-only intent translation and shared-state rendering
