import type { TurnMode } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

export interface UserAudioInputConfig {
  onTurnStarted?: () => void;
  /** Test seam; production uses crypto.randomUUID(). */
  createCaptureId?: () => string;
}

export interface AudioCaptureOptions {
  /** Stable opaque identity supplied by a producer, or generated when absent. */
  captureId?: string;
  turnMode?: TurnMode;
}

interface ActiveCapture {
  readonly id: string;
  readonly generation: number;
}

const BACKGROUND_TRIGGER = "background-completion";

/**
 * Owns the ordered Web audio uplink. A terminal action invalidates the active
 * generation before its JSON control is sent, so a queued producer callback
 * cannot put binary bytes after end/cancel or affect a subsequent capture.
 */
export class UserAudioInputConnector implements Connector {
  readonly capability = "audio.input";
  readonly kind = "input" as const;

  private readonly config: UserAudioInputConfig;
  private sdk: SentientSDKInternal | null = null;
  private unsubTurnStarted: (() => void) | null = null;
  private active: ActiveCapture | null = null;
  private nextGeneration = 0;
  private readonly usedCaptureIds = new Set<string>();

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
    // Transport loss discards capture; it must never imply Send/commit.
    if (this.active !== null && this.sdk !== null) this.cancelCapture(this.active.id);
    this.unsubTurnStarted?.();
    this.unsubTurnStarted = null;
    this.sdk = null;
  }

  /** Begins one non-overlapping capture and returns its stable identity. */
  startStreaming(options: AudioCaptureOptions = {}): string | null {
    if (this.active !== null || this.sdk === null) return null;
    const captureId = options.captureId ?? this.config.createCaptureId?.() ?? crypto.randomUUID();
    if (captureId.length === 0 || this.usedCaptureIds.has(captureId)) return null;
    this.usedCaptureIds.add(captureId);
    this.nextGeneration += 1;
    this.active = { id: captureId, generation: this.nextGeneration };
    this.sdk.send({
      type: "audio.start",
      captureId,
      turnMode: options.turnMode ?? "semantic",
    });
    return captureId;
  }

  /** Legacy name: stopping is an explicit Send/commit. */
  stopStreaming(captureId: string | undefined = this.active?.id): void {
    if (captureId !== undefined) this.commitCapture(captureId);
  }

  /** First matching terminal wins. Stale/repeated commits are harmless. */
  commitCapture(captureId: string): void {
    this.terminate(captureId, "audio.end");
  }

  /** First matching terminal wins. Cancel never aliases assistant interrupt. */
  cancelCapture(captureId: string): void {
    this.terminate(captureId, "audio.cancel");
  }

  /**
   * Sends PCM16 only for the named active generation. Producers should retain
   * the id returned by startStreaming and pass it from every callback.
   */
  sendAudioFrame(data: ArrayBuffer | Uint8Array, captureId: string | undefined = this.active?.id): void {
    const active = this.active;
    if (active === null || this.sdk === null || captureId !== active.id) return;
    this.sdk.sendBinary(data);
  }

  /** A callback seam that permanently latches the generation it was made for. */
  frameSender(captureId: string): (data: ArrayBuffer | Uint8Array) => void {
    const generation = this.active?.id === captureId ? this.active.generation : -1;
    return (data) => {
      const active = this.active;
      if (active?.id !== captureId || active.generation !== generation) return;
      this.sendAudioFrame(data, captureId);
    };
  }

  private terminate(captureId: string, type: "audio.end" | "audio.cancel"): void {
    const active = this.active;
    const sdk = this.sdk;
    if (active === null || sdk === null || active.id !== captureId) return;
    // Invalidate first: synchronous/re-entrant producer callbacks now see closed.
    this.active = null;
    sdk.send({ type, captureId });
  }
}
