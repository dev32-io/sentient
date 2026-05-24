export interface ReplayEntry {
  readonly seq: number;
  readonly message: Record<string, unknown>;
}

export interface ReplayBuffer {
  add(message: Record<string, unknown>): number;
  replayAfter(seq: number): ReplayEntry[];
  lastSeq(): number;
  size(): number;
  reset(): void;
}

export function createReplayBuffer(capacity: number): ReplayBuffer {
  const entries: ReplayEntry[] = [];
  let nextSeq = 1;

  return {
    add(message: Record<string, unknown>): number {
      const seq = nextSeq++;
      entries.push({ seq, message });
      if (entries.length > capacity) {
        entries.shift();
      }
      return seq;
    },

    replayAfter(seq: number): ReplayEntry[] {
      return entries.filter((e) => e.seq > seq);
    },

    lastSeq(): number {
      const last = entries[entries.length - 1];
      return last?.seq ?? 0;
    },

    size(): number {
      return entries.length;
    },

    reset(): void {
      entries.length = 0;
      nextSeq = 1;
    },
  };
}
