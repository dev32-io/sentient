import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AssistantAudioResponseConfig {
  /** Called for each incoming audio frame (raw PCM bytes). cycleId ties the
   *  frame to the cycle that produced it (from the preceding audio.start). */
  onAudioFrame?: (frame: Uint8Array, cycleId: string) => void;
  /** Called when a new audio stream starts for the given cycle. */
  onAudioStart?: (cycleId: string) => void;
  /** Called when the audio stream completes normally for the given cycle. */
  onAudioDone?: (cycleId: string) => void;
  /** Called when the gateway signals mid-stream playback halt (barge-in
   *  or interrupt). Client should drop any queued/buffered audio now so
   *  the user stops hearing the assistant immediately. Further incoming
   *  frames for the current stream are suppressed automatically; the
   *  next `connector.audio.start` re-enables playback. */
  onPlaybackStop?: (reason: "barge-in" | "interrupt", cycleId: string) => void;
}

// ---------------------------------------------------------------------------
// AssistantAudioResponseConnector — receives assistant audio from gateway.
//
// Capability: "audio.output"
// Direction: output
//
// Receives: connector.audio.start, binary audio frames, connector.audio.done
// On connector.cancelled: immediately stop, dump buffer.
// ---------------------------------------------------------------------------

export class AssistantAudioResponseConnector implements Connector {
  readonly capability = "audio.output";
  readonly kind = "output" as const;

  private readonly config: AssistantAudioResponseConfig;
  private unsubs: (() => void)[] = [];
  private isReceiving = false;
  private isCancelled = false;
  /** cycleId of the currently active audio stream (set on audio.start). */
  private activeCycleId = "";

  constructor(config: AssistantAudioResponseConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.isCancelled = false;

    this.unsubs.push(
      sdk.onMessage("connector.audio.start", (msg) => {
        const m = msg as { cycleId?: string };
        this.activeCycleId = m.cycleId ?? "";
        this.isReceiving = true;
        this.isCancelled = false;
        this.config.onAudioStart?.(this.activeCycleId);
      }),
    );

    this.unsubs.push(
      sdk.onBinary((data: ArrayBuffer) => {
        if (!this.isReceiving || this.isCancelled) return;
        this.config.onAudioFrame?.(new Uint8Array(data), this.activeCycleId);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("connector.audio.done", (msg) => {
        const m = msg as { cycleId?: string };
        const doneId = m.cycleId ?? this.activeCycleId;
        this.isReceiving = false;
        if (!this.isCancelled) {
          this.config.onAudioDone?.(doneId);
        }
      }),
    );

    this.unsubs.push(
      sdk.onMessage("playback.stop", (msg) => {
        const m = msg as { cycleId?: string; reason?: "barge-in" | "interrupt" };
        // Mark this stream dropped. `isReceiving` stays false until a
        // fresh `connector.audio.start` arrives — the next cycle's
        // audio re-enables playback automatically.
        this.isCancelled = true;
        this.isReceiving = false;
        this.config.onPlaybackStop?.(m.reason ?? "barge-in", m.cycleId ?? "");
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.isReceiving = false;
    this.isCancelled = false;
    this.activeCycleId = "";
  }

  onCancelled(): void {
    this.isCancelled = true;
    this.isReceiving = false;
    this.activeCycleId = "";
  }
}
