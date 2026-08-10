import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "assistant-audio-response"]);

/** Wire encoding of the outbound TTS byte stream, read off `turn.audio.start`. */
export interface AssistantAudioFormat {
  readonly encoding: "opus" | "pcm";
  readonly sampleRate: number;
}

export interface AssistantAudioResponseConfig {
  /** One outbound audio frame (payload bytes, header already peeled by the
   *  router). `turnId` comes from the most recent `turn.audio.start` — the
   *  binary frame itself carries no turn id. */
  onAudioFrame?: (frame: Uint8Array, turnId: string) => void;
  /** A new audio stream started. `format` is omitted if the gateway did not
   *  send both fields — the connector never invents a codec or a rate. */
  onAudioStart?: (turnId: string, format?: AssistantAudioFormat) => void;
  /** The audio stream for this turn completed normally. */
  onAudioDone?: (turnId: string) => void;
  /** Gateway signalled a mid-stream playback halt. Drop queued audio NOW.
   *  Emitted ONLY on barge-in (mic onset) or interrupt (UI Stop) — a new
   *  turnId never produces this frame (spec §4.7 / §7.2). */
  onPlaybackStop?: (reason: "barge-in" | "interrupt", turnId: string) => void;
}

// ---------------------------------------------------------------------------
// AssistantAudioResponseConnector — receives assistant TTS audio.
//
// Capability: "audio.output"
// Direction: output
//
// Receives (2.0 wire contract):
//   turn.audio.start  → open a stream, remember its turnId
//   binary frames     → payload bytes attributed to the open stream
//   turn.audio.done   → close the stream
//   playback.stop     → user-initiated halt; suppress frames until the next start
//
// FRAME ATTRIBUTION CONTRACT: outbound binary audio carries no turn id, so
// the gateway emits one turn's audio at a time, delimited by
// turn.audio.start / turn.audio.done. Overlapping streams would make frames
// unattributable — the connector WARNs loudly rather than silently
// mislabelling the tail of the previous turn. Sequential EMISSION does not
// mean sequential PLAYBACK: the next turn's frames still arrive while the
// previous turn's audio is buffered in the output pipeline, which is exactly
// what TurnAudioQueue exists to serialize (§7.2).
// ---------------------------------------------------------------------------

export class AssistantAudioResponseConnector implements Connector {
  readonly capability = "audio.output";
  readonly kind = "output" as const;

  private readonly config: AssistantAudioResponseConfig;
  private unsubs: (() => void)[] = [];
  private isReceiving = false;
  private isCancelled = false;
  /** turnId the currently arriving binary frames belong to. */
  private activeTurnId = "";

  constructor(config: AssistantAudioResponseConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.isCancelled = false;

    this.unsubs.push(
      sdk.onMessage("turn.audio.start", (msg: unknown) => {
        const m = msg as { turnId?: string; encoding?: string; sampleRate?: number };
        if (this.isReceiving) {
          log.warn("audio-start-while-receiving", {
            reason: "overlapping turn audio streams — frames cannot be attributed",
            previousTurnId: this.activeTurnId,
            turnId: m.turnId ?? "",
          });
        }
        this.activeTurnId = m.turnId ?? "";
        this.isReceiving = true;
        this.isCancelled = false;
        const { encoding, sampleRate } = m;
        // Annotated so the narrowed literal union survives object-literal
        // widening — the connector never invents a codec or a rate.
        const format: AssistantAudioFormat | undefined =
          (encoding === "opus" || encoding === "pcm") && typeof sampleRate === "number"
            ? { encoding, sampleRate }
            : undefined;
        log.debug("audio-start", { turnId: this.activeTurnId, encoding, sampleRate });
        this.config.onAudioStart?.(this.activeTurnId, format);
      }),
    );

    this.unsubs.push(
      sdk.onBinary((data: ArrayBuffer) => {
        if (!this.isReceiving || this.isCancelled) return;
        this.config.onAudioFrame?.(new Uint8Array(data), this.activeTurnId);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("turn.audio.done", (msg: unknown) => {
        const m = msg as { turnId?: string };
        const doneTurnId = m.turnId ?? this.activeTurnId;
        this.isReceiving = false;
        log.debug("audio-done", { turnId: doneTurnId, suppressed: this.isCancelled });
        if (!this.isCancelled) this.config.onAudioDone?.(doneTurnId);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("playback.stop", (msg: unknown) => {
        const m = msg as { turnId?: string; reason?: "barge-in" | "interrupt" };
        // Mark the stream dropped. `isReceiving` stays false until a fresh
        // turn.audio.start arrives — the next turn's audio re-enables playback
        // automatically.
        this.isCancelled = true;
        this.isReceiving = false;
        const reason = m.reason ?? "barge-in";
        log.info("playback-stop", { reason, turnId: m.turnId ?? "" });
        this.config.onPlaybackStop?.(reason, m.turnId ?? "");
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.isReceiving = false;
    this.isCancelled = false;
    this.activeTurnId = "";
  }

  onCancelled(): void {
    this.isCancelled = true;
    this.isReceiving = false;
    this.activeTurnId = "";
  }
}
