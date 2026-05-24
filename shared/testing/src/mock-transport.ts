// Structurally compatible with the Transport interface from web-sdk.
// Defined locally to avoid cross-package coupling from the testing package.

type TransportState = "disconnected" | "connecting" | "authenticating" | "connected" | "reconnecting";

export interface MockTransport {
  connect(): void;
  disconnect(): void;
  sendJson(msg: Record<string, unknown>): void;
  sendBinary(data: ArrayBuffer): void;
  state(): TransportState;
  on(event: string, handler: (...args: unknown[]) => void): () => void;

  // Test control
  simulateJsonMessage(msg: Record<string, unknown>): void;
  simulateBinaryMessage(data: ArrayBuffer): void;
  simulateStateChange(state: TransportState): void;
  simulateAuthSuccess(sessionId: string, role: string): void;
  sentJsonMessages(): Array<Record<string, unknown>>;
  sentBinaryMessages(): ArrayBuffer[];
}

export function createMockTransport(): MockTransport {
  let currentState: TransportState = "disconnected";
  const sentJson: Array<Record<string, unknown>> = [];
  const sentBinary: ArrayBuffer[] = [];
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  function emit(event: string, ...args: unknown[]): void {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(...args);
    }
  }

  function on(event: string, handler: (...args: unknown[]) => void): () => void {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)?.add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function connect(): void {
    currentState = "connecting";
    emit("stateChange", currentState);
  }

  function disconnect(): void {
    currentState = "disconnected";
    emit("stateChange", currentState);
  }

  function sendJson(msg: Record<string, unknown>): void {
    sentJson.push(msg);
  }

  function sendBinary(data: ArrayBuffer): void {
    sentBinary.push(data);
  }

  function state(): TransportState {
    return currentState;
  }

  function simulateJsonMessage(msg: Record<string, unknown>): void {
    emit("message", msg);
  }

  function simulateBinaryMessage(data: ArrayBuffer): void {
    emit("binaryMessage", data);
  }

  function simulateStateChange(newState: TransportState): void {
    currentState = newState;
    emit("stateChange", newState);
  }

  function simulateAuthSuccess(sessionId: string, role: string): void {
    currentState = "connected";
    emit("stateChange", "connected");
    emit("authSuccess", { sessionId, role });
  }

  function sentJsonMessages(): Array<Record<string, unknown>> {
    return sentJson;
  }

  function sentBinaryMessages(): ArrayBuffer[] {
    return sentBinary;
  }

  return {
    connect,
    disconnect,
    sendJson,
    sendBinary,
    state,
    on,
    simulateJsonMessage,
    simulateBinaryMessage,
    simulateStateChange,
    simulateAuthSuccess,
    sentJsonMessages,
    sentBinaryMessages,
  };
}
