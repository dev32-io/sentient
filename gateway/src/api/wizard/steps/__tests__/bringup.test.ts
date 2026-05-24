import { describe, expect, it, vi } from "vitest";
import type { WizardDeps } from "../../step-pipeline.ts";
import { handleComplete, handleRetry } from "../bringup.ts";

function makeDeps(opts: {
  cursor: string;
  bootstrap_complete?: boolean;
  status?: { state: string };
}) {
  const advanceCursor = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const applyAll = vi.fn(async () => ({}));
  const deps = {
    installState: {
      load: async () => ({
        bootstrap_complete: opts.bootstrap_complete ?? false,
        unlock_verified: true,
        wizard_cursor: opts.cursor,
        schema_version: "0.2.0",
        installed_version: "0.4.0",
        last_upgraded_from: null,
        last_upgraded_at: null,
      }),
      advanceCursor,
    },
    systemOrchestrator: {
      getStatus: () => opts.status ?? { state: "applying" },
      applyAll,
    },
  } as unknown as WizardDeps;
  return { deps, advanceCursor, applyAll };
}

describe("bringup retry", () => {
  it("kicks applyAll when cursor=bringup", async () => {
    const { deps, applyAll } = makeDeps({ cursor: "bringup" });
    const res = await handleRetry(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(applyAll).toHaveBeenCalledOnce();
  });

  it("returns 409 when cursor != bringup", async () => {
    const { deps } = makeDeps({ cursor: "secrets" });
    const res = await handleRetry(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(409);
  });
});

describe("bringup complete", () => {
  it("advances cursor bringup → admin when orchestrator ready", async () => {
    const { deps, advanceCursor } = makeDeps({ cursor: "bringup", status: { state: "ready" } });
    const res = await handleComplete(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cursor).toBe("admin");
    expect(advanceCursor).toHaveBeenCalledWith("bringup", "admin");
  });

  it("returns 412 when orchestrator not ready", async () => {
    const { deps } = makeDeps({ cursor: "bringup", status: { state: "applying" } });
    const res = await handleComplete(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(412);
  });
});
