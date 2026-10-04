import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

test("iOS capture rejects output aliases, traversal and symlink escapes before native launch", () => {
  const root = resolve(import.meta.dir, "../..");
  const outputRoot = resolve(root, "build/visual-captures/ios");
  mkdirSync(outputRoot, { recursive: true });
  const owned = mkdtempSync(resolve(outputRoot, "guard-test-"));
  const outside = mkdtempSync(resolve(root, "build/visual-captures/ios-sibling-"));
  const reference = resolve(root, "design/prototype/foundation-components/handoff/static/chip--selected--rest.png");
  const original = readFileSync(reference);
  try {
    const bin = resolve(owned, "bin");
    const launched = resolve(owned, "native-launched");
    mkdirSync(bin);
    for (const command of ["xcodebuild", "xcrun"]) {
      writeFileSync(resolve(bin, command), `#!/bin/sh\nprintf '%s' '${command}' > '${launched}'\nexit 99\n`, { mode: 0o700 });
    }
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
      // File-backed diagnostics avoid Bun test's broken subprocess pipes.
      const stdout = resolve(owned, "stdout");
      const stderr = resolve(owned, "stderr");
      const result = Bun.spawnSync(["bash", "scripts/design/capture-ios-visual-diff.sh", reference, output], {
        cwd: root, timeout: 10_000,
        stdout: Bun.file(stdout), stderr: Bun.file(stderr),
        env: {
          ...process.env,
          VISUAL_DIFF_IOS_DESTINATION: "platform=iOS Simulator,id=guard-test-must-not-launch",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      expect(existsSync(launched)).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(readFileSync(stderr, "utf8")).toContain("implementation output must stay under build/visual-captures/ios");
      expect(readFileSync(stdout, "utf8")).toBe("");
    }
    expect(readFileSync(reference)).toEqual(original);
  } finally {
    rmSync(owned, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
