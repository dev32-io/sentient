export interface BrowserAudioPolicy {
  readonly captureProcessing: Readonly<
    Pick<MediaTrackConstraints, "echoCancellation" | "noiseSuppression" | "autoGainControl">
  >;
  readonly webRtcAecLoopback: boolean;
}

export interface BrowserIdentity {
  readonly userAgent: string;
  readonly platform: string;
}

const DEFAULT_POLICY: BrowserAudioPolicy = {
  // Preserve the existing capture constraints outside the affected browser.
  captureProcessing: {
    echoCancellation: true,
    noiseSuppression: true,
  },
  webRtcAecLoopback: true,
};

const FIREFOX_MACOS_POLICY: BrowserAudioPolicy = {
  captureProcessing: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  webRtcAecLoopback: false,
};

export function resolveBrowserAudioPolicy(identity: BrowserIdentity): BrowserAudioPolicy {
  const firefox = /(?:^|\s|\))Firefox\//.test(identity.userAgent);
  const macOs = /^Mac/.test(identity.platform) || /\bMacintosh\b|\bMac OS X\b/.test(identity.userAgent);
  return firefox && macOs ? FIREFOX_MACOS_POLICY : DEFAULT_POLICY;
}

export function currentBrowserAudioPolicy(): BrowserAudioPolicy {
  if (typeof navigator === "undefined") return DEFAULT_POLICY;
  return resolveBrowserAudioPolicy({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  });
}

interface WebRtcAecControl {
  setAecEnabled(on: boolean): void;
}

/** Apply the browser policy at the hook-owned capture lifecycle boundary. */
export function setCaptureAecEnabled(
  control: WebRtcAecControl,
  policy: BrowserAudioPolicy,
  captureEnabled: boolean,
): void {
  control.setAecEnabled(captureEnabled && policy.webRtcAecLoopback);
}
