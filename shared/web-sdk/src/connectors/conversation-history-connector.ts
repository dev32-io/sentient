import type { ConversationFeedItem } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";
import type { SessionsRest } from "../sessions-rest.ts";

const log = createLogger(["sentient", "sdk", "connectors", "conversation-history"]);

// ---------------------------------------------------------------------------
// CommittedFeedItem — a feed item plus the gateway-owned `cycleId` carried on
// its conversation.entry FRAME. The wire item itself strips cycle plumbing
// (see protocol/conversation.ts); we re-attach the frame's cycleId here so the
// UI can join a committed assistant entry to its live streaming bubble WITHOUT
// inventing an id (no ts-window stamping). `cycleId` is undefined for snapshot /
// REST-history items (historical entries have no live cycle) and for user /
// trigger entries (no originating cycle).
// ---------------------------------------------------------------------------

export type CommittedFeedItem = ConversationFeedItem & { readonly cycleId?: string };

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
// ---------------------------------------------------------------------------

export class ConversationHistoryConnector implements Connector {
  readonly capability = "conversation.history";
  readonly kind = "status" as const;

  private readonly config: ConversationHistoryConfig;
  private readonly rest: SessionsRest | null;
  private unsubs: (() => void)[] = [];
  private mirror: CommittedFeedItem[] = [];
  // Generation gate: bumped on session.switched so a stale fetch for an earlier
  // session cannot overwrite the current mirror.
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
    this.mirror = [];
    this.awaitingSnapshot = false;
    this.switchGen = 0;

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
        const m = msg as { item?: ConversationFeedItem; cycleId?: string };
        if (!m.item) return;
        // Re-attach the gateway's frame cycleId to the committed item so the UI
        // joins it to the live bubble by id (never by ts-window guessing).
        const entry: CommittedFeedItem = m.cycleId ? { ...m.item, cycleId: m.cycleId } : m.item;
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

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.mirror = [];
    this.awaitingSnapshot = false;
    this.switchGen = 0;
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
