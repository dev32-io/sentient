import { describe, expect, it, vi } from "vitest";
import type { WizardDeps } from "../../step-pipeline.ts";
import { handleFinish } from "../finish.ts";

function makeDeps(cursor: string, bootstrap_complete = false) {
  const finish = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const clear = vi.fn(async () => undefined);
  const deps = {
    installState: {
      load: vi.fn(async () => ({
        bootstrap_complete,
        unlock_verified: true,
        wizard_cursor: cursor,
        schema_version: "0.2.0",
        installed_version: "0.4.0",
        last_upgraded_from: null,
        last_upgraded_at: null,
      })),
      finish,
    },
    unlockCode: { clear },
  } as unknown as WizardDeps;
  return { deps, finish, clear };
}

describe("handleFinish", () => {
  it("returns 200 and clears unlock when cursor=finish", async () => {
    const { deps, finish, clear } = makeDeps("finish");
    const res = await handleFinish(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(finish).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("returns 410 when bootstrap_complete=true", async () => {
    const { deps } = makeDeps("finish", true);
    const res = await handleFinish(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(410);
  });

  it("returns 409 when cursor != finish", async () => {
    const { deps, finish } = makeDeps("admin");
    const res = await handleFinish(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(409);
    expect(finish).not.toHaveBeenCalled();
  });
});
