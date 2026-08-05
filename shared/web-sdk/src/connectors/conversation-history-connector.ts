import type { ConversationFeedItem } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";
import type { SessionsRest } from "../sessions-rest.ts";

const log = createLogger(["sentient", "sdk", "connectors", "conversation-history"]);

// ---------------------------------------------------------------------------
// CommittedFeedItem — a feed item plus the gateway-owned `turnId` carried on
// its conversation.entry FRAME. The wire item itself strips turn plumbing (see
// protocol/conversation.ts); we re-attach the frame's turnId here so the UI can
// join a committed assistant entry to its live streaming bubble WITHOUT
// inventing an id (no ts-window stamping, no position guessing). `turnId` is
// undefined for snapshot / REST-history items (historical entries have no live
// turn) and for user / trigger entries (no originating turn).
// ---------------------------------------------------------------------------

export type CommittedFeedItem = ConversationFeedItem & {
  readonly turnId?: string;
  /** WHICH BUBBLE this row belongs to, re-attached from the frame like
   *  `turnId`. Consecutive assistant rows sharing it are the several stretches
   *  of ONE reply and render as one bubble. */
  readonly messageId?: string;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConversationHistoryConfig {
  /** Called with the full initial feed when the gateway sends snapshot. */
  onSnapshot?: (items: readonly CommittedFeedItem[]) => void;
  /** Called for each new entry appended at the gateway. */
  onEntry?: (item: CommittedFeedItem) => void;
  /** Called whenever the local mirror changes (snapshot OR entry). */
  onUpdate?: (items: readonly CommittedFeedItem[]) => void;
}

// ---------------------------------------------------------------------------
// ConversationHistoryConnector — session-scoped read-only mirror of the
// gateway's ConversationHistory.
//
// Capability: "conversation.history"
// Direction: status (session-state observer; no per-task lifecycle)
//
// Receives:
//   - conversation.snapshot  (once, right after session.ready — initial connect)
//   - conversation.entry     (on every append)
//   - session.switched       (on conversation switch — Task 2.4+)
//
// On session.switched the gateway no longer emits conversation.snapshot.
// Instead we fetch history via REST (GET /sessions/:id/messages) and replace
// the mirror. A generation counter guards against stale responses from a prior
// switch arriving after a fast second switch.
//
// awaitingSnapshot gate semantics (preserved from before):
//   - Set on session.switched (or initially false on attach).
//   - Cleared once the REST load completes (success or error).
//   - While true, conversation.entry messages are dropped (stale from prior session).
//   - After clear, normal appends resume.
//
// conversation.snapshot still works for the initial connect path — no change.
//
// MIRROR LIFETIME — attach/detach are TRANSPORT lifecycle, not session
// lifecycle, so neither touches the mirror. A reconnect detaches every
// connector (sdk-close-handler.teardownWsForReconnect) and re-attaches them on
// the next session.ready; on the normal `recovered:true` path the gateway
// replays ONLY the frames the client missed and deliberately sends NO
// conversation.snapshot (ws-session-configure.ts: "its mirror is still
// intact"). Clearing here would leave nothing to refill it, so the next
// replayed conversation.entry would become the whole visible chat. Mobile
// already behaves this way — its connectors survive the reconnect and
// decideOnResumed(true) is PRESERVE.
//
// What DOES clear the mirror, all of them real session boundaries:
//   - conversation.snapshot          → replaces it (fresh / non-recovered connect)
//   - session.switched → REST load   → replaces it (conversation switch)
//   - reset()                        → empties it (identity teardown; called by
//                                      SentientSDK.disconnect)
// ---------------------------------------------------------------------------

export class ConversationHistoryConnector implements Connector {
  readonly capability = "conversation.history";
  readonly kind = "status" as const;

  private readonly config: ConversationHistoryConfig;
  private readonly rest: SessionsRest | null;
  private unsubs: (() => void)[] = [];
  private mirror: CommittedFeedItem[] = [];
  // Generation gate: bumped on session.switched so a stale fetch for an earlier
  // session cannot overwrite the current mirror. Monotonic for the connector's
  // whole life — never rewound by attach/detach, or a fetch issued before a
  // reconnect could be mistaken for the current generation after it.
  private switchGen = 0;
  // Set on session.switched until REST load resolves. Entries received during
  // this window are dropped (they belong to the outgoing session).
  private awaitingSnapshot = false;

  constructor(config: ConversationHistoryConfig = {}, rest: SessionsRest | null = null) {
    this.config = config;
    this.rest = rest;
  }

  /** Current ordered mirror of the feed. Safe to read synchronously. */
  items(): readonly CommittedFeedItem[] {
    return this.mirror;
  }

  attach(sdk: SentientSDKInternal): void {
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
        const m = msg as { item?: ConversationFeedItem; turnId?: string; messageId?: string };
        if (!m.item) return;
        // Re-attach the gateway's frame turnId to the committed item so the UI
        // joins it to the live bubble by id (never by ts-window guessing).
        const entry: CommittedFeedItem = {
          ...m.item,
          ...(m.turnId === undefined ? {} : { turnId: m.turnId }),
          ...(m.messageId === undefined ? {} : { messageId: m.messageId }),
        };
        this.mirror = [...this.mirror, entry];
        this.config.onEntry?.(entry);
        this.config.onUpdate?.(this.mirror);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("session.switched", (msg: unknown) => {
        const m = msg as { sessionId?: string };
        const sessionId = m.sessionId;
        if (!sessionId) {
          log.warn("session.switched-missing-id", { reason: "no sessionId in message" });
          return;
        }
        this.awaitingSnapshot = true;
        const gen = ++this.switchGen;
        log.debug("session.switched-fetch-start", { sessionId, gen });
        this.loadHistoryFromRest(sessionId, gen);
      }),
    );
  }

  /** Drop the socket subscriptions only. Session state (mirror, switch gate)
   *  survives — see MIRROR LIFETIME above. */
  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  /**
   * Drop all session state. This is the identity/session teardown path —
   * `SentientSDK.disconnect()` calls it — and the ONLY clear that is not a
   * replacement by a fresher feed. A reconnect must never reach it.
   */
  reset(): void {
    const previousCount = this.mirror.length;
    this.mirror = [];
    this.awaitingSnapshot = false;
    log.info("mirror.reset", { reason: "session identity teardown", previousCount });
  }

  private loadHistoryFromRest(sessionId: string, gen: number): void {
    if (this.rest === null) {
      log.warn("session.switched-no-rest", {
        reason: "no SessionsRest injected; history unavailable after switch",
        sessionId,
      });
      this.awaitingSnapshot = false;
      return;
    }
    this.rest.getMessages(sessionId).then(
      (items) => {
        if (gen !== this.switchGen) {
          log.debug("session.switched-stale-fetch-dropped", { sessionId, gen, current: this.switchGen });
          return;
        }
        log.debug("session.switched-fetch-ok", { sessionId, gen, count: items.length });
        this.mirror = [...items];
        this.awaitingSnapshot = false;
        this.config.onSnapshot?.(this.mirror);
        this.config.onUpdate?.(this.mirror);
      },
      (err: unknown) => {
        if (gen !== this.switchGen) return;
        log.warn("session.switched-fetch-error", {
          reason: "REST getMessages failed",
          sessionId,
          error: String(err),
        });
        // Replace mirror with empty list (match mobile behaviour) and clear the
        // gate so new entries can flow — don't leave the old session's data visible.
        this.mirror = [];
        this.awaitingSnapshot = false;
        this.config.onUpdate?.(this.mirror);
      },
    );
  }
}
