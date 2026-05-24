import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InFlightMessage {
  readonly cycleId: string;
  readonly text: string;
}

export interface InFlightMessageConnectorConfig {
  /** Called whenever the in-flight buffer changes (delta append or clear). */
  onUpdate?: (inflight: InFlightMessage | null) => void;
}

// ---------------------------------------------------------------------------
// InFlightMessageConnector — accumulates streaming assistant content while a
// cycle is still producing. Exposes a single `inflight` slot separate from
// the committed conversation history.
//
// Capability: "message.stream"
// Direction: status (observer)
//
// Receives:
//   - cycle.started   — seed an empty buffer so the UI can show a "thinking"
//                       placeholder (e.g. three-dot pulse in BubbleText) BEFORE
//                       the first token arrives. Without this, the inflight
//                       slot stays null until `message.delta` fires, by which
//                       point text is already non-empty and the placeholder
//                       window collapses to zero — the user stares at nothing
//                       during LLM TTFB.
//   - message.delta   — append to buffer for cycleId
//   - message.done    — clear buffer (committed entry follows via history)
//   - cycle.aborted   — clear buffer (no committed entry will follow)
//
// The UI typically renders `[...committedHistory, inflight]` so a streaming
// bubble appears at the bottom and swaps cleanly with the committed entry
// on done.
// ---------------------------------------------------------------------------

export class InFlightMessageConnector implements Connector {
  readonly capability = "message.stream";
  readonly kind = "status" as const;

  private readonly config: InFlightMessageConnectorConfig;
  private unsubs: (() => void)[] = [];
  private current: InFlightMessage | null = null;

  constructor(config: InFlightMessageConnectorConfig = {}) {
    this.config = config;
  }

  /** Current buffer. null if no cycle is mid-stream. */
  inflight(): InFlightMessage | null {
    return this.current;
  }

  attach(sdk: SentientSDKInternal): void {
    this.current = null;

    this.unsubs.push(
      sdk.onMessage("cycle.started", (msg: unknown) => {
        const m = msg as { cycleId?: string };
        if (!m.cycleId) return;
        // Seed an empty buffer so consumers (BubbleText) can render the
        // pre-first-token thinking placeholder. The first delta will swap
        // text in place; if the cycle aborts before any delta, the
        // buffer is cleared by the cycle.aborted handler below.
        this.current = { cycleId: m.cycleId, text: "" };
        this.config.onUpdate?.(this.current);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("message.delta", (msg: unknown) => {
        const m = msg as { cycleId?: string; delta?: string };
        if (!m.cycleId || typeof m.delta !== "string") return;
        const prior = this.current && this.current.cycleId === m.cycleId ? this.current.text : "";
        this.current = { cycleId: m.cycleId, text: prior + m.delta };
        this.config.onUpdate?.(this.current);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("message.done", (msg: unknown) => {
        const m = msg as { cycleId?: string };
        if (!m.cycleId) return;
        if (this.current && this.current.cycleId !== m.cycleId) return;
        this.current = null;
        this.config.onUpdate?.(null);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("cycle.aborted", (msg: unknown) => {
        const m = msg as { cycleId?: string };
        if (!m.cycleId) return;
        if (this.current && this.current.cycleId !== m.cycleId) return;
        this.current = null;
        this.config.onUpdate?.(null);
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.current = null;
  }
}
