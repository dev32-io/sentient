import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "cerebrum", "conversation-mirror"]);

// ---------------------------------------------------------------------------
// Mirror entry types — thin append-only log mirroring what the client sees.
// NOT an LLM context store (ConversationHistory owns that).
// Per spec v4 §5.9: bounded FIFO with configurable capacity.
// ---------------------------------------------------------------------------

export type MirrorCutoff =
  | { kind: "barge-in" }
  | { kind: "interrupt"; cancelledTaskIds: string[] }
  | { kind: "length-cap" };

export type MirrorEntry =
  | { entryId: string; kind: "user"; ts: number; channel: "text" | "speech"; content: string; pendingId?: string }
  | { entryId: string; kind: "assistant"; ts: number; content: string; cutoff?: MirrorCutoff }
  | {
      entryId: string;
      kind: "tool";
      ts: number;
      toolName: string;
      status: "finished" | "cancelled" | "failed";
      summary: string;
    }
  | { entryId: string; kind: "trigger"; ts: number; source: string; summary: string };

export interface ConversationMirror {
  /** Append an entry. Oldest entries are evicted when over capacity. */
  append(entry: MirrorEntry): void;
  /** Return a snapshot of current entries (copy). */
  snapshot(): readonly MirrorEntry[];
  /** Remove all entries. */
  clear(): void;
  /** Current number of entries. */
  size(): number;
  /** Subscribe to per-entry append events. Returns unsubscribe. */
  onAppend(listener: (entry: MirrorEntry) => void): () => void;
  /**
   * Atomically replace the entire buffer. Honors capacity (keeps tail).
   * Fires onSnapshot listeners exactly once. Does NOT fire onAppend.
   */
  replaceAll(entries: readonly MirrorEntry[]): void;
  /** Subscribe to bulk-replace events. Returns unsubscribe. */
  onSnapshot(listener: (entries: readonly MirrorEntry[]) => void): () => void;
}

const DEFAULT_CAPACITY = 500;

/**
 * Bounded FIFO mirror of the client-facing conversation feed.
 * Capacity default matches spec v4 §5.9; configurable for testing.
 */
export function createConversationMirror(capacity: number = DEFAULT_CAPACITY): ConversationMirror {
  const buffer: MirrorEntry[] = [];
  const appendListeners = new Set<(entry: MirrorEntry) => void>();
  const snapshotListeners = new Set<(entries: readonly MirrorEntry[]) => void>();

  return {
    append(entry) {
      log.debug("append", { kind: entry.kind, size: buffer.length });
      buffer.push(entry);
      if (buffer.length > capacity) {
        const dropped = buffer.length - capacity;
        buffer.splice(0, dropped);
        log.info("capacity-evict", { dropped, capacity, newSize: buffer.length });
      }
      for (const l of appendListeners) {
        try {
          l(entry);
        } catch {
          /* listener errors are non-fatal */
        }
      }
    },
    snapshot() {
      return [...buffer];
    },
    clear() {
      log.debug("clear", { previousSize: buffer.length });
      buffer.length = 0;
    },
    size() {
      return buffer.length;
    },
    onAppend(listener) {
      appendListeners.add(listener);
      return () => {
        appendListeners.delete(listener);
      };
    },
    replaceAll(entries) {
      const tail = entries.length > capacity ? entries.slice(entries.length - capacity) : [...entries];
      log.info("replaceAll", { previousSize: buffer.length, newSize: tail.length, capacity });
      buffer.length = 0;
      for (const e of tail) buffer.push(e);
      const view = [...buffer];
      for (const l of snapshotListeners) {
        try {
          l(view);
        } catch {
          /* listener errors are non-fatal */
        }
      }
    },
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
  };
}
