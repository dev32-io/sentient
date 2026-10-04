import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findIosDesignBoundaryViolations } from "./ios-design-boundary";

const source = (path: string) => readFileSync(`ios/App/Settings/${path}.swift`, "utf8");

test("audited Model chooser uses canonical consumer boundary", () => {
  expect(
    findIosDesignBoundaryViolations([
      { path: "ios/App/Settings/Model/ModelScreen.swift", source: source("Model/ModelScreen") },
    ]),
  ).toEqual([]);
});

test("Settings Discard stays in place; confirmed Back resets drafts before leaving", () => {
  for (const name of ["Audio", "Advanced", "Memory", "Model", "SystemPrompt", "Tools"]) {
    const screen = source(`${name}/${name}Screen`);
    expect(screen).toContain("onDiscard: vm.discard");
    expect(screen).toMatch(
      /Button\("Discard", role: \.destructive\) \{\s*guard !vm\.isApplying[^\n]*\n\s*vm\.discard\(\)\s*onBack\(\)/,
    );
    expect(screen).toMatch(/private func attemptBack\(\) \{\s*guard !vm\.isApplying/);
    expect(screen).toContain("allowsInteractiveBack: !vm.isDirty && !vm.isApplying");
  }
});

test("noncancelable native sheets and Voice routes guard dismissal without overlays", () => {
  for (const path of ["Account/ChangePinSheet", "Members/AddMemberSheet", "Personalities/PersonalityCreateSheet"]) {
    const sheet = source(path);
    expect(sheet).toContain(".interactiveDismissDisabled(busy)");
    expect(sheet).toContain('Button("Cancel") { if !busy { dismiss() } }');
    expect(sheet).toContain("isEnabled: !busy");
    expect(sheet).toContain("submitting = true");
  }
  expect(source("Voice/VoiceAddScreen")).toContain("allowsInteractiveBack: !vm.submitting");
  const fish = source("Voice/VoiceFishScreen");
  expect(fish).toContain("allowsInteractiveBack: !vm.cloning");
  expect(fish).toContain('title: "Cancel", role: .quiet, state: vm.cloning ? .disabled : .normal');
});

test("Settings document previews reuse R without granting image fetch authority", () => {
  for (const name of ["Memory", "SystemPrompt"]) {
    const screen = source(`${name}/${name}Screen`);
    expect(screen).toMatch(/MessageDocumentSurface\(source: [^,]+, imageCache: nil\)/);
    expect(screen).not.toMatch(/Text\((?:state|vm)\.draft/);
    expect(screen).toContain("usesMonospacedText: true");
    expect(screen).toContain("DesignSettingsEditor(");
  }
});
