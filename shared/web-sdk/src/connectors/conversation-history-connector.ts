import type { ConversationFeedItem } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConversationHistoryConfig {
  /** Called with the full initial feed when the gateway sends snapshot. */
  onSnapshot?: (items: readonly ConversationFeedItem[]) => void;
  /** Called for each new entry appended at the gateway. */
  onEntry?: (item: ConversationFeedItem) => void;
  /** Called whenever the local mirror changes (snapshot OR entry). */
  onUpdate?: (items: readonly ConversationFeedItem[]) => void;
}

// ---------------------------------------------------------------------------
// ConversationHistoryConnector — session-scoped read-only mirror of the
// gateway's ConversationHistory.
//
// Capability: "conversation.history"
// Direction: status (session-state observer; no per-task lifecycle)
//
// Receives:
//   - conversation.snapshot  (once, right after session.ready)
//   - conversation.entry     (on every append)
//
// Exposes `items()` as the current ordered mirror. Callbacks fire on each
// change so UI state layers (signals, stores) can react without polling.
// ---------------------------------------------------------------------------

export class ConversationHistoryConnector implements Connector {
  readonly capability = "conversation.history";
  readonly kind = "status" as const;

  private readonly config: ConversationHistoryConfig;
  private unsubs: (() => void)[] = [];
  private mirror: ConversationFeedItem[] = [];
  // Generation gate: bumped on session.switched, cleared on every snapshot.
  // Entries received between session.switched and the next snapshot are
  // dropped. The gateway (ws-session-configure.ts onSnapshot) emits the pair
  // in switched-then-snapshot order on every successful switch/resume so the
  // gate is set first and immediately released by the snapshot — keeping
  // post-switch live entries flowing.
  private awaitingSnapshot = false;

  constructor(config: ConversationHistoryConfig = {}) {
    this.config = config;
  }

  /** Current ordered mirror of the feed. Safe to read synchronously. */
  items(): readonly ConversationFeedItem[] {
    return this.mirror;
  }

  attach(sdk: SentientSDKInternal): void {
    this.mirror = [];
    this.awaitingSnapshot = false;

    this.unsubs.push(
      sdk.onMessage("conversation.snapshot", (msg: unknown) => {
        const m = msg as { items?: ConversationFeedItem[] };
        const items = Array.isArray(m.items) ? m.items : [];
        this.mirror = [...items]; // REPLACE, not merge
        this.awaitingSnapshot = false;
        this.config.onSnapshot?.(this.mirror);
        this.config.onUpdate?.(this.mirror);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("conversation.entry", (msg: unknown) => {
        if (this.awaitingSnapshot) return; // drop straggler from prior generation
        const m = msg as { item?: ConversationFeedItem };
        if (!m.item) return;
        this.mirror = [...this.mirror, m.item];
        this.config.onEntry?.(m.item);
        this.config.onUpdate?.(this.mirror);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("session.switched", () => {
        this.awaitingSnapshot = true;
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.mirror = [];
    this.awaitingSnapshot = false;
  }
}
