#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { caseIdFromReference, fixtureIdFromReference } from "./reference-image.mjs";
import { sha256, sourceIdentity } from "./evidence.mjs";

export function joinCoverage(references, fixtures, registeredFamilies) {
  const byId = new Map();
  for (const fixture of fixtures ?? []) {
    if (!fixture.fixtureId || byId.has(fixture.fixtureId)) throw new Error(`Unknown/duplicate fixture ID: ${fixture.fixtureId}`);
    if (fixture.fixtureId.split("--")[0] !== fixture.componentId) throw new Error(`Wrong component fixture: ${fixture.fixtureId}`);
    if (!["supported", "missing"].includes(fixture.applicability)) throw new Error(`Unknown fixture applicability: ${fixture.fixtureId}`);
    byId.set(fixture.fixtureId, fixture);
  }
  const seen = new Set();
  return references.map(reference => {
    const caseId = caseIdFromReference(reference);
    if (seen.has(caseId)) throw new Error(`Duplicate authority: ${caseId}`);
    seen.add(caseId);
    const fixtureId = fixtureIdFromReference(reference);
    const fixture = byId.get(fixtureId);
    const family = fixtureId.split("--")[0];
    return {
      caseId, referencePath: reference, fixtureId: fixture?.fixtureId ?? null,
      componentId: family, recording: caseId.includes("/recordings/") ? caseId.split("/")[2] : null,
      status: fixture?.applicability === "supported" ? "real-fixture" : fixture ? "missing"
        : fixtures || !registeredFamilies.has(family) ? "missing" : "needs-review",
      reason: fixture?.reason ?? (fixture ? "Registered production adapter; no capture/pass claimed"
        : fixtures || !registeredFamilies.has(family) ? "No real fixture" : "Family registered; exact native registry export unavailable"),
      visualPass: false, motionProof: false,
    };
  });
}

export async function coverageInventory(repoRoot, registryPath) {
  const inventory = JSON.parse(await readFile(resolve(repoRoot, "qa/design-refresh/inventory.json"), "utf8"));
  const registrySource = await readFile(resolve(repoRoot, "ios/Tests/VisualDiffFixtureRegistry.swift"), "utf8");
  const componentBlock = registrySource.split("private static let components:")[1].split("static func resolve")[0];
  const registeredFamilies = new Set([...componentBlock.matchAll(/\b(\w+)FixtureCatalog\.registration/g)].map(match =>
    match[1] === "ComposerVisual" ? "composer" : match[1].replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()));
  let fixtures = null;
  if (registryPath) {
    const provenance = JSON.parse(await readFile(registryPath + ".provenance.json", "utf8"));
    if (provenance.registrySha256 !== await sha256(registryPath) || provenance.sourceSha256 !== await sourceIdentity(repoRoot, "ios")) throw new Error("Stale registry export; recapture registry before joining");
    fixtures = JSON.parse(await readFile(registryPath, "utf8"));
  }
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "design/prototype", "ios/App"], { cwd: repoRoot, timeout: 30_000 }).toString().split("\0").filter(Boolean);
  const addedSource = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "ios/App"], { cwd: repoRoot, timeout: 30_000 }).toString().split("\0").filter(path => path.endsWith(".swift"));
  const files = [...new Set([...tracked, ...addedSource])].sort();
  const references = files.filter(path => /\/handoff\/(?:static\/[^/]+|recordings\/[^/]+\/[^/]+)\.png$/.test(path));
  const cases = joinCoverage(references, fixtures, registeredFamilies);
  for (const entry of cases) entry.referenceSha256 = await sha256(resolve(repoRoot, entry.referencePath));
  const shipped = inventory.rows.filter(row => row.platform === "ios").map(row => ({
    inventoryId: row.id, implementationPath: row.implementationPath, state: row.state,
    authority: row.designAuthority, nativeAdaptation: row.intentionalNativeAdaptation,
    nativeAuthority: row.designAuthority.some(authority => authority.startsWith("native:iOS:")),
    nativeOnly: row.implementationPath === "ios/App/SDK/BackendSetupView.swift" ? true : null,
    requiredConfigurations: row.requiredConfigurations, fixtureId: null, status: "missing",
    reason: "Inventory catalog has no production row dispatch; labeled specimens cannot count as coverage",
  }));
  const source = files.filter(path => path.startsWith("ios/App/") && path.endsWith(".swift")).map(path => ({
    implementationPath: path, inventoryIds: shipped.filter(row => row.implementationPath === path).map(row => row.inventoryId),
    status: "needs-review", reason: "Source reachability inventory, not runtime visual proof; may be nonvisual",
  }));
  return {
    version: 1, registryExport: registryPath ?? "unavailable", sourceSha256: await sourceIdentity(repoRoot, "ios"),
    summary: { handoffCases: cases.length, shippedStates: shipped.length, sourceFiles: source.length,
      handoffStatuses: Object.fromEntries(["real-fixture", "missing", "needs-review"].map(status => [status, cases.filter(row => row.status === status).length])),
      visualPasses: 0, motionProofs: 0 }, cases, shipped, source,
    fixtureOnlyCases: (fixtures ?? []).filter(fixture => !references.some(reference => fixtureIdFromReference(reference) === fixture.fixtureId))
      .map(fixture => ({ ...fixture, status: "needs-review", reason: "Registry-only state with no handoff PNG; not added to handoff denominator", visualPass: false, motionProof: false })),
    nativeOnlyGaps: [{ implementationPath: "ios/App/SDK/BackendSetupView.swift", status: "missing",
      states: ["host validation", "port validation", "TLS", "self-signed warning", "plain ws", "local network warning", "save loading", "save failure", "save success", "keyboard", "accessibility3"],
      reason: "Source-derived BND-01 inventory; no equivalent web setup flow, no real visual fixture. Preserve trust warnings/security defaults." }],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(await coverageInventory(process.cwd(), process.argv[2]), null, 2) + "\n");
}
