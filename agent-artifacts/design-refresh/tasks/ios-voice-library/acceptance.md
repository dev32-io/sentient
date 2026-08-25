# Task Acceptance: Refresh the iOS voice library, add/record/upload, and Fish clone surfaces

## Deliverables

- Migrate every reachable native voice-management state to shared components while preserving current library, preview, recording, upload, clone, permission, and persistence behavior.

## Acceptance

- Every reachable Voice/Add/Fish state is represented and uses shared components.
- Existing persistence, selection, permission, recording/upload/clone behavior remains unchanged.
- Automated tests/previews perform no capture or playback and retain no audio/content evidence.
- Native navigation, permissions, long content, Dynamic Type, 44pt targets, and Reduced Motion remain usable.
- Unavailable controls remain honest and nonfunctional.

## Boundary Proof

- ViewModel/view tests use fakes to cover state machines and redaction without audio.
- Signed simulator build verifies route/resource integration only.
