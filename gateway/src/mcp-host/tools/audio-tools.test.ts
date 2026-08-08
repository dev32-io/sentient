import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionLookup } from "../active-session-lookup.js";
import { createPauseAudioTool, createResumeAudioTool } from "./audio-tools.js";

const fakeRouter = {
  bind: vi.fn(),
  release: vi.fn(),
  get: vi.fn(),
  updateConversationId: vi.fn(),
  findActiveSessionFor: vi.fn(),
} as unknown as ActiveSessionLookup;

const audio = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };

describe("pause_audio / resume_audio", () => {
  it("pause: calls audio.pause with session + reason", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue("s1");
    const t = createPauseAudioTool({ audio, router: fakeRouter });
    const r = await t.run({ reason: "user spoke" }, { sessionId: null, userId: "alice", sessionChannel: "voice" });
    expect(audio.pause).toHaveBeenCalledWith("s1", "user spoke");
    expect(r.isError).toBeUndefined();
  });

  it("resume: calls audio.resume", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue("s1");
    const t = createResumeAudioTool({ audio, router: fakeRouter });
    await t.run({}, { sessionId: null, userId: "alice", sessionChannel: "voice" });
    expect(audio.resume).toHaveBeenCalled();
  });

  it("errors when no userId", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const t = createPauseAudioTool({ audio, router: fakeRouter });
    const r = await t.run({}, { sessionId: null, userId: null, sessionChannel: "voice" });
    expect(r.isError).toBe(true);
  });

  it("errors when no active session for user", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const t = createPauseAudioTool({ audio, router: fakeRouter });
    const r = await t.run({}, { sessionId: null, userId: "bob", sessionChannel: "voice" });
    expect(r.isError).toBe(true);
  });
});
