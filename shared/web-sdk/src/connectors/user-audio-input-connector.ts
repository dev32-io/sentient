import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface UserAudioInputConfig {
  /** Called when the gateway sends a final transcript for user speech. */
  onTranscript?: (text: string) => void;
}

// ---------------------------------------------------------------------------
// UserAudioInputConnector — captures mic audio and streams to gateway.
//
// Capability: "audio.input"
// Direction: input
//
// Sends: audio.start, binary audio frames, audio.end
// Receives: connector.transcript.final
// ---------------------------------------------------------------------------

export class UserAudioInputConnector implements Connector {
  readonly capability = "audio.input";
  readonly kind = "input" as const;

  private readonly config: UserAudioInputConfig;
  private sdk: SentientSDKInternal | null = null;
  private unsubTranscript: (() => void) | null = null;
  private isStreaming = false;

  constructor(config: UserAudioInputConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;

    this.unsubTranscript = sdk.onMessage("connector.transcript.final", (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      const text = (m.text as string) ?? "";
      this.config.onTranscript?.(text);
    });
  }

  detach(): void {
    this.stopStreaming();
    this.unsubTranscript?.();
    this.unsubTranscript = null;
    this.sdk = null;
  }

  /** Begin streaming audio to the gateway. Call after mic capture is started. */
  startStreaming(): void {
    if (this.isStreaming || this.sdk === null) return;
    this.isStreaming = true;
    this.sdk.send({ type: "audio.start" });
  }

  /** Stop streaming audio to the gateway. */
  stopStreaming(): void {
    if (!this.isStreaming || this.sdk === null) return;
    this.isStreaming = false;
    this.sdk.send({ type: "audio.end" });
  }

  /** Send a raw audio frame (PCM16 binary) to the gateway. */
  sendAudioFrame(data: ArrayBuffer | Uint8Array): void {
    if (!this.isStreaming || this.sdk === null) return;
    this.sdk.sendBinary(data);
  }
}
