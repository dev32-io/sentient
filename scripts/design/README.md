# Design asset tooling

## Sentient avatar Rive asset

Canonical files live in `design/prototype/foundation-components/assets/avatars/`:

- `sentient-avatar.rive.json` — reviewable authored Rive SceneSpec and canonical animation source.
- `sentient-avatar.riv` — deterministic generated runtime asset consumed by WebUI and iOS.
- `sentient-avatar.rive-manifest.json` — source hashes, generator pin, runtime contract, timings, and documented adaptations.
- `sentient-mark.svg`, `sentient-avatar-thinking.svg`, `sentient-avatar-responding.svg`, and `sentient-avatar.js` — fidelity references and static fallbacks.

The SVG files are not converted automatically at runtime. Rive does not preserve their filters, CSS keyframes, SMIL motion, or wrapper transitions. The SceneSpec recreates those behaviors explicitly and verification fails when a fidelity-reference hash changes.

### Prerequisites

- Rustup with Rust `1.98.0` available. On Apple Silicon development hosts:

  ```sh
  brew install rustup
  ```

- Python 3 with Pillow.
- Google Chrome, Chromium, or a Playwright-managed Chromium build.

The bootstrap script builds the MIT-licensed third-party `rive-cli` from the exact commit and `Cargo.lock` recorded in `bootstrap-rive-cli.sh`. It enables no AI or MCP features.

### Generate and verify

```sh
source scripts/env.sh
bun run design:avatar:generate
bun run design:avatar:verify
```

Verification proves:

- all fidelity-reference hashes match the manifest;
- `.riv` generation is deterministic;
- the real Rive runtime loads the asset;
- idle, thinking, responding, Reduced Motion, and rapid transition redirection render correctly;
- independent source motion periods remain independent;
- deterministic Chromium SVG references stay within raster tolerance;
- representative Rive frames remain within the reviewed SVG parity bounds.

Temporary PNG frames and contact sheets are written beneath `/tmp/sentient-rive-render/` and are not committed.

### Refresh procedure

1. Update the SceneSpec and any intentionally changed SVG/JavaScript fidelity references together.
2. Preserve the manifest contract names unless every runtime adapter is migrated in the same change:
   - artboard `SentientAvatar`
   - state machine `Avatar`
   - triggers `toIdle`, `toThinking`, `toResponding`
   - Boolean `reducedMotion`
3. Run `bun run design:avatar:generate`; it regenerates `.riv` and refreshes the manifest source, SceneSpec, and runtime hashes.
4. Run `bun run design:avatar:verify` and inspect the generated contact sheets.
5. Record any changed approximation or parity threshold for explicit visual review.

Unsupported SVG blur/feather is represented with layered translucent strokes; dash arrays use trimmed arcs; animated stroke width uses fixed-width layers, scale, color, and opacity. Do not silently replace these approximations or loosen parity bounds merely to make verification pass.
