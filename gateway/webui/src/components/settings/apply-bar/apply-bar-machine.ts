// gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts

/**
 * A pending change. `slow` ops require the gateway to re-render and rewrite
 * the on-disk Hermes profile (config.yaml / SOUL.md) before the change is
 * live — Hermes is a one-shot exec per delegation, so the next delegation
 * simply reads the new file; there is no process to restart. `fast` ops
 * persist directly with nothing further to apply.
 */
export interface PendingOp {
  key: string;
  kind: "fast" | "slow";
}

/** External-facing state of the apply bar. */
export type ApplyBarState =
  | { phase: "idle"; pending: PendingOp[] }
  | { phase: "saving"; pending: PendingOp[] }
  | { phase: "restarting"; pending: PendingOp[] }
  | { phase: "ready"; elapsedMs: number }
  | { phase: "failed"; errorMessage: string };

/**
 * Label for the Apply button. Always "Apply" — there is no restart to
 * distinguish; a `slow` op's extra profile rewrite is a background disk
 * write (measured 8-12ms), invisible to the user.
 */
export function applyButtonLabel(_pending: PendingOp[]): string {
  return "Apply";
}

/** True when at least one pending op is dirty. */
export function isDirty(pending: PendingOp[]): boolean {
  return pending.length > 0;
}

// ----- Pending ops with payload -----

export interface FastOp extends PendingOp {
  kind: "fast";
  payload: unknown;
}
export interface SlowOp extends PendingOp {
  kind: "slow";
  payload: unknown;
}

export type PendingOpWithPayload = FastOp | SlowOp;

// ----- Save dependencies (injected by the React component) -----

export interface SaveResult {
  ok: boolean;
  elapsedMs?: number;
  errorMessage?: string;
}

export interface RestartWaitResult {
  state: "ready" | "failed";
  elapsedMs: number;
}

export interface ApplyDeps {
  saveSoul(body: string): Promise<SaveResult>;
  saveMemoryDoc(slot: "memory" | "user", body: string): Promise<SaveResult>;
  saveProfile(profileDraft: unknown): Promise<SaveResult>;
  savePersonalityActive(name: string): Promise<SaveResult>;
  savePersonalityBody(name: string, body: string): Promise<SaveResult>;
  savePersonalityCreate(name: string, body: string): Promise<SaveResult>;
  savePersonalityDelete(name: string): Promise<SaveResult>;
  waitForRestart(): Promise<RestartWaitResult>;
  /**
   * Optional — called after a successful profile save when the audio sub-tree
   * changed. Pushes a `user.preferences.patch` WS frame so the live
   * PreferenceManager picks up the new values without waiting for reconnect.
   */
  patchLivePreferences?(patch: { ttsEnabled: boolean; channel: "voice" | "text" }): void;
}

export interface ApplyOutcome {
  ok: boolean;
  errorMessage?: string;
}

/**
 * Walks pending ops, dispatches each to the right save dep, then
 * (if any slow op was in the batch) waits for the profile render+write to
 * finish — there is no Hermes process to restart, just a file to rewrite
 * before the next delegation reads it.
 * Emits state transitions via `onState` so the UI can drive the spinner.
 *
 * Stops on first failure. Caller is responsible for keeping pending
 * ops in dirty until the user acks the failure or retries.
 */
export async function runApply(
  pending: PendingOpWithPayload[],
  deps: ApplyDeps,
  onState: (s: ApplyBarState) => void,
): Promise<ApplyOutcome> {
  if (pending.length === 0) return { ok: true };

  onState({ phase: "saving", pending });

  for (const op of pending) {
    const r = await dispatchOp(op, deps);
    if (!r.ok) {
      const msg = r.errorMessage ?? `Save failed for ${op.key}`;
      onState({ phase: "failed", errorMessage: msg });
      return { ok: false, errorMessage: msg };
    }
  }

  const hasSlow = pending.some((op) => op.kind === "slow");
  if (!hasSlow) {
    onState({ phase: "ready", elapsedMs: 0 });
    return { ok: true };
  }

  onState({ phase: "restarting", pending });
  const restart = await deps.waitForRestart();
  if (restart.state === "failed") {
    const msg = "Your assistant didn't come back up. Try again.";
    onState({ phase: "failed", errorMessage: msg });
    return { ok: false, errorMessage: msg };
  }

  onState({ phase: "ready", elapsedMs: restart.elapsedMs });
  return { ok: true };
}

async function dispatchOp(op: PendingOpWithPayload, deps: ApplyDeps): Promise<SaveResult> {
  switch (op.key) {
    case "secrets.changed":
      // Secrets are eagerly saved by the row-level save handler; the op
      // exists only so the apply bar can drive a profile re-render so the
      // rendered Hermes config picks up the new key. Nothing to commit at
      // apply time.
      return { ok: true };
    case "systemPrompt.soul":
      return deps.saveSoul(op.payload as string);
    case "memory.memory":
      return deps.saveMemoryDoc("memory", op.payload as string);
    case "memory.user":
      return deps.saveMemoryDoc("user", op.payload as string);
    case "personalities.active":
      return deps.savePersonalityActive((op.payload as { name: string }).name);
    case "personalities.new":
      return deps.savePersonalityCreate(
        (op.payload as { name: string; body: string }).name,
        (op.payload as { name: string; body: string }).body,
      );
    default:
      if (op.key.startsWith("personalities.delete:")) {
        return deps.savePersonalityDelete(op.key.slice("personalities.delete:".length));
      }
      if (op.key.startsWith("personalities.")) {
        const name = op.key.slice("personalities.".length);
        return deps.savePersonalityBody(name, (op.payload as { body: string }).body);
      }
      if (op.key === "profile" || op.key.startsWith("profile.")) {
        const result = await deps.saveProfile(op.payload);
        if (result.ok && deps.patchLivePreferences) {
          const profile = op.payload as { audio: { ttsEnabled: boolean; channel: "voice" | "text" } };
          deps.patchLivePreferences({
            ttsEnabled: profile.audio.ttsEnabled,
            channel: profile.audio.channel,
          });
        }
        return result;
      }
      return { ok: false, errorMessage: `unknown op key: ${op.key}` };
  }
}
