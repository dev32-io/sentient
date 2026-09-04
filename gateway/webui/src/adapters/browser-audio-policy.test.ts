import { describe, expect, it, vi } from "vitest";
import { resolveBrowserAudioPolicy, setCaptureAecEnabled } from "./browser-audio-policy.ts";

const protectedCapture = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const existingCapture = {
  echoCancellation: true,
  noiseSuppression: true,
};

describe("browser audio policy", () => {
  it.each([
    {
      name: "old Firefox on macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:78.0) Gecko/20100101 Firefox/78.0",
      platform: "MacIntel",
    },
    {
      name: "current Firefox on macOS with a reduced platform",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0",
      platform: "",
    },
  ])("disables browser capture processing and WebRTC AEC for $name", ({ userAgent, platform }) => {
    expect(resolveBrowserAudioPolicy({ userAgent, platform })).toEqual({
      captureProcessing: protectedCapture,
      webRtcAecLoopback: false,
    });
  });

  it("keeps the hook-owned AEC control off for Firefox on macOS", () => {
    const policy = resolveBrowserAudioPolicy({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0",
      platform: "MacIntel",
    });
    const control = { setAecEnabled: vi.fn() };

    setCaptureAecEnabled(control, policy, true);

    expect(control.setAecEnabled).toHaveBeenCalledWith(false);
  });

  it.each([
    {
      name: "Firefox on Windows",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0",
      platform: "Win32",
    },
    {
      name: "Firefox on Linux",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0",
      platform: "Linux x86_64",
    },
    {
      name: "Safari on macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      platform: "MacIntel",
    },
    {
      name: "Chrome on macOS",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
      platform: "MacIntel",
    },
  ])("preserves existing processing and AEC for $name", ({ userAgent, platform }) => {
    expect(resolveBrowserAudioPolicy({ userAgent, platform })).toEqual({
      captureProcessing: existingCapture,
      webRtcAecLoopback: true,
    });
  });
});
