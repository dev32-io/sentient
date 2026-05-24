import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInstallState } from "./install-state.js";

const TEMPLATE_DIR = join(__dirname, "../../templates/wizard");

describe("InstallState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-state-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates state.yaml from template when missing", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    const state = await svc.load();
    expect(state.bootstrap_complete).toBe(false);
    expect(state.wizard_cursor).toBe("provider");
    expect(state.unlock_verified).toBe(false);
    expect(state.installed_version).toBe("1.0.0");
    expect(existsSync(join(dir, "state.yaml"))).toBe(true);
  });

  it("preserves existing state.yaml on second load", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    const reloaded = await svc.load();
    expect(reloaded.wizard_cursor).toBe("voice");
  });

  it("rejects cursor advance from wrong source", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    const result = await svc.advanceCursor("voice", "secrets");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("cursor-mismatch");
  });

  it("flips bootstrap_complete via finish()", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    await svc.advanceCursor("voice", "secrets");
    await svc.advanceCursor("secrets", "bringup");
    await svc.advanceCursor("bringup", "admin");
    await svc.advanceCursor("admin", "finish");
    await svc.finish();
    const state = await svc.load();
    expect(state.bootstrap_complete).toBe(true);
  });

  it("allows voice→secrets transition", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    const result = await svc.advanceCursor("voice", "secrets");
    expect(result.ok).toBe(true);
    const state = await svc.load();
    expect(state.wizard_cursor).toBe("secrets");
  });

  it("allows secrets→bringup transition", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    await svc.advanceCursor("voice", "secrets");
    const result = await svc.advanceCursor("secrets", "bringup");
    expect(result.ok).toBe(true);
    const state = await svc.load();
    expect(state.wizard_cursor).toBe("bringup");
  });

  it("allows bringup→admin transition", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    await svc.advanceCursor("voice", "secrets");
    await svc.advanceCursor("secrets", "bringup");
    const result = await svc.advanceCursor("bringup", "admin");
    expect(result.ok).toBe(true);
    const state = await svc.load();
    expect(state.wizard_cursor).toBe("admin");
  });

  it("rejects voice→bringup (skipping steps, invalid)", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    const result = await svc.advanceCursor("voice", "bringup");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-transition");
  });

  it("setUnlockVerified() flips flag idempotently", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.setUnlockVerified();
    let state = await svc.load();
    expect(state.unlock_verified).toBe(true);
    await svc.setUnlockVerified(); // second call, no error
    state = await svc.load();
    expect(state.unlock_verified).toBe(true);
  });

  it("retreatCursor allows secrets→voice", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    await svc.advanceCursor("voice", "secrets");
    const result = await svc.retreatCursor("secrets", "voice");
    expect(result.ok).toBe(true);
    const state = await svc.load();
    expect(state.wizard_cursor).toBe("voice");
  });

  it("retreatCursor allows voice→provider", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    const result = await svc.retreatCursor("voice", "provider");
    expect(result.ok).toBe(true);
    const state = await svc.load();
    expect(state.wizard_cursor).toBe("provider");
  });

  it("retreatCursor rejects bringup→secrets (irreversible)", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    await svc.advanceCursor("voice", "secrets");
    await svc.advanceCursor("secrets", "bringup");
    const result = await svc.retreatCursor("bringup", "secrets");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-transition");
  });

  it("finish() rejects when cursor is not 'finish'", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load(); // cursor starts at "provider"
    const result = await svc.finish();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("cursor-mismatch");
  });

  it("rejects skipping cursor transitions", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    await svc.load();
    const result = await svc.advanceCursor("provider", "bringup");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid-transition");
  });

  it("ignores stale temp file on load (atomic-write recovery)", async () => {
    // Simulate a crashed write: temp file exists but never renamed.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.yaml.tmp"), "garbage");
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "1.0.0",
    });
    const state = await svc.load();
    expect(state.bootstrap_complete).toBe(false);
  });
});

describe("install-state migration v0.1.0 → v0.2.0", () => {
  it("rewrites cursor='complete' + bootstrap_complete=false → cursor='admin'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-state-mig-"));
    const statePath = join(dir, "state.yaml");
    await writeFile(
      statePath,
      [
        'schema_version: "0.1.0"',
        'installed_version: "0.4.0"',
        "last_upgraded_from: null",
        "last_upgraded_at: null",
        "bootstrap_complete: false",
        'wizard_cursor: "complete"',
        "unlock_verified: true",
      ].join("\n"),
    );
    const state = createInstallState({
      statePath,
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "0.4.0",
    });
    const data = await state.load();
    expect(data.schema_version).toBe("0.2.0");
    expect(data.wizard_cursor).toBe("admin");
    expect(data.bootstrap_complete).toBe(false);
  });

  it("rewrites cursor='complete' + bootstrap_complete=true → cursor='finish'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-state-mig-"));
    const statePath = join(dir, "state.yaml");
    await writeFile(
      statePath,
      [
        'schema_version: "0.1.0"',
        'installed_version: "0.4.0"',
        "last_upgraded_from: null",
        "last_upgraded_at: null",
        "bootstrap_complete: true",
        'wizard_cursor: "complete"',
        "unlock_verified: true",
      ].join("\n"),
    );
    const state = createInstallState({
      statePath,
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "0.4.0",
    });
    const data = await state.load();
    expect(data.schema_version).toBe("0.2.0");
    expect(data.wizard_cursor).toBe("finish");
  });

  it("leaves v0.2.0 state unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-state-mig-"));
    const statePath = join(dir, "state.yaml");
    await writeFile(
      statePath,
      [
        'schema_version: "0.2.0"',
        'installed_version: "0.4.0"',
        "last_upgraded_from: null",
        "last_upgraded_at: null",
        "bootstrap_complete: false",
        'wizard_cursor: "voice"',
        "unlock_verified: true",
      ].join("\n"),
    );
    const state = createInstallState({
      statePath,
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "0.4.0",
    });
    const data = await state.load();
    expect(data.schema_version).toBe("0.2.0");
    expect(data.wizard_cursor).toBe("voice");
  });
});
