import { describe, expect, it, vi } from "vitest";
import { secretsStep } from "../secrets.ts";

function makeStore() {
  return {
    setHomeAssistantUrl: vi.fn(async () => ({ ok: true, value: undefined })),
    setHomeAssistantLocalIp: vi.fn(async () => ({ ok: true, value: undefined })),
    setHomeAssistantToken: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantUrl: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantLocalIp: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantToken: vi.fn(async () => ({ ok: true, value: undefined })),
  };
}

describe("secretsStep", () => {
  it("parses empty body as { } (all fields optional)", async () => {
    const req = new Request("http://x/", { method: "POST", body: "{}" });
    const r = await secretsStep.parse(req);
    expect(r.ok).toBe(true);
  });

  it("apply writes both ha + ma fields when present", async () => {
    const secretsStore = makeStore();
    await secretsStep.apply(
      { secretsStore } as never,
      {
        home_assistant: { url: "http://h", local_ip: "1.2.3.4", observe_token: "o", mcp_server_token: "m" },
        music_assistant: { url: "http://m", local_ip: "1.2.3.4", token: "t" },
      } as never,
    );
    expect(secretsStore.setHomeAssistantUrl).toHaveBeenCalledWith("http://h");
    expect(secretsStore.setHomeAssistantLocalIp).toHaveBeenCalledWith("1.2.3.4");
    expect(secretsStore.setHomeAssistantToken).toHaveBeenCalledWith("observe_token", "o");
    expect(secretsStore.setHomeAssistantToken).toHaveBeenCalledWith("mcp_server_token", "m");
    expect(secretsStore.setMusicAssistantUrl).toHaveBeenCalledWith("http://m");
    expect(secretsStore.setMusicAssistantToken).toHaveBeenCalledWith("t");
  });

  it("postAdvance kicks orchestrator.applyAll", () => {
    const applyAll = vi.fn(async () => ({}));
    secretsStep.postAdvance?.({ systemOrchestrator: { applyAll } } as never);
    expect(applyAll).toHaveBeenCalledOnce();
  });

  it("postAdvance is no-op when orchestrator is null", () => {
    expect(() => secretsStep.postAdvance?.({ systemOrchestrator: null } as never)).not.toThrow();
  });
});
