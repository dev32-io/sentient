import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "../../profile-store/profile-types.js";
import { reconcileSignalPaired } from "./boot-reconciler.js";

function writeProfileEnv(hermesHome: string, userId: string, contents: string): void {
  const dir = join(hermesHome, "profiles", userId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
}

function stubProfile(overrides?: Partial<ProfileV1>): ProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION as 1,
    userId: "u_abc",
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {}, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
    ...overrides,
  };
}

describe("reconcileSignalPaired", () => {
  let hermesHome: string;

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), "signal-reconcile-"));
  });
  afterEach(() => {
    rmSync(hermesHome, { recursive: true, force: true });
  });

  test("returns profile unchanged when devices.signal.paired is not true", async () => {
    const profile = stubProfile();
    const out = await reconcileSignalPaired(profile, hermesHome);
    expect(out).toBe(profile);
  });

  test("returns profile unchanged when paired and profile .env has SIGNAL_ACCOUNT", async () => {
    writeProfileEnv(hermesHome, "u_abc", "SIGNAL_ACCOUNT=+15551234567\n");
    const profile = stubProfile({
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    });
    const out = await reconcileSignalPaired(profile, hermesHome);
    expect(out.devices?.signal?.paired).toBe(true);
  });

  test("clears paired flag when profile .env is missing", async () => {
    const profile = stubProfile({
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    });
    const out = await reconcileSignalPaired(profile, hermesHome);
    expect(out.devices?.signal?.paired).toBe(false);
  });

  test("clears paired flag when profile .env exists but lacks SIGNAL_ACCOUNT", async () => {
    writeProfileEnv(hermesHome, "u_abc", "FOO=bar\n");
    const profile = stubProfile({
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    });
    const out = await reconcileSignalPaired(profile, hermesHome);
    expect(out.devices?.signal?.paired).toBe(false);
  });

  test("ignores root-level hermesHome/.env (legacy path) when profile .env is missing", async () => {
    // Legacy bug: pre-fix, the reconciler read ${hermesHome}/.env and would
    // incorrectly accept profiles based on the wrong file. The correct path is
    // ${hermesHome}/profiles/<userId>/.env per hermes -p resolution rules.
    writeFileSync(join(hermesHome, ".env"), "SIGNAL_ACCOUNT=+15551234567\n");
    const profile = stubProfile({
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    });
    const out = await reconcileSignalPaired(profile, hermesHome);
    expect(out.devices?.signal?.paired).toBe(false);
  });
});
