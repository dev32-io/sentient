import type { Connector, SentientSDKInternal } from "../connector-types.ts";

export interface AudioPreferences {
  ttsEnabled: boolean;
  channel: "voice" | "text";
}

export interface AudioPreferencesPatch {
  ttsEnabled?: boolean;
  channel?: "voice" | "text";
}

const DEFAULT_PREFS: AudioPreferences = { ttsEnabled: true, channel: "voice" };

export interface PreferencesConnectorConfig {
  onChange?: (next: AudioPreferences) => void;
}

// ---------------------------------------------------------------------------
// PreferencesConnector — observes server-driven audio preference changes
// (e.g. model called update_user_settings) and lets the app push patches up
// to the gateway.
//
// Capability: "session.preferences"
// Direction: status (observes), but also sends user.preferences.patch when
// the app calls patch(). Mirrors the dual nature of UserAudioInputConnector.
// ---------------------------------------------------------------------------

export class PreferencesConnector implements Connector {
  readonly capability = "session.preferences";
  readonly kind = "status" as const;

  private readonly config: PreferencesConnectorConfig;
  private sdk: SentientSDKInternal | null = null;
  private unsub: (() => void) | null = null;
  private state: AudioPreferences = { ...DEFAULT_PREFS };

  constructor(config: PreferencesConnectorConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;
    this.unsub = sdk.onMessage("session.preferences.changed", (msg: unknown) => {
      const m = msg as { preferences?: Partial<AudioPreferences> };
      const next: AudioPreferences = {
        ttsEnabled: m.preferences?.ttsEnabled ?? this.state.ttsEnabled,
        channel: m.preferences?.channel ?? this.state.channel,
      };
      const changed = next.ttsEnabled !== this.state.ttsEnabled || next.channel !== this.state.channel;
      this.state = next;
      if (changed) this.config.onChange?.(next);
    });
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    this.sdk = null;
    this.state = { ...DEFAULT_PREFS };
  }

  /** Current snapshot of audio preferences. */
  current(): AudioPreferences {
    return this.state;
  }

  /** Seed the current state from external storage (e.g. profile) without
   *  emitting a frame. Use when the app loads the profile before the SDK
   *  has received any server-driven preference updates. */
  seed(prefs: AudioPreferences): void {
    this.state = prefs;
  }

  /** Send a patch to the gateway. Server will echo via session.preferences.changed. */
  patch(p: AudioPreferencesPatch): void {
    if (this.sdk === null) return;
    this.sdk.send({ type: "user.preferences.patch", payload: p });
  }
}
