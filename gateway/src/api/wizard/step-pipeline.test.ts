import type { WizardStepDef } from "@sentient/wizard";
import { describe, expect, it, vi } from "vitest";
import { type StepHandler, runStep } from "./step-pipeline.ts";

function makeInstallState(initial: { wizard_cursor: string; bootstrap_complete?: boolean; unlock_verified?: boolean }) {
  let cursor = initial.wizard_cursor;
  return {
    load: async () => ({
      bootstrap_complete: initial.bootstrap_complete ?? false,
      unlock_verified: initial.unlock_verified ?? true,
      wizard_cursor: cursor,
      schema_version: "0.2.0",
      installed_version: "0.4.0",
      last_upgraded_from: null,
      last_upgraded_at: null,
    }),
    advanceCursor: async (_from: string, to: string) => {
      cursor = to;
      return { ok: true as const, value: undefined };
    },
    retreatCursor: async () => ({ ok: true as const, value: undefined }),
    setUnlockVerified: async () => ({ ok: true as const, value: undefined }),
    finish: async () => ({ ok: true as const, value: undefined }),
  };
}

describe("runStep", () => {
  const def: WizardStepDef = {
    id: "provider",
    advanceTo: "voice",
    backTo: null,
    label: "Provider",
  };

  it("returns 410 when wizard is closed", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider", bootstrap_complete: true });
    const handler: StepHandler<{ x: number }> = {
      id: "provider",
      parse: async () => ({ ok: true, value: { x: 1 } }),
      apply: async () => ({ ok: true, value: undefined }),
    };
    const res = await runStep({ installState } as never, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(410);
  });

  it("returns 400 when parse fails", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const handler: StepHandler<unknown> = {
      id: "provider",
      parse: async () => ({ ok: false, error: "invalid-body" }),
      apply: async () => ({ ok: true, value: undefined }),
    };
    const res = await runStep({ installState } as never, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("advances cursor on success and returns { ok, cursor }", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const advanceSpy = vi.spyOn(installState, "advanceCursor");
    const handler: StepHandler<Record<string, never>> = {
      id: "provider",
      parse: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: true, value: undefined }),
    };
    const res = await runStep({ installState } as never, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cursor: "voice" });
    expect(advanceSpy).toHaveBeenCalledWith("provider", "voice");
  });

  it("fires postAdvance after cursor write succeeds", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const postAdvance = vi.fn();
    const handler: StepHandler<Record<string, never>> = {
      id: "provider",
      parse: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: true, value: undefined }),
      postAdvance,
    };
    await runStep({ installState } as never, handler, def, new Request("http://x/", { method: "POST" }));
    expect(postAdvance).toHaveBeenCalledOnce();
  });

  it("returns 500 when apply fails", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const handler: StepHandler<Record<string, never>> = {
      id: "provider",
      parse: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: false, error: { kind: "io-failed" } }),
    };
    const res = await runStep({ installState } as never, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.kind).toBe("io-failed");
  });
});
