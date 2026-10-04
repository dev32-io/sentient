import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { beginEvidence, finishEvidence, sourceIdentity, validateEvidence } from "./evidence.mjs";
import { assertDisposableOutput } from "./reference-image.mjs";
import { runVisualDiff } from "./visual-diff.mjs";

const metadata = {
  fixtureId: "example", runtime: { browser: "synthetic" }, viewport: { width: 2, height: 2, scale: 1 },
  configuration: { fontSha256: "a".repeat(64), themeSha256: "b".repeat(64) },
};
async function scratch(run) {
  // /tmp deliberately exercises macOS's /private/tmp alias as well.
  const root = await mkdtemp("/tmp/visual-security-");
  const cwd = process.cwd();
  try {
    childProcess.execFileSync("git", ["init", "-q", root]);
    const reference = join(root, "design/prototype/synthetic/handoff/static/example.png");
    const actual = join(root, "build/visual-captures/ios/actual.png");
    const source = join(root, "ios/App/Example.swift");
    for (const file of [reference, actual, source]) await mkdir(dirname(file), { recursive: true });
    await writeFile(source, "// synthetic source\n");
    childProcess.execFileSync("git", ["add", "."], { cwd: root });
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    const bytes = PNG.sync.write(png);
    await writeFile(reference, bytes);
    await writeFile(actual, bytes);
    process.chdir(root);
    await run({ root, reference, actual, bytes, source });
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
}
async function preserved(reference, actual, bytes) {
  assert.deepEqual(await readFile(reference), bytes);
  assert.deepEqual(await readFile(actual), bytes);
}

test("WV-2: all sidecars reject symlink/hardlink writes, before begin or finish mutates inputs", async () => {
  await scratch(async ({ root, reference, actual, bytes }) => {
    const outside = join(root, "outside.json");
    await writeFile(outside, bytes);
    for (const suffix of [".pending.json", ".evidence.json", ".capture.json"]) {
      for (const target of [reference, actual, outside]) {
        for (const alias of [symlink, link]) {
          for (const operation of [beginEvidence, finishEvidence]) {
            await beginEvidence(root, reference, actual, "ios");
            await rm(actual + suffix, { force: true });
            await alias(target, actual + suffix);
            await assert.rejects(() => operation(root, reference, actual, "ios", metadata), /overwrite|stay under|symbolic link|unaliased/);
            await preserved(reference, actual, bytes);
            assert.deepEqual(await readFile(outside), bytes);
            await rm(actual + suffix);
          }
        }
      }
    }
    await beginEvidence(root, reference, actual, "ios");
    const evidence = await finishEvidence(root, reference, actual, "ios", metadata);
    await validateEvidence(root, evidence);
  });
});

test("WV-3: canonical input aliases reject before any unlink/write; real pairwise comparator keeps both inputs", async () => {
  await scratch(async ({ root, reference, actual, bytes }) => {
    const platformRoot = dirname(actual);
    await symlink(dirname(reference), join(platformRoot, "reference-parent"));
    await link(reference, join(platformRoot, "reference-hardlink.png"));
    await symlink(dirname(actual), join(platformRoot, "actual-parent"));
    const realActual = await realpath(actual);
    const aliases = [
      join(platformRoot, "reference-parent/example.png"),
      join(platformRoot, "reference-hardlink.png"),
      join(platformRoot, "actual-parent/actual.png"),
      realActual,
    ];
    for (const output of aliases) {
      const messages = [];
      assert.equal(await runVisualDiff([reference, actual, "--diff", output], { stdout: line => messages.push(line), stderr: line => messages.push(line) }), 2);
      assert.match(messages.join("\n"), /Diff output must not overwrite either input image\./);
      await preserved(reference, actual, bytes);
    }
    for (const output of aliases.slice(0, 2)) {
      await assert.rejects(() => assertDisposableOutput(reference, output, "ios"), { message: "Implementation output must not overwrite a designer reference." });
      await preserved(reference, actual, bytes);
    }
    const rawReference = `${platformRoot}/reference-parent/../static/example.png`;
    await assert.rejects(() => assertDisposableOutput(rawReference, aliases[0], "ios"), { message: "Implementation output must not overwrite a designer reference." });
    const rawMessages = [];
    assert.equal(await runVisualDiff([rawReference, actual, "--diff", aliases[0]], { stdout: line => rawMessages.push(line), stderr: line => rawMessages.push(line) }), 2);
    assert.match(rawMessages.join("\n"), /must not overwrite/);
    await preserved(reference, actual, bytes);
    assert.equal(await runVisualDiff([rawReference, actual, "--diff", join(platformRoot, "safe.png")], { stdout() {}, stderr() {} }), 0);
    await preserved(reference, actual, bytes);
    // Escaped nonexistent tails and raw symlink/.. must not create directories.
    const outside = join(root, "outside/nested");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(platformRoot, "escape"));
    for (const output of [`${platformRoot}/escape/../new/output.png`, `${platformRoot}/escape/new/output.png`]) {
      await assert.rejects(() => assertDisposableOutput(reference, output, "ios"), /stay under/);
      assert.equal(await runVisualDiff([reference, actual, "--diff", output], { stdout() {}, stderr() {} }), 2);
      await preserved(reference, actual, bytes);
    }
    await assert.rejects(() => readFile(join(root, "outside/new/output.png")), { code: "ENOENT" });
  });
});

test("WV-3: redirected artifact/platform roots reject before the real comparator can unlink a reference", async () => {
  await scratch(async ({ root, reference, actual, bytes }) => {
    const second = join(root, "second.png");
    await writeFile(second, bytes);
    await rm(join(root, "build/visual-captures"), { recursive: true });
    await symlink(dirname(reference), join(root, "build/visual-captures"));
    for (const leaf of ["example.png", "new.png"]) {
      const messages = [];
      assert.equal(await runVisualDiff([reference, second, "--diff", `build/visual-captures/${leaf}`], { stdout: line => messages.push(line), stderr: line => messages.push(line) }), 2);
      assert.match(messages.join("\n"), leaf === "example.png" ? /must not overwrite/ : /stay under/);
      await preserved(reference, second, bytes);
    }
    await rm(join(root, "build/visual-captures"));
    await mkdir(join(root, "build/visual-captures"));
    await symlink(dirname(reference), dirname(actual));
    await assert.rejects(() => assertDisposableOutput(reference, join(dirname(actual), "example.png"), "ios"), { message: "Implementation output must not overwrite a designer reference." });
    await assert.rejects(() => assertDisposableOutput(reference, join(dirname(actual), "new.png"), "ios"), /stay under/);
    await preserved(reference, second, bytes);
  });
});

test("WV-3: ordinary canonical /tmp outputs work, including real ODiff mismatch and decode failure", async () => {
  await scratch(async ({ reference, actual, bytes }) => {
    await assertDisposableOutput(reference, actual, "ios");
    const diff = join(dirname(actual), "diff.png");
    const options = { stdout() {}, stderr() {} };
    assert.equal(await runVisualDiff([reference, actual, "--diff", diff], options), 0);
    await preserved(reference, actual, bytes);
    const png = PNG.sync.read(bytes);
    png.data.fill(0);
    const changed = PNG.sync.write(png);
    await writeFile(actual, changed);
    assert.equal(await runVisualDiff([reference, actual, "--diff", diff, "--threshold", "0.02", "--max-diff-percentage", "4.25"], options), 1);
    assert.deepEqual(await readFile(reference), bytes);
    assert.deepEqual(await readFile(actual), changed);
    await writeFile(actual, "invalid PNG");
    assert.equal(await runVisualDiff([reference, actual, "--diff", diff], options), 2);
    assert.deepEqual(await readFile(reference), bytes);
    assert.equal(await readFile(actual, "utf8"), "invalid PNG");
  });
});

test("WV-3: web CLI preserves raw symlink/.. before authorization, without starting capture", async () => {
  const repo = resolve(import.meta.dirname, "../..");
  const platformRoot = join(repo, "build/visual-captures/web");
  await mkdir(platformRoot, { recursive: true });
  const owned = await mkdtemp(join(platformRoot, "security-cli-"));
  try {
    await scratch(async ({ root, reference }) => {
      const target = join(root, "outside/deep");
      await mkdir(target, { recursive: true });
      await symlink(target, join(owned, "escape"));
      // Invalid synthetic input ensures even a regressed guard cannot launch a
      // browser/server: PNG decoding happens before capture setup.
      await writeFile(reference, "synthetic invalid PNG");
      const result = childProcess.spawnSync(process.execPath, [join(repo, "tools/visual-diff/capture-web.mjs"), "--reference", reference, "--output", `${owned}/escape/../forbidden.png`], { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must stay under/);
      assert.equal(await readFile(reference, "utf8"), "synthetic invalid PNG");
      await assert.rejects(() => readFile(join(root, "outside/forbidden.png")), { code: "ENOENT" });
    });
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});

test("WV-4: successful empty, unavailable, and missing implementation Git enumeration fail closed", async () => {
  await scratch(async ({ root, reference, actual, bytes, source }) => {
    await beginEvidence(root, reference, actual, "ios");
    const evidence = await finishEvidence(root, reference, actual, "ios", metadata);
    const original = childProcess.execFileSync;
    try {
      // Deterministic subprocess boundary, independent of Bun invocation quirks.
      for (const result of [Buffer.alloc(0), new Error("Git unavailable"), Buffer.from("design/prototype/synthetic/handoff/static/example.png\0")]) {
        childProcess.execFileSync = () => { if (result instanceof Error) throw result; return result; };
        syncBuiltinESMExports();
        for (const operation of [
          () => sourceIdentity(root, "ios"),
          () => beginEvidence(root, reference, actual, "ios"),
          () => finishEvidence(root, reference, actual, "ios", metadata),
          () => validateEvidence(root, evidence),
        ]) await assert.rejects(operation, /enumeration|Git unavailable/);
        await preserved(reference, actual, bytes);
      }
      childProcess.execFileSync = (_command, args) => Buffer.from(args.includes("--others") ? "" : "ios/App/Example.swift\0");
      syncBuiltinESMExports();
      const identity = await sourceIdentity(root, "ios");
      assert.match(identity, /^[a-f0-9]{64}$/);
      await writeFile(source, "// changed\n");
      assert.notEqual(await sourceIdentity(root, "ios"), identity);
    } finally {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
    }
  });
});

test("WV-5: scoped untracked Kotlin/config create, change and removal invalidate native evidence", async () => {
  await scratch(async ({ root, reference, actual, bytes }) => {
    const baseline = await sourceIdentity(root, "ios");
    for (const path of ["shared/mobile-data/src/iosMain/kotlin/Example.kt", "shared/mobile-sdk/src/commonMain/Example.kts", "ios/App/synthetic.yml", "ios/App/synthetic.json"]) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      for (const mutate of [() => writeFile(file, "version 1"), () => writeFile(file, "version 2"), () => rm(file)]) {
        await beginEvidence(root, reference, actual, "ios");
        const evidence = await finishEvidence(root, reference, actual, "ios", metadata);
        await mutate();
        await assert.rejects(() => validateEvidence(root, evidence), /Stale\/source-incompatible/);
        await assert.rejects(() => finishEvidence(root, reference, actual, "ios", metadata), /changed during capture/);
        await preserved(reference, actual, bytes);
      }
      assert.equal(await sourceIdentity(root, "ios"), baseline);
    }
    // Synthetic unreadable/private-shaped aliases must never be followed/hashed.
    for (const path of ["ios/App/.env", "ios/App/.env.json", "ios/App/secrets.json", "ios/App/private-state/example.json", "outside/Example.kt"]) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await symlink(join(root, "does-not-exist"), file);
    }
    assert.equal(await sourceIdentity(root, "ios"), baseline);
  });
});
