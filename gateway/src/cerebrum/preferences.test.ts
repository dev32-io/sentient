import { describe, expect, it, vi } from "vitest";
import { createPreferenceManager } from "./preferences.js";

describe("createPreferenceManager", () => {
  it("update detects ttsEnabled change and notifies listener", () => {
    const pm = createPreferenceManager({
      initial: { language: "auto", channel: "voice", ttsEnabled: true },
    });
    const listener = vi.fn();
    pm.onChange(listener);
    pm.update({ ttsEnabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[2]).toContain("ttsEnabled");
    expect(pm.get().ttsEnabled).toBe(false);
  });

  it("update is no-op when ttsEnabled value unchanged", () => {
    const pm = createPreferenceManager({
      initial: { language: "auto", channel: "voice", ttsEnabled: true },
    });
    const listener = vi.fn();
    pm.onChange(listener);
    pm.update({ ttsEnabled: true });
    expect(listener).not.toHaveBeenCalled();
  });
});
