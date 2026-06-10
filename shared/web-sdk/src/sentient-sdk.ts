import type {
  Connector,
  ReconnectConfig,
  SDKStatus,
  SentientSDKConfig,
  SentientSDKInternal,
} from "./connector-types.ts";
import { sdkLog } from "./debug.ts";
import { getOrCreateDeviceId } from "./device-id.ts";
import { type ConnectionMonitor, createConnectionMonitor } from "./presence/connection-monitor.ts";
import { type PresenceCoordinator, createPresenceCoordinator } from "./presence/presence-coordinator.ts";
import { type ResumeCursorState, createResumeCursor } from "./resume-cursor.ts";
import {
  type CloseHandlerDeps,
  handleSocketClose as handleClose,
  reconnectAfterIdle as reconnectAfterIdleFn,
  softCloseForIdle as softCloseForIdleFn,
  teardownWsForReconnect as teardownWsFn,
} from "./sdk-close-handler.ts";
import { type MessageRouterDeps, dispatchMessage } from "./sdk-message-router.ts";
import {
  type ReconnectController,
  buildConnectUrl,
  clearStaleResumeId,
  createReconnectController,
  createSettlePair,
  hasPendingResume,
  setCurrentSessionId,
} from "./sdk-reconnect.ts";
import { type SdkTimers, createSdkTimers } from "./sdk-timers.ts";
import {
  type StreamResumeHandlerDeps,
  buildConfigureResume,
  handleStreamResumed as handleStreamResumedFn,
} from "./stream-resume-handler.ts";

// SentientSDK — WS/status core; presence idle-close + reconnect-loop recovery.
// Message dispatch in sdk-message-router; close handling in sdk-close-handler.
const WS_NORMAL_CLOSURE = 1000;
const USER_DISCONNECT_REASON = "User disconnect";
const WS_READY_STATE_OPEN = 1;
const WS_AUTH_TIMEOUT_CODE = 4001;
const WS_READY_TIMEOUT_CODE = 4002;
// Window for the snapshot-without-switched fallback. On a successful
// resume the gateway emits `session.switched` BEFORE `conversation.snapshot`
// inside the same onSnapshot callback (ws-session-configure.ts), so the
// switched-handler clears `pendingResume` first and the snapshot-handler
// sees `hasPendingResume() === false` (no timer armed). On a 404 fallback,
// only `conversation.snapshot` is sent (no preceding switched) — the timer
// arms and, after this many ms with no switched, the stale id is dropped.
// Generous slack for slow networks.
const STALE_RESUME_CHECK_MS = 200;

const DEFAULT_RECONNECT: ReconnectConfig = {
  baseMs: 1_000,
  maxMs: 30_000,
  jitterMs: 500,
  maxAttempts: 5,
  probePingTimeoutMs: 2_000,
};

type ErrorKind = "auth" | "network" | "timeout" | null;

const NOOP_RELEASE = (): void => {};

export class SentientSDK {
  private readonly config: SentientSDKConfig;
  private readonly connectors: Connector[] = [];
  private readonly capabilities: Set<string> = new Set(["stream.resume"]);
  private readonly messageHandlers = new Map<string, Set<(msg: unknown) => void>>();
  private readonly binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private readonly deviceId: string;
  private readonly cursor: ResumeCursorState;

  private currentStatus: SDKStatus = "disconnected";
  private ws: WebSocket | null = null;
  private pendingPresenceReconnect = false;
  private consumerDisconnected = false;
  private lastErrorKind: ErrorKind = null;
  // True when the current connect cycle is a reconnect (not the first connect).
  private isReconnectCycle = false;
  // Pending stale-resume timer. conversation.snapshot arms it; session.switched
  // disarms. If it fires, the resume 404'd and the stored id is dropped.
  private staleResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timers: SdkTimers;
  private readonly presence: PresenceCoordinator | null;
  private readonly reconnect: ReconnectController;
  private readonly connectionMonitor: ConnectionMonitor;

  constructor(config: SentientSDKConfig) {
    this.config = config;
    this.deviceId = getOrCreateDeviceId();
    this.cursor = createResumeCursor();
    this.timers = createSdkTimers({
      onAuthTimeout: () => {
        this.lastErrorKind = "timeout";
        this.setStatus("error");
        this.ws?.close(WS_AUTH_TIMEOUT_CODE, "Auth timeout");
      },
      onReadyTimeout: () => {
        this.lastErrorKind = "timeout";
        this.setStatus("error");
        this.ws?.close(WS_READY_TIMEOUT_CODE, "Session ready timeout");
      },
    });
    this.presence = this.buildPresence();
    this.reconnect = this.buildReconnect();
    this.connectionMonitor = createConnectionMonitor({
      hooks: { onProbe: () => void this.reconnect.probeAndReconnect() },
    });
  }

  register(connector: Connector): void {
    this.connectors.push(connector);
    this.capabilities.add(connector.capability);
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.currentStatus !== "disconnected" && this.currentStatus !== "reconnecting") {
        reject(new Error(`Cannot connect: status is ${this.currentStatus}`));
        return;
      }
      // Clear stale handlers from prior socket — detach prevents N-stacked listeners.
      this.detachAll();
      this.wireSessionPointerHandlers();
      this.presence?.clearIdleClosed();
      this.consumerDisconnected = false;
      this.lastErrorKind = null;
      this.setStatus("connecting");
      const createWs = this.config.createWebSocket ?? ((url: string) => new WebSocket(url));
      // buildConnectUrl appends `?session_id=` from sessionStorage so the
      // gateway can resume the tab's last chain. Captures pendingResume for
      // the snapshot-without-switched fallback detection below.
      const connectUrl = buildConnectUrl(this.config.gatewayUrl);
      this.ws = createWs(connectUrl);
      this.ws.binaryType = "arraybuffer";
      const { ok, fail } = createSettlePair(resolve, reject);
      this.ws.onopen = () => {
        this.setStatus("authenticating");
        this.sendRaw({ type: "auth", token: this.config.token });
        sdkLog.info("ws.auth.sent", { tokenPreview: this.config.token.slice(0, 8) });
        this.timers.startAuthTimeout(fail);
      };
      this.ws.onmessage = (e) => dispatchMessage(this.routerDeps(), e, ok, fail);
      // Close before session.ready must reject the connect Promise so the
      // reconnect loop can retry; handleClose runs independently for status.
      this.ws.onclose = () => {
        fail(new Error("ws closed before ready"));
        handleClose(this.closeDeps());
      };
      this.ws.onerror = () => {
        if (this.lastErrorKind === null) this.lastErrorKind = "network";
      };
    });
  }

  disconnect(): void {
    this.consumerDisconnected = true;
    this.reconnect.cancel();
    this.connectionMonitor.dispose();
    this.timers.clearAll();
    this.clearStaleResumeTimer();
    this.detachAll();
    this.presence?.dispose();
    this.pendingPresenceReconnect = false;
    this.isReconnectCycle = false;
    if (this.ws !== null) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close(WS_NORMAL_CLOSURE, USER_DISCONNECT_REASON);
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  status(): SDKStatus {
    return this.currentStatus;
  }

  /** Idempotent interrupt signal; UI Stop + Escape both funnel here. */
  interrupt(): void {
    sdkLog.debug("interrupt-send");
    this.sendRaw({ type: "interrupt" });
  }

  /** Manually kick a reconnect cycle ("Tap to reconnect"). Idempotent. */
  forceReconnect(): void {
    this.reconnect.forceReconnect();
  }

  /** Probe + reconnect-if-dead. Internally wired to visibility/online events. */
  probeAndReconnect(): Promise<void> {
    return this.reconnect.probeAndReconnect();
  }

  /** Force WS to stay open during user-visible work. No-op without presence. */
  demandStay(): () => void {
    if (this.presence === null) {
      sdkLog.debug("demandStay no-op");
      return NOOP_RELEASE;
    }
    sdkLog.debug("demandStay acquired");
    return this.presence.acquireDemandStay();
  }

  private createInternal(): SentientSDKInternal {
    return {
      send: (message: unknown) => this.sendRaw(message),
      sendBinary: (data: ArrayBuffer | Uint8Array) => this.sendBinaryRaw(data),
      onMessage: (type: string, handler: (msg: unknown) => void) => this.addMessageHandler(type, handler),
      onBinary: (handler: (data: ArrayBuffer) => void) => {
        this.binaryHandlers.add(handler);
        return () => {
          this.binaryHandlers.delete(handler);
        };
      },
    };
  }

  private attachAll(): void {
    const internal = this.createInternal();
    for (const connector of this.connectors) connector.attach(internal);
  }

  private detachAll(): void {
    for (const connector of this.connectors) connector.detach();
    this.messageHandlers.clear();
    this.binaryHandlers.clear();
  }

  private addMessageHandler(type: string, handler: (msg: unknown) => void): () => void {
    let set = this.messageHandlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.messageHandlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private resumeHandlerDeps(): StreamResumeHandlerDeps {
    return {
      cursor: this.cursor,
      send: (msg) => this.sendRaw(msg),
      getMessageHandlers: () => this.messageHandlers,
    };
  }

  /**
   * Track the per-tab "current session" pointer. session.created /
   * session.switched update sessionStorage; conversation.snapshot without a
   * following switched (within STALE_RESUME_CHECK_MS) treats the stored id as
   * stale and clears it (the resume 404'd and the gateway gave us a fresh
   * empty snapshot instead).
   *
   * Re-registered on every connect (detachAll clears the prior socket's
   * subscriptions) so the handlers stay live across reconnects.
   */
  private wireSessionPointerHandlers(): void {
    this.addMessageHandler("session.created", (msg: unknown) => {
      const m = msg as { sessionId?: string };
      if (m.sessionId) setCurrentSessionId(m.sessionId);
    });
    this.addMessageHandler("session.switched", (msg: unknown) => {
      const m = msg as { sessionId?: string };
      if (m.sessionId) setCurrentSessionId(m.sessionId);
      // setCurrentSessionId clears pendingResume on success → arms-and-disarms
      // are coordinated through pendingResume rather than a local flag.
      this.clearStaleResumeTimer();
    });
    this.addMessageHandler("conversation.snapshot", (_msg: unknown) => {
      if (!hasPendingResume()) return;
      // Snapshot fired with a resume in flight. Wait briefly for the
      // session.switched that pairs with it on a successful resume; if it
      // doesn't arrive, treat the stored id as stale.
      this.clearStaleResumeTimer();
      this.staleResumeTimer = setTimeout(() => {
        this.staleResumeTimer = null;
        clearStaleResumeId();
      }, STALE_RESUME_CHECK_MS);
    });
    // Resume-time `forbidden` (e.g. user deleted the session in another
    // tab between connect and switch) — drop the stored id NOW so the next
    // reconnect doesn't loop on the revoked id. Broader than requestId
    // matching: the gateway-side resume path uses `resume-<sessionId>` as
    // the requestId; matching purely by code+pending-resume window is
    // robust to that wiring detail.
    this.addMessageHandler("sessions.error", (msg: unknown) => {
      const m = msg as { code?: string };
      if (m.code !== "forbidden") return;
      if (!hasPendingResume()) return;
      this.clearStaleResumeTimer();
      clearStaleResumeId();
    });
  }

  private clearStaleResumeTimer(): void {
    if (this.staleResumeTimer !== null) {
      clearTimeout(this.staleResumeTimer);
      this.staleResumeTimer = null;
    }
  }

  private buildPresence(): PresenceCoordinator | null {
    const cfg = this.config.idlePresence;
    if (!cfg) return null;
    const hooks = {
      onIdleClose: () => softCloseForIdleFn(this.closeDeps()),
      onReconnect: () => reconnectAfterIdleFn(this.closeDeps()),
    };
    return createPresenceCoordinator(cfg, hooks, this.config.createPresenceWiring);
  }

  private buildReconnect(): ReconnectController {
    return createReconnectController({
      connect: () => {
        this.isReconnectCycle = true;
        return this.connect();
      },
      teardownWs: () => teardownWsFn(this.closeDeps()),
      getWs: () => this.ws,
      getStatus: () => this.currentStatus,
      setStatus: (next) => this.setStatus(next),
      rawSend: (payload) => this.sendRaw(payload),
      subscribe: (type, handler) => this.addMessageHandler(type, handler),
      isConsumerDisconnected: () => this.consumerDisconnected,
      isIdleClosed: () => this.presence?.isIdleClosed() === true,
      getLastErrorKind: () => this.lastErrorKind,
      onConnectionLost: () => this.config.onConnectionLost?.(),
      onAuthExpired: () => this.config.onAuthExpired?.(),
      config: this.config.reconnect ?? DEFAULT_RECONNECT,
    });
  }

  private routerDeps(): MessageRouterDeps {
    const isReconnect = this.isReconnectCycle;
    return {
      getStatus: () => this.currentStatus,
      setStatus: (s) => this.setStatus(s),
      setLastErrorKind: (k) => {
        this.lastErrorKind = k;
      },
      timers: this.timers,
      sendSessionConfigure: () => {
        this.isReconnectCycle = false; // consumed; reset for next cycle
        // Fold the resume request INTO configure on a reconnect with a non-zero
        // cursor (omitted on first connect). Single frame → the gateway reads
        // resume synchronously off configure, no separate stream.resume frame,
        // no send-ordering race.
        const resume = isReconnect ? buildConfigureResume(this.cursor) : undefined;
        this.sendRaw({
          type: "session.configure",
          capabilities: { supports: [...this.capabilities] },
          clientType: "webui",
          deviceId: this.deviceId,
          ...(resume ? { resume } : {}),
        });
      },
      onSessionReady: this.config.onSessionReady,
      attachAll: () => this.attachAll(),
      notifyPresence: (type) => this.presence?.notifyForType(type),
      getMessageHandlers: () => this.messageHandlers,
      getBinaryHandlers: () => this.binaryHandlers,
      getConnectors: () => this.connectors,
      cursor: this.cursor,
      onStreamResumed: (recovered) => handleStreamResumedFn(this.resumeHandlerDeps(), recovered),
    };
  }

  private closeDeps(): CloseHandlerDeps {
    return {
      getWs: () => this.ws,
      setWs: (ws) => {
        this.ws = ws;
      },
      getStatus: () => this.currentStatus,
      setStatus: (s) => this.setStatus(s),
      hasPresence: () => this.presence !== null,
      isIdleClosed: () => this.presence?.isIdleClosed() === true,
      isConsumerDisconnected: () => this.consumerDisconnected,
      isPendingPresenceReconnect: () => this.pendingPresenceReconnect,
      setPendingPresenceReconnect: (v) => {
        this.pendingPresenceReconnect = v;
      },
      setLastErrorKind: (k) => {
        this.lastErrorKind = k;
      },
      getLastErrorKind: () => this.lastErrorKind,
      clearTimers: () => this.timers.clearAll(),
      detachAll: () => this.detachAll(),
      presenceReconnect: () => this.connect(),
      forceReconnect: () => this.reconnect.forceReconnect(),
    };
  }

  private sendRaw(message: unknown): void {
    if (this.ws?.readyState !== WS_READY_STATE_OPEN) {
      sdkLog.warn("sendRaw: ws not open — dropping + kicking reconnect", {
        readyState: this.ws?.readyState,
        status: this.currentStatus,
      });
      if (this.currentStatus === "ready" || this.currentStatus === "authenticating") this.reconnect.forceReconnect();
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private sendBinaryRaw(data: ArrayBuffer | Uint8Array): void {
    if (this.ws?.readyState === WS_READY_STATE_OPEN) this.ws.send(data);
  }

  private setStatus(next: SDKStatus): void {
    if (this.currentStatus === next) return;
    sdkLog.debug(`status: ${this.currentStatus} → ${next}`);
    this.currentStatus = next;
    this.config.onStatusChange?.(next);
  }
}
