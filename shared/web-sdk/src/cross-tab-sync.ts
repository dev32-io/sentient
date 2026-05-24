import type { SessionsChangeEvent } from "./connectors/sessions-connector.ts";

export interface CrossTabSync {
  broadcast(event: SessionsChangeEvent): void;
  onEvent(fn: (event: SessionsChangeEvent) => void): () => void;
  dispose(): void;
}

export interface CrossTabSyncConfig {
  readonly userId: string;
}

const NAME_PREFIX = "sentient-sessions:";

export function createCrossTabSync(cfg: CrossTabSyncConfig): CrossTabSync {
  const channelName = `${NAME_PREFIX}${cfg.userId}`;
  const channel = new BroadcastChannel(channelName);
  const listeners: Set<(e: SessionsChangeEvent) => void> = new Set();

  const handler = (msg: MessageEvent): void => {
    const data = msg.data as SessionsChangeEvent;
    for (const l of listeners) {
      try {
        l(data);
      } catch {
        /* listener errors non-fatal */
      }
    }
  };
  channel.addEventListener("message", handler);

  return {
    broadcast(event) {
      channel.postMessage(event);
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      channel.removeEventListener("message", handler);
      channel.close();
      listeners.clear();
    },
  };
}
