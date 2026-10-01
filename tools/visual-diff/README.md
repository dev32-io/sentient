# Sentient visual diff

This repository-local copy of the PiBox example compares one designer-rendered component reference with one implementation screenshot. The platform wrapper enforces the selected numeric profile (not library certification); it never updates immutable references.

## Sentient quick start

Install the pinned comparator and Chromium once:

```bash
bun run visual:setup
```

Capture and compare the first supported foundation case in one agent-friendly command:

```bash
reference=design/prototype/foundation-components/handoff/static/action-button--primary--rest.png
bun run visual:compare -- --platform web --reference "$reference"
bun run visual:compare -- --platform ios --reference "$reference"

android_reference=design/prototype/foundation-components/handoff/static/action-button--destructive--rest.png
bun run visual:compare -- --platform android --reference "$android_reference"
```

The underlying capture and pairwise commands remain available for diagnostics:

```bash
bun run visual:web:capture -- --reference "$reference"
bun run visual:diff -- "$reference" build/visual-captures/web/foundation-components/static/action-button--primary--rest.png

bun run visual:ios:setup # only after project.yml/package changes
bun run visual:ios:capture -- "$reference"
bun run visual:diff -- "$reference" build/visual-captures/ios/foundation-components/static/action-button--primary--rest.png

bun run visual:android:capture -- "$android_reference"
bun run visual:diff -- "$android_reference" build/visual-captures/android/foundation-components/static/action-button--destructive--rest.png --background '#2B2621'
```

Designer references are immutable inputs under `design/prototype/**/handoff/`. Actual images and diff artifacts are restricted to `build/visual-captures/`. The handoff currently emits transparent 2x canvases; platform fixtures must preserve the reference pixel dimensions and must not resize images merely to satisfy the comparator. By default every platform is composited on canonical Dusk (`#2B2621`) before ODiff, and the reported percentage is normalized by the union of non-transparent reference and actual pixels. Transparent canvas padding therefore cannot dilute the score.

The iOS adapter requires exactly one booted iPhone 16 simulator by default. Set `VISUAL_DIFF_IOS_DESTINATION` to an explicit **iOS Simulator** destination when a different pinned simulator is intentional. `VISUAL_DIFF_TIMEOUT_MS` controls the agent wrapper's bounded capture timeout (default: 20 minutes).

New cases are intentionally added one at a time to each platform fixture while implementing that component. Authority IDs include prototype/static-case or prototype/recording/frame. Default output directories preserve that namespace; unrelated `frame-000` files cannot overwrite each other. Adapter fixture IDs are separate component/state IDs; unknown recordings never fall back to another component.

## Use

Copy this directory into a project—for example as `tools/visual-diff/`—install its pinned dependency, and run the wrapper from the project root:

```bash
npm --prefix tools/visual-diff install
node tools/visual-diff/visual-diff.mjs \
  design/prototypes/buttons/handoff/static/action-button--pressed.png \
  build/visual-captures/action-button--pressed.png
```

The command writes compact JSON to stdout and, when pixels differ, writes `<actual-name>.visual-diff.png` beside the actual image.

For a reviewed verification gate:

```bash
node tools/visual-diff/visual-diff.mjs reference.png actual.png \
  --max-diff-percentage 1 \
  --diff build/visual-captures/diffs/action-button.diff.png
```

- Profiles live in `profiles.json`. iOS uses ODiff **0.02 / 4.25% unrounded alpha-union**, AA ignored, no text masks. Primary REST native measured **3.911%**, repeats byte-identical; seven seeded faults and two fresh held-out faults fail. Calibration: iPhone 16/iOS26.5, source viewport 621pt, crop 233pt. Initial <=1% aspiration was not met; user accepted pragmatic font/grid limits instead of loose-pixel tolerance hiding defects. Hashes, runtime and limitations are recorded in profile provenance. Other components/OS still need calibration and visual/semantic review.
- Web/Android retain **0.56 / 0.2%**, explicitly **unvalidated**, not endorsed. Real ODiff at0.56 ignores even opaque black→gray147 and the pilot's tested material defects; a low score is not fidelity. Wrapper warns; no thresholds silently retuned.
- Both images are composited on canonical Dusk by default; `--background` selects another reviewed opaque canvas.
- `diffPercentage` is `100 * diffCount / visiblePixelCount`, where visible pixels are the alpha union of the original inputs. `canvasDiffPercentage` preserves ODiff's whole-canvas result for diagnostics.
- Anti-aliased pixels are ignored by default; pass `--count-antialiasing` to include them.
- Without `--max-diff-percentage`, a completed comparison is report-only and exits `0` even when differences are reported.
- Gates compare raw counts, not rounded display percentages. Both color difference and alpha-presence shape difference (XOR / union) must fit the same budget. Opaque-Dusk→transparent substitution cannot pass; empty paint cannot pass. Absolute alpha difference is diagnostic, not a separately calibrated alpha-opacity gate.
- With `--max-diff-percentage`, exceeding either budget, empty paint or a layout mismatch exits `1`.
- Invocation, decode, and filesystem errors exit `2`.

A project can invoke the wrapper once per static state or keyframe, loop over files using its own test infrastructure, change defaults, or call [`odiff-bin`](https://github.com/dmtrKovalenko/odiff) directly.

## Project and platform setup guidance

PiBox supplies the approved mockup renders and this pairwise comparator. The project remains responsible for producing the implementation image. Prefer the project's existing screenshot-test infrastructure rather than adding another capture framework solely for PiBox.

Regardless of platform:

1. Render the same single component instance, content, variant, and state shown by the selected handoff reference. One implementation preview should correspond to one reference file.
2. Capture the isolated component rather than a specimen row, variant collection, or unrelated full application screen.
3. Stabilize data, fonts, theme, locale, scale, and animation through the project's normal fixture facilities.
4. Do not resize either image merely to make the comparison run; a layout mismatch is useful evidence.
5. The platform wrapper applies its reviewed tolerance and visible-difference gate: Web `0.56 / 0.2%` (unvalidated), iOS `0.02 / 4.25%` (pilot only), and Android `0.56 / 0.2%` (unvalidated). An iOS numeric pass is necessary but not sufficient: inspect the report and resolve visible non-text differences before completion. Use the underlying pairwise command without `--max-diff-percentage` only for explicit report-only diagnostics.
6. Keyframe comparisons prove only checkpoints. Trajectory evidence requires production mount, fixed parent viewport, controlled clock/state, actual frame timestamps and no animation disabling or crop-following. Current adapters declare `trajectoryEvidence:false`; composer/voice trajectories remain missing.

### Vite and browser applications

[Playwright Test screenshot support](https://playwright.dev/docs/test-snapshots) is the recommended default. A project can render a component route or fixture, select the component with a stable locator, and write an implementation image with `locator.screenshot()`:

```ts
const component = page.getByTestId("action-button-fixture");
await component.screenshot({
  path: "build/visual-captures/action-button--pressed.png",
  animations: "disabled",
});
```

Use fixed fixture data and viewport configuration. When the reference represents a transition keyframe, let the fixture expose the intended state or control its clock explicitly rather than relying on a wall-clock delay. Playwright MCP is not required for repeatable project capture; a normal Playwright test or script is cheaper and easier to reproduce.

### Android Compose

Use the project's existing Compose screenshot framework when it has one. Recommended choices are:

- [Roborazzi](https://github.com/takahirom/roborazzi) for Compose or View fixtures, interactions, and repository-oriented screenshot workflows.
- [Compose Preview Screenshot Testing](https://developer.android.com/studio/preview/compose-screenshot-testing) for projects already expressing stable states as previews.
- [Paparazzi](https://cashapp.github.io/paparazzi/) for host-rendered Compose/View snapshots.

For motion keyframes, Compose's [test clock](https://developer.android.com/develop/ui/compose/animation/testing) can pause automatic advancement and move to explicit logical times before each capture. The Gradle test or fixture chooses where actual PNGs are written and invokes this wrapper afterward.

### iOS and SwiftUI

[Point-Free SnapshotTesting](https://github.com/pointfreeco/swift-snapshot-testing) is the recommended default for fixed SwiftUI/UIKit fixtures and repository snapshots. Existing XCTest/XCUITest screenshot capture or a project-specific `ImageRenderer` fixture is also acceptable.

Keep the simulator/device configuration, proposed size, color scheme, locale, Dynamic Type setting, and fixture data explicit in the project's test. Represent motion as deterministic view states or injected progress/clock values and capture the corresponding PNG keyframes. SwiftUI does not need to adopt a PiBox-specific preview or sequencing protocol.

### Other platforms

Any deterministic mechanism that emits a supported image is sufficient. ODiff accepts PNG, JPEG, WebP, and TIFF, although lossless PNG is recommended for UI captures. The project may wrap the comparator in its native test runner, a shell script, CI, or an agent implementation loop.

### CI and baseline policy

The designer-generated handoff image remains the visual reference. Implementation jobs should generate actual images into a disposable build or artifact directory; they should not overwrite the designer references. Store diff PNGs and JSON reports as CI artifacts when useful. Projects may additionally maintain their own platform regression baselines, but those policies are independent of PiBox's mockup comparison guidance.

## Truthful coverage and evidence

```sh
source scripts/env.sh
mkdir -p build/visual-captures
node tools/visual-diff/coverage.mjs > build/visual-captures/coverage.json
# After allocated native capture slot, capture any supported component above.
# Capture exports full fixture-registry.json plus its source/hash provenance.
node tools/visual-diff/coverage.mjs build/visual-captures/ios/fixture-registry.json \
  > build/visual-captures/coverage.json
node --test tools/visual-diff/*.test.mjs
bun test qa/design-refresh/check.test.ts
```

Inventory joins all 615 handoff authorities, 216 shipped iOS states and 213 baseline tracked source files plus newly added Swift source (some nonvisual). Without fresh native registry export, registered families are `needs-review`, absent families `missing`; never guessed case support. With export, `real-fixture` means routing/applicability only, **not capture/pass**. Shipped screen rows remain missing until actual row dispatch exists. Backend setup native-only states are explicitly listed; generic native adaptations do not imply native-only capability.

Capture sidecars bind full authority/reference hashes, decoded image hash/dimensions, dirty tracked + relevant untracked source fingerprint, runtime, viewport/crop, state, font/theme identities, color-space policy and motion policy. Source changes during capture reject output. Validation rehashes sources/images/references; conservative scope may require recapture after unrelated changes. Native PNG export retains the calibrated standard-sRGB alpha correction. pngjs itself is not a color-management pipeline; arbitrary P3 input is not certified.

`compare.mjs` validates iOS/web provenance before numerical comparison. Raw `visual-diff.mjs` remains a diagnostic: historical/arbitrary input images can be scored but cannot close coverage. Web capture is `source-fixture`, not shipped component evidence. Pairwise sidecars leave native hit-target/overflow/focus values unknown; dedicated native accessibility/layout checks remain required. QA inventory labels no longer render generic substitute widgets; inventory capture fails unavailable before simulator mutation. Old reviewed sidecars lacking provenance or containing failed/unknown observations cannot close review. No automatic rewriting of prior reviewer verdicts.
