import type { TurnMode } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface UserAudioInputConfig {
  /**
   * The gateway opened a turn for a USER stimulus — it has taken ownership of
   * whatever was said, so the client's mic latch (SpeechGate) can close and
   * stop streaming until sustained speech reopens it.
   *
   * This is the 2.0 replacement for the deleted `connector.transcript.final`
   * (plan reconciliation R9). There is no live partial-transcript frame in the
   * contract any more, so this is the earliest server signal that the utterance
   * boundary has passed. Background-completion turns are filtered out: they
   * arrive at arbitrary moments and must never truncate an utterance in flight.
   */
  onTurnStarted?: () => void;
}

/**
 * Outbound `audio.start` frame. Schema parity with the gateway's
 * `audioStartSchema` (2026-07-17 hold/toggle-talk split design §4) — type
 * only. Web always omits `turnMode` (gateway defaults to "semantic"); only
 * mobile-sdk's hold-to-talk path sets it to "manual". Zero behavior change.
 */
interface AudioStartFrame {
  type: "audio.start";
  turnMode?: TurnMode;
}

/** Turns started by a background `delegateTask` completion, not by a person. */
const BACKGROUND_TRIGGER = "background-completion";

// ---------------------------------------------------------------------------
// UserAudioInputConnector — captures mic audio and streams to gateway.
//
// Capability: "audio.input"
// Direction: input
//
// Sends: audio.start, binary audio frames, audio.end
// Receives: turn.started (the mic-latch close signal — see onTurnStarted)
// ---------------------------------------------------------------------------

export class UserAudioInputConnector implements Connector {
  readonly capability = "audio.input";
  readonly kind = "input" as const;

  private readonly config: UserAudioInputConfig;
  private sdk: SentientSDKInternal | null = null;
  private unsubTurnStarted: (() => void) | null = null;
  private isStreaming = false;

  constructor(config: UserAudioInputConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;

    this.unsubTurnStarted = sdk.onMessage("turn.started", (msg: unknown) => {
      const m = msg as { trigger?: string };
      if (m.trigger === BACKGROUND_TRIGGER) return;
      this.config.onTurnStarted?.();
    });
  }

  detach(): void {
    this.stopStreaming();
    this.unsubTurnStarted?.();
    this.unsubTurnStarted = null;
    this.sdk = null;
  }

  /** Begin streaming audio to the gateway. Call after mic capture is started. */
  startStreaming(): void {
    if (this.isStreaming || this.sdk === null) return;
    this.isStreaming = true;
    const frame: AudioStartFrame = { type: "audio.start" };
    this.sdk.send(frame);
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
