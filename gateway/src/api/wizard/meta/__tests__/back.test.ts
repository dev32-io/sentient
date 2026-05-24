import { describe, expect, it, vi } from "vitest";
import type { WizardDeps } from "../../step-pipeline.js";
import { handleBack } from "../back.js";

function makeDeps() {
  const retreatCursor = vi.fn(async () => ({ ok: true, value: undefined }));
  const deps = {
    installState: {
      load: async () => ({
        bootstrap_complete: false,
        unlock_verified: true,
        wizard_cursor: "secrets",
        schema_version: "0.2.0",
        installed_version: "0.4.0",
        last_upgraded_from: null,
        last_upgraded_at: null,
      }),
      retreatCursor,
    },
  } as unknown as WizardDeps;
  return { deps, retreatCursor };
}

describe("handleBack", () => {
  it("derives target from registry: from=voice → to=provider", async () => {
    const { deps, retreatCursor } = makeDeps();
    await handleBack(
      deps,
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ from: "voice" }),
      }),
    );
    expect(retreatCursor).toHaveBeenCalledWith("voice", "provider");
  });

  it("derives target from registry: from=secrets → to=voice", async () => {
    const { deps, retreatCursor } = makeDeps();
    await handleBack(
      deps,
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ from: "secrets" }),
      }),
    );
    expect(retreatCursor).toHaveBeenCalledWith("secrets", "voice");
  });

  it("returns 409 when from has no backTo (e.g. provider)", async () => {
    const { deps, retreatCursor } = makeDeps();
    const res = await handleBack(
      deps,
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ from: "provider" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(retreatCursor).not.toHaveBeenCalled();
  });
});
