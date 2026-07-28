import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "inflight-message"]);

export interface InFlightMessage {
  readonly turnId: string;
  readonly text: string;
}

export interface InFlightMessageConnectorConfig {
  /** Called whenever ANY in-flight buffer changes (seed, delta, or clear). */
  onUpdate?: (inflight: readonly InFlightMessage[]) => void;
}

// ---------------------------------------------------------------------------
// InFlightMessageConnector — accumulates streaming assistant text for every
// turn that is still producing. Separate from committed conversation history.
//
// Capability: "message.stream"
// Direction: status (observer)
//
// Receives (2.0 wire contract):
//   - turn.started     — seed an EMPTY buffer so the UI can render its
//                        "thinking" placeholder BEFORE the first token. Without
//                        the seed the bubble stays absent through provider TFFT
//                        and the user stares at nothing.
//   - turn.text.delta  — append to that turn's buffer
//   - turn.completed   — drop that turn's buffer (committed entry follows via
//                        conversation.entry)
//   - turn.aborted     — drop that turn's buffer (the cutoff-stamped committed
//                        entry follows)
//
// MULTI-TURN (spec §7.2): the buffer is a MAP keyed by turnId, not a single
// slot. A self-initiated follow-up turn starts while the previous turn may
// still be open, and BOTH must render — two consecutive assistant bubbles with
// two turn ids is a valid, expected state. The previous single-slot design
// clobbered the still-open bubble; do not reintroduce it. Map insertion order
// IS render order.
// ---------------------------------------------------------------------------

export class InFlightMessageConnector implements Connector {
  readonly capability = "message.stream";
  readonly kind = "status" as const;

  private readonly config: InFlightMessageConnectorConfig;
  private unsubs: (() => void)[] = [];
  /** turnId → accumulated text. Insertion order IS render order. */
  private buffers = new Map<string, string>();

  constructor(config: InFlightMessageConnectorConfig = {}) {
    this.config = config;
  }

  /** Every turn currently mid-stream, oldest first. Empty when idle. */
  list(): readonly InFlightMessage[] {
    return [...this.buffers].map(([turnId, text]) => ({ turnId, text }));
  }

  attach(sdk: SentientSDKInternal): void {
    this.buffers = new Map();

    this.unsubs.push(
      sdk.onMessage("turn.started", (msg: unknown) => {
        const m = msg as { turnId?: string; trigger?: string };
        if (!m.turnId || this.buffers.has(m.turnId)) return;
        this.buffers.set(m.turnId, "");
        log.debug("turn-seeded", { turnId: m.turnId, trigger: m.trigger, inflight: this.buffers.size });
        this.emit();
      }),
    );

    this.unsubs.push(
      sdk.onMessage("turn.text.delta", (msg: unknown) => {
        const m = msg as { turnId?: string; text?: string };
        if (!m.turnId || typeof m.text !== "string") return;
        this.buffers.set(m.turnId, (this.buffers.get(m.turnId) ?? "") + m.text);
        this.emit();
      }),
    );

    this.unsubs.push(sdk.onMessage("turn.completed", (msg: unknown) => this.clearTurn(msg, "completed")));
    this.unsubs.push(sdk.onMessage("turn.aborted", (msg: unknown) => this.clearTurn(msg, "aborted")));
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.buffers = new Map();
  }

  private clearTurn(msg: unknown, reason: "completed" | "aborted"): void {
    const m = msg as { turnId?: string };
    if (!m.turnId) return;
    if (!this.buffers.delete(m.turnId)) return;
    log.debug("turn-cleared", { turnId: m.turnId, reason, inflight: this.buffers.size });
    this.emit();
  }

  private emit(): void {
    this.config.onUpdate?.(this.list());
  }
}
