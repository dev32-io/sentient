import type { DispatchMode, HermesEvent, HermesTurnInput } from "./hermes-event-types.js";

// ---------------------------------------------------------------------------
// HermesClient — abstract per-profile transport interface
// ---------------------------------------------------------------------------
// The concrete implementation lives in
// `gateway/src/hermes-adapter-client/acp-hermes-client.ts`. ACP is the only
// wire today; the legacy custom-WS adapter (`ws-hermes-client.ts`) and the
// HTTP+SSE client that preceded it were retired in successive pivots.

/** Per-user binding resolved by the gateway from config + secret store. */
export interface HermesProfileBinding {
  userId: string;
  url: string;
  apiKey: string;
  conversationId: string | null;
}

/** Streaming dispatch interface consumed by AttentionGate / cerebrum. */
export interface HermesClient {
  dispatch(input: HermesTurnInput, signal: AbortSignal, mode: DispatchMode): AsyncGenerator<HermesEvent>;
}
