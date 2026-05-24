import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CognitionState = "idle" | "thinking" | "acting";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CognitionStatusConfig {
  /** Called when the cognition state changes. */
  onStateChange?: (state: CognitionState) => void;
}

// ---------------------------------------------------------------------------
// CognitionStatusConnector — tracks cognition cycle lifecycle.
//
// Capability: "cognition.status"
// Direction: status
//
// Receives: `cycle.started` / `cycle.completed` / `cycle.aborted` top-level
// wire messages. (The gateway emits these as their own message types, not
// wrapped under a `cognition.status` envelope.) Maps the cycle lifecycle to
// a simplified client-side state: idle / thinking / acting.
// ---------------------------------------------------------------------------

export class CognitionStatusConnector implements Connector {
  readonly capability = "cognition.status";
  readonly kind = "status" as const;

  private readonly config: CognitionStatusConfig;
  private unsubs: (() => void)[] = [];
  private currentState: CognitionState = "idle";

  constructor(config: CognitionStatusConfig = {}) {
    this.config = config;
  }

  private setState(next: CognitionState): void {
    if (next === this.currentState) return;
    this.currentState = next;
    this.config.onStateChange?.(next);
  }

  attach(sdk: SentientSDKInternal): void {
    this.currentState = "idle";
    this.unsubs.push(sdk.onMessage("cycle.started", () => this.setState("thinking")));
    this.unsubs.push(sdk.onMessage("cycle.completed", () => this.setState("idle")));
    this.unsubs.push(sdk.onMessage("cycle.aborted", () => this.setState("idle")));
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.currentState = "idle";
  }

  /** Current cognition state. */
  state(): CognitionState {
    return this.currentState;
  }
}
