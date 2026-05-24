import { getLog } from "../logging/logger.js";
import type { AmbientEvent } from "./ambient-event.js";

const log = getLog(["sentient", "sensors", "ambient-event-log"]);

const DEFAULT_CAPACITY = 10_000;

export interface AmbientEventLog {
  append(evt: AmbientEvent): void;
  recent(limit: number): AmbientEvent[];
  snapshot(): readonly AmbientEvent[];
  clear(): void;
}

/**
 * Bounded FIFO ring buffer for ambient events.
 * Oldest events are discarded when capacity is exceeded.
 */
export function createAmbientEventLog(capacity: number = DEFAULT_CAPACITY): AmbientEventLog {
  const buffer: AmbientEvent[] = [];

  return {
    append(evt) {
      buffer.push(evt);
      if (buffer.length > capacity) buffer.shift();
      log.debug("append", { source: evt.source, size: buffer.length });
    },
    recent(limit) {
      if (limit <= 0) return [];
      return buffer.slice(-limit);
    },
    snapshot() {
      return [...buffer];
    },
    clear() {
      log.debug("clear", { size: buffer.length });
      buffer.length = 0;
    },
  };
}
