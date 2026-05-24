import { describe, expect, it, vi } from "vitest";
import type { WizardDeps } from "../../step-pipeline.js";
import { handleUnlock } from "../unlock.js";

function makeDeps(opts: { codeValid: boolean; bootstrap_complete?: boolean }) {
  const setUnlockVerified = vi.fn(async () => ({ ok: true, value: undefined }));
  const deps = {
    installState: {
      load: async () => ({
        bootstrap_complete: opts.bootstrap_complete ?? false,
        unlock_verified: false,
        wizard_cursor: "provider",
        schema_version: "0.2.0",
        installed_version: "0.4.0",
        last_upgraded_from: null,
        last_upgraded_at: null,
      }),
      setUnlockVerified,
    },
    unlockCode: { verify: async () => opts.codeValid },
  } as unknown as WizardDeps;
  return { deps, setUnlockVerified };
}

describe("handleUnlock", () => {
  it("400 on bad body", async () => {
    const { deps } = makeDeps({ codeValid: false });
    const res = await handleUnlock(deps, new Request("http://x/", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });

  it("410 when bootstrap_complete", async () => {
    const { deps } = makeDeps({ codeValid: true, bootstrap_complete: true });
    const res = await handleUnlock(
      deps,
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ code: "123456" }),
      }),
    );
    expect(res.status).toBe(410);
  });

  it("401 on invalid code", async () => {
    const { deps } = makeDeps({ codeValid: false });
    const res = await handleUnlock(
      deps,
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ code: "999999" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("200 + sets unlock_verified on valid code", async () => {
    const { deps, setUnlockVerified } = makeDeps({ codeValid: true });
    const res = await handleUnlock(
      deps,
      new Request("http://x/", {
        method: "POST",
        body: JSON.stringify({ code: "123456" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(setUnlockVerified).toHaveBeenCalledOnce();
  });
});
