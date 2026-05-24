import { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { AmbientEventLog } from "./ambient-event-log.js";
import type { AmbientEvent } from "./ambient-event.js";
import { renderHaEventSummary, salienceKeyFor } from "./ha-event-templates.js";
import type { HaState, HaStateChanged } from "./ha-event-templates.js";

const log = getLog(["sentient", "sensors", "home-assistant-observer"]);

// --- HA WebSocket message schemas ---

const haAuthRequired = z.object({
  type: z.literal("auth_required"),
});

const haAuthOk = z.object({
  type: z.literal("auth_ok"),
});

const haAuthInvalid = z.object({
  type: z.literal("auth_invalid"),
  message: z.string().optional(),
});

const haStateSchema = z.object({
  state: z.string(),
  attributes: z.record(z.unknown()).optional(),
});

const haEvent = z.object({
  type: z.literal("event"),
  event: z.object({
    data: z.object({
      entity_id: z.string(),
      old_state: haStateSchema.nullable(),
      new_state: haStateSchema.nullable(),
    }),
  }),
});

type HaEventParsed = z.infer<typeof haEvent>;

/** Convert Zod-parsed state to HaState, stripping undefined from optional attrs. */
function toHaState(s: HaEventParsed["event"]["data"]["old_state"]): HaState | null {
  if (!s) return null;
  const result: HaState = { state: s.state };
  if (s.attributes) result.attributes = s.attributes;
  return result;
}

function toHaStateChanged(data: HaEventParsed["event"]["data"]): HaStateChanged {
  return {
    entity_id: data.entity_id,
    old_state: toHaState(data.old_state),
    new_state: toHaState(data.new_state),
  };
}

// --- Config ---

export interface HomeAssistantObserverConfig {
  url: string;
  accessToken: string;
  watchDomains: string[];
  watchEntities: string[];
  ignoreEntities: string[];
  duplicateStateWindowMs: number;
}

// --- Pure filter + dedup logic ---

/** Tracks last-seen state per entity for dedup. */
export type DedupState = Map<string, { state: string; ts: number }>;

/**
 * Decides whether a HA state_changed event should become an AmbientEvent.
 * Returns null when the event is filtered out (domain/entity/ignore/dedup).
 * Pure function — no side effects, safe to test directly.
 */
export function processHaStateChanged(
  evt: HaStateChanged,
  config: HomeAssistantObserverConfig,
  dedup: DedupState,
  nowMs: number,
): AmbientEvent | null {
  const { entity_id } = evt;
  const dotIndex = entity_id.indexOf(".");
  const domain = dotIndex > 0 ? entity_id.substring(0, dotIndex) : entity_id;

  const isIgnored = config.ignoreEntities.includes(entity_id);
  if (isIgnored) return null;

  const isExplicitEntity = config.watchEntities.includes(entity_id);
  const isWatchedDomain = config.watchDomains.includes(domain);
  if (!isExplicitEntity && !isWatchedDomain) return null;

  const newState = evt.new_state?.state ?? "unavailable";

  const last = dedup.get(entity_id);
  if (last && last.state === newState && nowMs - last.ts < config.duplicateStateWindowMs) {
    return null;
  }

  dedup.set(entity_id, { state: newState, ts: nowMs });

  return {
    id: `ha.${entity_id}.${nowMs}`,
    ts: nowMs,
    source: "home_assistant",
    salienceKey: salienceKeyFor(entity_id),
    entityId: entity_id,
    summary: renderHaEventSummary(evt),
    raw: evt,
  };
}

// --- Observer class ---

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 3_000;

function jitteredBackoff(): number {
  return RECONNECT_MIN_MS + Math.random() * (RECONNECT_MAX_MS - RECONNECT_MIN_MS);
}

export class HomeAssistantObserver {
  private ws: WebSocket | null = null;
  private dedup: DedupState = new Map();
  private nextId = 1;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: HomeAssistantObserverConfig,
    private readonly eventLog: AmbientEventLog,
  ) {}

  start(): void {
    this.stopped = false;
    log.info("start", { url: this.config.url });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    log.info("stop");
  }

  private connect(): void {
    if (this.stopped) return;

    log.debug("connect", { url: this.config.url });
    const ws = new WebSocket(this.config.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      log.info("ws.open");
    });

    ws.addEventListener("message", (ev) => {
      this.handleMessage(ev.data as string);
    });

    ws.addEventListener("close", () => {
      log.info("ws.close");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      log.warn("ws.error");
    });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("message.parse.failed", { raw: raw.slice(0, 80) });
      return;
    }

    const authReq = haAuthRequired.safeParse(parsed);
    if (authReq.success) {
      this.sendAuth();
      return;
    }

    const authOk = haAuthOk.safeParse(parsed);
    if (authOk.success) {
      this.subscribeEvents();
      return;
    }

    const authInv = haAuthInvalid.safeParse(parsed);
    if (authInv.success) {
      log.error("auth.invalid", { message: authInv.data.message });
      this.stop();
      return;
    }

    const evt = haEvent.safeParse(parsed);
    if (evt.success) {
      this.onStateChanged(toHaStateChanged(evt.data.event.data));
      return;
    }

    log.debug("message.unhandled", { type: (parsed as Record<string, unknown>)?.type });
  }

  private sendAuth(): void {
    const msg = { type: "auth", access_token: this.config.accessToken };
    this.send(msg);
    log.debug("auth.sent");
  }

  private subscribeEvents(): void {
    const msg = { id: this.nextId++, type: "subscribe_events", event_type: "state_changed" };
    this.send(msg);
    log.info("subscribed", { id: msg.id });
  }

  private onStateChanged(data: HaStateChanged): void {
    const now = Date.now();
    const ambient = processHaStateChanged(data, this.config, this.dedup, now);
    if (!ambient) {
      log.debug("state_changed.filtered", { entity_id: data.entity_id });
      return;
    }
    this.eventLog.append(ambient);
    log.debug("state_changed.appended", { entity_id: data.entity_id, summary: ambient.summary.slice(0, 60) });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = jitteredBackoff();
    log.info("reconnect.scheduled", { delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
