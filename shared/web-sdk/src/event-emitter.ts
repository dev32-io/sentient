// biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
// biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
export interface TypedEmitter<Events extends Record<string, (...args: any[]) => any>> {
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void;
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void;
  removeAll(): void;
}

// biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
// biome-ignore lint/suspicious/noExplicitAny: generic event handler signature
export function createEmitter<Events extends Record<string, (...args: any[]) => any>>(): TypedEmitter<Events> {
  const handlers = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  return {
    on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      const set = handlers.get(event);
      if (!set) {
        return () => {};
      }
      set.add(handler as (...args: unknown[]) => void);
      return () => {
        set.delete(handler as (...args: unknown[]) => void);
      };
    },

    emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
      const set = handlers.get(event);
      if (set) {
        for (const h of set) {
          h(...args);
        }
      }
    },

    removeAll(): void {
      handlers.clear();
    },
  };
}
