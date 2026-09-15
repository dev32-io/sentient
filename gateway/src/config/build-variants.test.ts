import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_VARIANTS, getBuildVariant } from "../../../shared/config/src/build-variants.ts";

const repo = join(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const text = (path: string) => readFileSync(join(repo, path), "utf8");

test("shared variants pin gateway and iOS APNs identity", () => {
  expect(BUILD_VARIANTS).toEqual({
    Debug: { bundleId: "io.dev32.sentient.debug", apsEnvironment: "development", apnsSandbox: true },
    Release: { bundleId: "io.dev32.sentient", apsEnvironment: "production", apnsSandbox: false },
  });
  expect(() => getBuildVariant("invalid")).toThrow("Invalid SENTIENT_BUILD_VARIANT");
});

test("source Debug and compiled Release select different embedded identities", () => {
  const root = mkdtempSync(join(tmpdir(), "sentient-build-variant-"));
  roots.push(root);
  const harness = join(root, "variant.ts");
  writeFileSync(
    harness,
    `import { writeFileSync } from "node:fs";\nimport { getBuildVariant } from ${JSON.stringify(join(repo, "shared/config/src/build-variants.ts"))};\nwriteFileSync(process.argv[2]!, JSON.stringify(getBuildVariant()));\n`,
  );

  expect(getBuildVariant("Debug")).toEqual(BUILD_VARIANTS.Debug);

  const binary = join(root, "variant");
  const build = Bun.spawnSync([
    Bun.which("bun") ?? process.execPath,
    "build",
    harness,
    "--compile",
    "--outfile",
    binary,
    "--define",
    'process.env.SENTIENT_BUILD_VARIANT="Release"',
  ]);
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const result = join(root, "result.json");
  const release = Bun.spawnSync([binary, result], {
    env: { ...process.env, SENTIENT_BUILD_VARIANT: "Debug" },
  });
  expect(release.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(result, "utf8"))).toEqual(BUILD_VARIANTS.Release);
});

test("iOS projection keeps bundle and entitlement identity paired", () => {
  const root = mkdtempSync(join(tmpdir(), "sentient-ios-variants-"));
  roots.push(root);
  const generated = join(root, "Generated");
  const run = Bun.spawnSync([process.execPath, join(repo, "scripts/generate-ios-build-variants.ts"), generated]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);

  for (const name of ["Debug", "Release"] as const) {
    const config = readFileSync(join(generated, `${name}.xcconfig`), "utf8");
    expect(config).toBe(text(`ios/App/Generated/${name}.xcconfig`));
    expect(config).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${BUILD_VARIANTS[name].bundleId}`);
    expect(config).toContain(`APS_ENVIRONMENT = ${BUILD_VARIANTS[name].apsEnvironment}`);
  }
  expect(readFileSync(join(generated, "Debug.xcconfig"), "utf8")).toContain('#include "../Local.xcconfig"');
  expect(readFileSync(join(generated, "Release.xcconfig"), "utf8")).not.toContain("Local.xcconfig");
  expect(text("ios/project.yml")).toContain("Debug: App/Generated/Debug.xcconfig");
  expect(text("ios/project.yml")).toContain("Release: App/Generated/Release.xcconfig");
  expect(text("ios/App/SentientApp.entitlements")).toContain("$(APS_ENVIRONMENT)");
});

test("OTA manifest and Fastlane ignore poisoned bundle identity", () => {
  const root = mkdtempSync(join(tmpdir(), "sentient-release-identity-"));
  roots.push(root);
  const manifestOutput = join(root, "manifest.json");
  const manifest = Bun.spawnSync(
    [
      "bash",
      "-c",
      'exec "$1" "$2" > "$3"',
      "_",
      Bun.which("node") ?? "node",
      join(repo, "scripts/build-manifest.mjs"),
      manifestOutput,
    ],
    {
      env: {
        ...process.env,
        PLAT: "ios",
        EXISTING: "{}",
        IOS_BUNDLE_VERSION: "12",
        IOS_SHORT_VERSION: "1.5.0",
        IOS_MIN_BUILD: "0",
        IOS_BUNDLE_ID: "io.example.poisoned",
      },
    },
  );
  expect(manifest.exitCode, manifest.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(manifestOutput, "utf8")).ios.bundleId).toBe(BUILD_VARIANTS.Release.bundleId);
  expect(text("scripts/deploy-mobile.sh")).not.toContain("IOS_BUNDLE_ID=");

  const appfileOutput = join(root, "appfile.txt");
  const appfile = Bun.spawnSync(
    [
      "bash",
      "-c",
      'exec "$1" -e "$2" "$3" > "$4"',
      "_",
      Bun.which("ruby") ?? "ruby",
      "def app_identifier(value); puts value; end; def team_id(value); end; def apple_id(value); end; load ARGV.fetch(0)",
      join(repo, "fastlane/Appfile"),
      appfileOutput,
    ],
    { env: { ...process.env, IOS_BUNDLE_ID: "io.example.poisoned" } },
  );
  expect(appfile.exitCode, appfile.stderr.toString()).toBe(0);
  expect(readFileSync(appfileOutput, "utf8").trim()).toBe(BUILD_VARIANTS.Release.bundleId);
});

test("developer and production entrypoints pin intended variants", () => {
  expect(text("scripts/stack.sh")).toContain("export SENTIENT_BUILD_VARIANT=Debug");
  expect(text("qa/mobile/run-e2e.sh")).toContain(
    'cd "$REPO_ROOT/gateway" && export SENTIENT_BUILD_VARIANT=Debug && nohup bun --watch src/main.ts',
  );
  expect(text("gateway/package.json")).toContain("SENTIENT_BUILD_VARIANT=Debug bun --watch");
  expect(text("gateway/package.json")).toContain('SENTIENT_BUILD_VARIANT=\\"Debug\\"');
  expect(text("scripts/build-gateway.sh")).toContain('--release) PROFILE="release"; VARIANT="Release"');
  expect(text("scripts/build-gateway.sh")).toContain('")        PROFILE="debug";   VARIANT="Debug"');
  expect(text("scripts/build-gateway.sh")).toContain('--define "$VARIANT_DEFINE"');
  expect(text("deploy/setup-prod.py")).toContain('["bash", "scripts/build-gateway.sh", "--release"]');
});
