import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { caseIdFromReference, fixtureIdFromReference } from "./reference-image.mjs";

const roots = {
  ios: ["ios/App", "ios/Tests", "ios/project.yml", "shared/mobile-data/src", "shared/mobile-sdk/src", "ios/SentientApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved", "shared/design", "design/prototype", "tools/visual-diff", "scripts/design"],
  web: ["gateway/webui/src", "ios/App/Resources/Fonts", "design/prototype", "tools/visual-diff", "scripts/design"],
};
export async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// Conservative invalidation: unrelated edits may require recapture; stale paint
// must not close coverage. Hash tracked source bytes, including dirty edits.
export async function sourceIdentity(repoRoot, platform) {
  if (!roots[platform]) throw new Error(`No evidence source scope for ${platform}`);
  const files = execFileSync("git", ["ls-files", "-z", "--", ...roots[platform]], { cwd: repoRoot, timeout: 30_000 }).toString().split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file + "\0" + await sha256(resolve(repoRoot, file)) + "\0");
  // New untracked renderer/fixture code is also material, but never private state.
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...roots[platform]], { cwd: repoRoot, timeout: 30_000 }).toString().split("\0").filter(file => /\.(swift|ts|tsx|mjs|css|json|ttf|riv)$/.test(file)).sort();
  for (const file of untracked) hash.update(file + "\0" + await sha256(resolve(repoRoot, file)) + "\0");
  return hash.digest("hex");
}

export async function beginEvidence(repoRoot, reference, actual, platform) {
  const caseId = caseIdFromReference(reference);
  try {
    const previous = JSON.parse(await readFile(actual + ".evidence.json", "utf8"));
    if (previous.caseId !== caseId) throw new Error("Output already belongs to another canonical case");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pending = {
    platform, caseId, referencePath: reference,
    referenceSha256: await sha256(reference), sourceSha256: await sourceIdentity(repoRoot, platform),
    startedAt: new Date().toISOString(),
  };
  await writeFile(actual + ".pending.json", JSON.stringify(pending));
}

export async function finishEvidence(repoRoot, reference, actual, platform, metadata) {
  const pending = JSON.parse(await readFile(actual + ".pending.json", "utf8"));
  if (pending.platform !== platform || pending.caseId !== caseIdFromReference(reference)
      || pending.referenceSha256 !== await sha256(reference)
      || pending.sourceSha256 !== await sourceIdentity(repoRoot, platform)) {
    throw new Error("Source/reference changed during capture; evidence unavailable");
  }
  if (platform === "ios" && metadata.fixtureId !== fixtureIdFromReference(reference)) throw new Error("Capture fixture identity mismatch");
  const image = PNG.sync.read(await readFile(actual));
  const ref = PNG.sync.read(await readFile(reference));
  if (image.width !== ref.width || image.height !== ref.height) throw new Error("Capture dimensions mismatch");
  const evidence = {
    version: 1, ...pending, capturedAt: new Date().toISOString(),
    actualPath: actual, actualSha256: await sha256(actual),
    dimensions: { width: image.width, height: image.height }, ...metadata,
  };
  await writeFile(actual + ".evidence.json", JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

export async function validateEvidence(repoRoot, evidence, { reference, actual, platform, inventoryId, implementationPath } = {}) {
  if (evidence.version !== 1 || !["ios", "web"].includes(evidence.platform)) throw new Error("Missing capture provenance");
  if (platform && platform !== evidence.platform) throw new Error("Evidence platform mismatch");
  if (inventoryId && (evidence.inventoryId !== inventoryId || evidence.implementationPath !== implementationPath)) throw new Error("Evidence production identity mismatch");
  if (inventoryId && evidence.origin !== "production-component") throw new Error("Generic/source specimens cannot close production coverage");
  if (evidence.sourceSha256 !== await sourceIdentity(repoRoot, evidence.platform)) throw new Error("Stale/source-incompatible evidence");
  const imagePath = resolve(repoRoot, actual ?? evidence.actualPath);
  if (evidence.actualSha256 !== await sha256(imagePath)) throw new Error("Image evidence hash mismatch");
  const image = PNG.sync.read(await readFile(imagePath));
  if (image.width !== evidence.dimensions?.width || image.height !== evidence.dimensions?.height) throw new Error("Image evidence dimensions mismatch");
  const referencePath = reference ?? evidence.referencePath;
  if (referencePath) {
    if (evidence.caseId !== caseIdFromReference(referencePath) || evidence.referenceSha256 !== await sha256(resolve(repoRoot, referencePath))) throw new Error("Reference identity/hash mismatch");
    if (evidence.platform === "ios" && evidence.fixtureId !== fixtureIdFromReference(referencePath)) throw new Error("Capture fixture identity mismatch");
  }
  if (!evidence.runtime || !Object.values(evidence.runtime).some(value => typeof value === "string" && value.length > 0)
      || !evidence.viewport || ![evidence.viewport.width, evidence.viewport.height, evidence.viewport.scale].every(value => Number.isFinite(value) && value > 0)
      || !evidence.configuration || !evidence.fixtureId || !evidence.capturedAt) throw new Error("Unknown runtime/viewport/font/theme/fixture identity");
  if (![evidence.configuration.fontSha256, evidence.configuration.themeSha256].every(value => /^[a-f0-9]{64}$/.test(value ?? ""))) throw new Error("Unknown font/theme identity");
  return evidence;
}

export async function fontThemeIdentity(repoRoot, platform) {
  // Source fingerprint includes full fonts/theme; these explicit identities
  // aid inspection, not a substitute for validating the full source scope.
  const font = "ios/App/Resources/Fonts/DMSans-Regular.ttf";
  const theme = "ios/App/Theme/DesignCanvasKernel.swift";
  return { fontSha256: await sha256(resolve(repoRoot, font)), themeSha256: platform === "ios" ? await sha256(resolve(repoRoot, theme)) : await sourceIdentity(repoRoot, "web") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, reference, actual, platform] = process.argv.slice(2);
  const repoRoot = process.cwd();
  if (command === "begin") await beginEvidence(repoRoot, reference, actual, platform);
  else if (command === "finish") {
    const metadata = JSON.parse(await readFile(actual + ".capture.json", "utf8"));
    metadata.configuration = { ...metadata.configuration, ...await fontThemeIdentity(repoRoot, platform) };
    metadata.runtime.toolchain = execFileSync("xcodebuild", ["-version"], { timeout: 30_000 }).toString().trim();
    metadata.runtime.destination = process.env.VISUAL_DIFF_IOS_DESTINATION ?? "single-booted-iPhone16";
    await finishEvidence(repoRoot, reference, actual, platform, metadata);
    const registry = resolve("build/visual-captures/ios/fixture-registry.json");
    await writeFile(registry + ".provenance.json", JSON.stringify({ sourceSha256: await sourceIdentity(repoRoot, platform), registrySha256: await sha256(registry) }));
  } else throw new Error("Usage: evidence.mjs <begin|finish> <reference> <actual> <ios|web>");
}
