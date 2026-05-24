import { describe, expect, it, vi } from "vitest";
import { createPreferenceManager } from "../cerebrum/preferences.js";
import { handlePreferencesPatch } from "./handle-preferences-patch.js";

function makePm() {
  return createPreferenceManager({
    initial: { language: "auto", channel: "voice", ttsEnabled: true },
  });
}

describe("handlePreferencesPatch", () => {
  it("applies a valid ttsEnabled patch", async () => {
    const pm = makePm();
    const persist = vi.fn(async () => {});
    await handlePreferencesPatch({
      raw: { type: "user.preferences.patch", payload: { ttsEnabled: false } },
      preferenceManager: pm,
      persistAudioPatch: persist,
      sessionId: "s1",
      userId: "alice",
    });
    expect(pm.get().ttsEnabled).toBe(false);
    expect(persist).toHaveBeenCalledWith("alice", { ttsEnabled: false });
  });

  it("rejects malformed payload silently", async () => {
    const pm = makePm();
    const persist = vi.fn(async () => {});
    await handlePreferencesPatch({
      raw: { type: "user.preferences.patch", payload: { ttsEnabled: "no" } },
      preferenceManager: pm,
      persistAudioPatch: persist,
      sessionId: "s1",
      userId: "alice",
    });
    expect(pm.get().ttsEnabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("ignores empty patch", async () => {
    const pm = makePm();
    const persist = vi.fn(async () => {});
    await handlePreferencesPatch({
      raw: { type: "user.preferences.patch", payload: {} },
      preferenceManager: pm,
      persistAudioPatch: persist,
      sessionId: "s1",
      userId: "alice",
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
