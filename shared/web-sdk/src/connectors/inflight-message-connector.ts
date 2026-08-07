import type { TurnTextDeltaMessage } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "inflight-message"]);

export interface InFlightMessage {
  readonly turnId: string;
  readonly text: string;
  /** WHICH REPLY this is. Absent against a gateway that does not stamp
   *  deltas, in which case the buffer is keyed by turn — the old behaviour. */
  readonly replyId?: string;
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
  /** reply key → the buffer. Insertion order IS render order.
   *
   *  KEYED BY REPLY, NOT BY TURN. A ReAct turn produces text more than once
   *  and that is ONE bubble that grew — but a message the person sends mid-turn
   *  is drawn between two of those stretches, so the text after it belongs to a
   *  new bubble. The gateway decides where the boundary falls and stamps every
   *  delta (`replyId`); nothing here derives it. */
  private buffers = new Map<string, { turnId: string; text: string; replyId?: string }>();

  constructor(config: InFlightMessageConnectorConfig = {}) {
    this.config = config;
  }

  /** Every turn currently mid-stream, oldest first. Empty when idle. */
  list(): readonly InFlightMessage[] {
    return [...this.buffers.values()].map((b) => ({
      turnId: b.turnId,
      text: b.text,
      ...(b.replyId === undefined ? {} : { replyId: b.replyId }),
    }));
  }

  attach(sdk: SentientSDKInternal): void {
    this.buffers = new Map();

    this.unsubs.push(
      sdk.onMessage("turn.started", (msg: unknown) => {
        const m = msg as { turnId?: string; trigger?: string };
        if (!m.turnId || this.buffers.has(m.turnId)) return;
        // Seeded under the TURN key — `turn.started` carries no replyId, and
        // the first delta is what names the bubble. That delta re-keys this
        // placeholder in place, so it never becomes an orphan beside it.
        this.buffers.set(m.turnId, { turnId: m.turnId, text: "" });
        log.debug("turn-seeded", { turnId: m.turnId, trigger: m.trigger, inflight: this.buffers.size });
        this.emit();
      }),
    );

    this.unsubs.push(
      sdk.onMessage("turn.text.delta", (msg: unknown) => {
        const m = msg as TurnTextDeltaMessage;
        if (!m.turnId || typeof m.text !== "string") return;
        const key = m.replyId ?? m.turnId;
        // Adopt the turn-keyed placeholder ONCE, while it is still empty. A
        // non-empty one belongs to a gateway sending unstamped deltas and must
        // not be stolen.
        if (key !== m.turnId) {
          const seeded = this.buffers.get(m.turnId);
          if (seeded && seeded.text === "") {
            this.buffers.delete(m.turnId);
            this.buffers.set(key, {
              turnId: seeded.turnId,
              text: seeded.text,
              ...(m.replyId === undefined ? {} : { replyId: m.replyId }),
            });
          }
        }
        const prior = this.buffers.get(key);
        this.buffers.set(key, {
          turnId: m.turnId,
          text: (prior?.text ?? "") + m.text,
          ...(m.replyId === undefined ? {} : { replyId: m.replyId }),
        });
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
    // EVERY bubble of this turn: a turn the person spoke through owns more
    // than one, and clearing only the turn-keyed slot would strand the rest.
    const keys = [...this.buffers].filter(([, b]) => b.turnId === m.turnId).map(([key]) => key);
    if (keys.length === 0) return;
    for (const key of keys) this.buffers.delete(key);
    log.debug("turn-cleared", { turnId: m.turnId, reason, bubbles: keys.length, inflight: this.buffers.size });
    this.emit();
  }

  private emit(): void {
    this.config.onUpdate?.(this.list());
  }
}
