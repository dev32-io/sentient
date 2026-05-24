import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Result } from "@sentient/protocol";
import { VALID_FORWARD, VALID_REVERSE, type WizardStepId } from "@sentient/wizard";
import { parse, stringify } from "yaml";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "install-state"]);

const CURRENT_SCHEMA_VERSION = "0.2.0";

export type WizardCursor = WizardStepId;

export interface InstallStateData {
  schema_version: string;
  installed_version: string;
  last_upgraded_from: string | null;
  last_upgraded_at: string | null;
  bootstrap_complete: boolean;
  wizard_cursor: WizardCursor;
  unlock_verified: boolean;
}

export type InstallStateError =
  | { kind: "io-failed"; reason: string }
  | { kind: "parse-failed"; reason: string }
  | { kind: "cursor-mismatch"; expected: WizardCursor; actual: WizardCursor }
  | { kind: "already-complete" }
  | { kind: "invalid-transition"; from: WizardCursor; to: WizardCursor };

export interface InstallStateConfig {
  statePath: string;
  templateDir: string;
  /** Gateway version baked at build time; written as installed_version when
   *  bootstrapping a fresh state.yaml for the first time. */
  gatewayVersion: string;
}

export interface InstallState {
  load(): Promise<InstallStateData>;
  advanceCursor(from: WizardCursor, to: WizardCursor): Promise<Result<void, InstallStateError>>;
  retreatCursor(from: WizardCursor, to: WizardCursor): Promise<Result<void, InstallStateError>>;
  setUnlockVerified(): Promise<Result<void, InstallStateError>>;
  finish(): Promise<Result<void, InstallStateError>>;
}

function transitionKey(from: WizardCursor, to: WizardCursor): string {
  return `${from}→${to}`;
}

function migrate(raw: unknown): InstallStateData {
  const data = raw as Record<string, unknown>;
  if (data.schema_version === CURRENT_SCHEMA_VERSION) {
    return data as unknown as InstallStateData;
  }
  if (data.schema_version === "0.1.0" && data.wizard_cursor === "complete") {
    // The "complete" cursor in v0.1.0 covered both the AccountWizard
    // step (when bootstrap_complete=false) and the post-finalize state
    // (when bootstrap_complete=true). v0.2.0 splits these into "admin"
    // and "finish" respectively.
    data.wizard_cursor = data.bootstrap_complete ? "finish" : "admin";
    log.info("install-state.migrated", {
      from: "0.1.0",
      to: CURRENT_SCHEMA_VERSION,
      newCursor: data.wizard_cursor,
    });
  }
  data.schema_version = CURRENT_SCHEMA_VERSION;
  return data as unknown as InstallStateData;
}

export function createInstallState(cfg: InstallStateConfig): InstallState {
  let cached: InstallStateData | null = null;

  async function readFromDisk(): Promise<InstallStateData | null> {
    try {
      const raw = await fs.readFile(cfg.statePath, "utf8");
      const parsed = parse(raw) as unknown;
      const originalSchema = (parsed as Record<string, unknown>).schema_version;
      const migrated = migrate(parsed);
      if (originalSchema !== CURRENT_SCHEMA_VERSION) {
        // Persist the migration result so subsequent boots skip migrate().
        await writeAtomic(migrated);
      }
      return migrated;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  async function writeAtomic(data: InstallStateData): Promise<void> {
    const tmp = `${cfg.statePath}.tmp`;
    await fs.mkdir(dirname(cfg.statePath), { recursive: true });
    await fs.writeFile(tmp, stringify(data), { mode: 0o644 });
    await fs.rename(tmp, cfg.statePath);
  }

  async function bootstrap(): Promise<InstallStateData> {
    const tmplPath = join(cfg.templateDir, "state.yaml.tmpl");
    const tmpl = await fs.readFile(tmplPath, "utf8");
    const rendered = tmpl.replaceAll("{{installed_version}}", cfg.gatewayVersion);
    const data = parse(rendered) as InstallStateData;
    await writeAtomic(data);
    log.info("install-state.bootstrapped", { path: cfg.statePath });
    return data;
  }

  return {
    async load(): Promise<InstallStateData> {
      const existing = await readFromDisk();
      if (existing) {
        cached = existing;
        return existing;
      }
      const fresh = await bootstrap();
      cached = fresh;
      return fresh;
    },

    async advanceCursor(from, to) {
      try {
        const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
        if (state.bootstrap_complete) return { ok: false, error: { kind: "already-complete" } };
        if (state.wizard_cursor !== from) {
          return { ok: false, error: { kind: "cursor-mismatch", expected: from, actual: state.wizard_cursor } };
        }
        if (!VALID_FORWARD.has(transitionKey(from, to))) {
          return { ok: false, error: { kind: "invalid-transition", from, to } };
        }
        const next = { ...state, wizard_cursor: to };
        await writeAtomic(next);
        cached = next;
        log.info("install-state.cursor-advanced", { from, to });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        return { ok: false, error: { kind: "io-failed", reason: (err as Error).message } };
      }
    },

    async retreatCursor(from, to) {
      try {
        const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
        if (state.bootstrap_complete) return { ok: false, error: { kind: "already-complete" } };
        if (state.wizard_cursor !== from) {
          return { ok: false, error: { kind: "cursor-mismatch", expected: from, actual: state.wizard_cursor } };
        }
        if (!VALID_REVERSE.has(transitionKey(from, to))) {
          return { ok: false, error: { kind: "invalid-transition", from, to } };
        }
        const next = { ...state, wizard_cursor: to };
        await writeAtomic(next);
        cached = next;
        log.info("install-state.cursor-retreated", { from, to });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        return { ok: false, error: { kind: "io-failed", reason: (err as Error).message } };
      }
    },

    async setUnlockVerified() {
      try {
        const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
        if (state.unlock_verified) return { ok: true, value: undefined };
        const next = { ...state, unlock_verified: true };
        await writeAtomic(next);
        cached = next;
        log.info("install-state.unlock-verified");
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        return { ok: false, error: { kind: "io-failed", reason: (err as Error).message } };
      }
    },

    async finish() {
      try {
        const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
        if (state.wizard_cursor !== "finish") {
          return { ok: false, error: { kind: "cursor-mismatch", expected: "finish", actual: state.wizard_cursor } };
        }
        if (state.bootstrap_complete) return { ok: true, value: undefined };
        const next = { ...state, bootstrap_complete: true };
        await writeAtomic(next);
        cached = next;
        log.info("install-state.bootstrap-complete");
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        return { ok: false, error: { kind: "io-failed", reason: (err as Error).message } };
      }
    },
  };
}
