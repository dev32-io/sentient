import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("iOS capture rejects output aliases, traversal and symlink escapes before native launch", () => {
  const root = resolve(import.meta.dir, "../..");
  const outputRoot = resolve(root, "build/visual-captures/ios");
  mkdirSync(outputRoot, { recursive: true });
  const owned = mkdtempSync(resolve(outputRoot, "guard-test-"));
  const outside = mkdtempSync(resolve(root, "build/visual-captures/ios-sibling-"));
  const reference = resolve(root, "design/prototype/foundation-components/handoff/static/chip--selected--rest.png");
  const original = readFileSync(reference);
  try {
    symlinkSync(outside, resolve(owned, "escape"));
    symlinkSync(reference, resolve(owned, "reference-link.png"));
    for (const output of [
      reference,
      resolve(owned, "reference-link.png"),
      resolve(outside, "escaped.png"),
      `${outputRoot}/../escaped.png`,
      `${owned}/escape/new.png`,
      `${owned}/escape/../escaped.png`,
    ]) {
      const result = spawnSync("bash", ["scripts/design/capture-ios-visual-diff.sh", reference, output], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          VISUAL_DIFF_IOS_DESTINATION: "platform=iOS Simulator,id=guard-test-must-not-launch",
          "BASH_FUNC_xcodebuild%%": "() { echo 'Unexpected native launch' >&2; return 99; }",
        },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("implementation output must stay under build/visual-captures/ios");
      expect(result.stderr).not.toContain("Unexpected native launch");
    }
    expect(readFileSync(reference)).toEqual(original);
  } finally {
    rmSync(owned, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
