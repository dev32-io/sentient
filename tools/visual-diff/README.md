# Sentient visual diff

This repository-local copy of the PiBox example compares one designer-rendered component reference with one implementation screenshot. The platform wrapper enforces the reviewed visual profile; it never updates immutable references.

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
bun run visual:diff -- "$reference" build/visual-captures/web/action-button--primary--rest.png

bun run visual:ios:setup # only after project.yml/package changes
bun run visual:ios:capture -- "$reference"
bun run visual:diff -- "$reference" build/visual-captures/ios/action-button--primary--rest.png

bun run visual:android:capture -- "$android_reference"
bun run visual:diff -- "$android_reference" build/visual-captures/android/action-button--destructive--rest.png --background '#2B2621'
```

Designer references are immutable inputs under `design/prototype/**/handoff/`. Actual images and diff artifacts are restricted to `build/visual-captures/`. The handoff currently emits transparent 2x canvases; platform fixtures must preserve the reference pixel dimensions and must not resize images merely to satisfy the comparator. By default every platform is composited on canonical Dusk (`#2B2621`) before ODiff, and the reported percentage is normalized by the union of non-transparent reference and actual pixels. Transparent canvas padding therefore cannot dilute the score.

The iOS adapter requires exactly one booted iPhone 16 simulator by default. Set `VISUAL_DIFF_IOS_DESTINATION` to an explicit **iOS Simulator** destination when a different pinned simulator is intentional. `VISUAL_DIFF_TIMEOUT_MS` controls the agent wrapper's bounded capture timeout (default: 20 minutes).

New cases are intentionally added one at a time to each platform fixture while implementing that component. Static states map by basename. Motion references map frame-by-frame using their existing timestamped PNG names.

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

- The reviewed ODiff per-pixel threshold is `0.56` on Web, iOS, and Android; differences above it are counted after anti-alias detection. Platform wrappers pass this profile explicitly and require `diffPercentage <= 0.2%`. A diagnostic can override the tolerance with `--threshold` and the gate with `--max-diff-percentage`.
- Both images are composited on canonical Dusk by default; `--background` selects another reviewed opaque canvas.
- `diffPercentage` is `diffCount / visiblePixelCount`, where visible pixels are the alpha union of the original inputs. `canvasDiffPercentage` preserves ODiff's whole-canvas result for diagnostics.
- Anti-aliased pixels are ignored by default; pass `--count-antialiasing` to include them.
- Without `--max-diff-percentage`, a completed comparison is report-only and exits `0` even when differences are reported.
- With `--max-diff-percentage`, exceeding the limit or encountering a layout mismatch exits `1`.
- Invocation, decode, and filesystem errors exit `2`.

A project can invoke the wrapper once per static state or keyframe, loop over files using its own test infrastructure, change defaults, or call [`odiff-bin`](https://github.com/dmtrKovalenko/odiff) directly.

## Project and platform setup guidance

PiBox supplies the approved mockup renders and this pairwise comparator. The project remains responsible for producing the implementation image. Prefer the project's existing screenshot-test infrastructure rather than adding another capture framework solely for PiBox.

Regardless of platform:

1. Render the same single component instance, content, variant, and state shown by the selected handoff reference. One implementation preview should correspond to one reference file.
2. Capture the isolated component rather than a specimen row, variant collection, or unrelated full application screen.
3. Stabilize data, fonts, theme, locale, scale, and animation through the project's normal fixture facilities.
4. Do not resize either image merely to make the comparison run; a layout mismatch is useful evidence.
5. The platform wrapper applies the reviewed `0.56` tolerance and `0.2%` visible-difference gate. Use the underlying pairwise command without `--max-diff-percentage` only for explicit report-only diagnostics.
6. For motion, compare the corresponding PNG keyframes individually. A project-owned loop or test parameterization is sufficient; PiBox does not require keyframe manifests or filename conventions.

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
