import type { PermissionOutcome } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger(["sentient", "sdk", "connectors", "permission-confirm"]);

export interface PermissionRequestItem {
  /** Correlation id for this decision. The ONLY id the response carries. */
  readonly requestId: string;
  /** The tool call the decision gates. */
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Human-readable action summary supplied by the gateway PDP. */
  readonly description: string;
  /** Wall-clock ms after which the gateway auto-denies (fail-closed). */
  readonly expiresAtMs: number;
}

export interface PermissionConfirmConnectorConfig {
  /** Called whenever the pending set changes. Oldest request first. */
  onPending?: (pending: readonly PermissionRequestItem[]) => void;
  /** Called when the GATEWAY resolves a request — including its own timeout. */
  onResolved?: (requestId: string, outcome: PermissionOutcome) => void;
}

// ---------------------------------------------------------------------------
// PermissionConfirmConnector — the SDK state surface behind the L3 `confirm`
// dialog (spec §5.3 / §7.1).
//
// Capability: "permission.confirm"
// Direction: status — the request/response pair is one decision channel, and
// the UI binds to the pending SET (state-bound UX), not to an imperative call.
//
// Receives:
//   permission.request   → add to pending; the UI renders a dialog
//   permission.resolved  → remove from pending; the UI dismisses the dialog.
//                          Fires when the GATEWAY decided first — most
//                          importantly on its 2-minute fail-closed timeout, so
//                          a stale dialog cannot linger and cannot be answered
//                          after the decision was already made.
//
// Sends:
//   permission.response { requestId, approved }
//
// FAIL-CLOSED: this connector never approves anything on its own. It does not
// time out locally (the gateway owns the deadline), it refuses to answer a
// requestId it is not tracking, and on detach it drops every pending request —
// a socket that is gone cannot carry an approval, and the gateway will deny on
// timeout.
// ---------------------------------------------------------------------------

export class PermissionConfirmConnector implements Connector {
  readonly capability = "permission.confirm";
  readonly kind = "status" as const;

  private readonly config: PermissionConfirmConnectorConfig;
  private unsubs: (() => void)[] = [];
  private sdk: SentientSDKInternal | null = null;
  /** requestId → request. Insertion order IS dialog order. */
  private requests = new Map<string, PermissionRequestItem>();

  constructor(config: PermissionConfirmConnectorConfig = {}) {
    this.config = config;
  }

  /** Requests awaiting a user decision, oldest first. */
  pending(): readonly PermissionRequestItem[] {
    return [...this.requests.values()];
  }

  /** Answer a pending request. No-op for an unknown or already-resolved id. */
  respond(requestId: string, approved: boolean): void {
    if (this.sdk === null) {
      log.warn("respond-dropped", { reason: "connector detached", requestId });
      return;
    }
    if (!this.requests.has(requestId)) {
      log.warn("respond-dropped", { reason: "unknown or already-resolved requestId", requestId });
      return;
    }
    log.info("permission-response", { requestId, approved });
    this.sdk.send({ type: "permission.response", requestId, approved });
    this.requests.delete(requestId);
    this.emit();
  }

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;
    this.requests = new Map();

    this.unsubs.push(
      sdk.onMessage("permission.request", (msg: unknown) => {
        const m = msg as {
          requestId?: string;
          toolCallId?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          description?: string;
          expiresAtMs?: number;
        };
        if (!m.requestId || !m.toolCallId || !m.toolName || m.expiresAtMs === undefined) {
          log.warn("permission-request-dropped", {
            reason: "missing required field on permission.request",
            requestId: m.requestId ?? null,
          });
          return;
        }
        const item: PermissionRequestItem = {
          requestId: m.requestId,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          args: m.args ?? {},
          description: m.description ?? "",
          expiresAtMs: m.expiresAtMs,
        };
        this.requests.set(item.requestId, item);
        log.info("permission-request", {
          requestId: item.requestId,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          pending: this.requests.size,
        });
        this.emit();
      }),
    );

    this.unsubs.push(
      sdk.onMessage("permission.resolved", (msg: unknown) => {
        const m = msg as { requestId?: string; outcome?: PermissionOutcome };
        if (!m.requestId || !m.outcome) return;
        const wasPending = this.requests.delete(m.requestId);
        log.info("permission-resolved", { requestId: m.requestId, outcome: m.outcome, wasPending });
        this.config.onResolved?.(m.requestId, m.outcome);
        if (wasPending) this.emit();
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.sdk = null;
    if (this.requests.size > 0) {
      log.warn("pending-cleared-on-detach", {
        reason: "socket closed; an unanswered prompt cannot be answered — gateway fails it closed on timeout",
        pending: this.requests.size,
      });
    }
    this.requests = new Map();
    this.emit();
  }

  private emit(): void {
    this.config.onPending?.(this.pending());
  }
}
