import { getLog } from "../logging/logger.js";
import { FLUSH_SIGNAL, type TtsChunk } from "../tts/stages/stage-types.js";
import type { HermesEvent } from "./hermes-event-types.js";

const log = getLog(["sentient", "cerebrum", "text-delta-broadcaster"]);

/**
 * Fork a HermesEvent stream into two consumers:
 * (1) translatorEvents: sees ALL events.
 * (2) textDeltas: sees text deltas as strings, plus a FLUSH_SIGNAL marker
 *     whenever the model interrupts the text stream to call a tool. The
 *     marker tells downstream TTS stages "drain whatever you've buffered
 *     now" — without it, a short pre-tool acknowledgement ("Let me check.")
 *     would sit in the aggregator until the next text delta arrives, which
 *     may be seconds away on the far side of the tool round-trip.
 *
 * Both consumers are driven by ONE upstream iteration. We yield on a
 * dedicated queue so the TTS pipeline can run concurrently with the
 * translator.
 */
export function forkTextDeltas(source: AsyncIterable<HermesEvent>): {
  translatorEvents: AsyncGenerator<HermesEvent>;
  textDeltas: AsyncGenerator<TtsChunk>;
} {
  type Queue<T> = { items: T[]; resolvers: ((v: IteratorResult<T>) => void)[]; done: boolean };
  function makeQueue<T>(): Queue<T> {
    return { items: [], resolvers: [], done: false };
  }
  const eventsQ = makeQueue<HermesEvent>();
  const textQ = makeQueue<TtsChunk>();

  function push<T>(q: Queue<T>, v: T): void {
    const r = q.resolvers.shift();
    if (r) r({ value: v, done: false });
    else q.items.push(v);
  }
  function end<T>(q: Queue<T>): void {
    q.done = true;
    while (q.resolvers.length > 0) {
      q.resolvers.shift()?.({ value: undefined as unknown as T, done: true });
    }
  }
  function pull<T>(q: Queue<T>): Promise<IteratorResult<T>> {
    if (q.items.length > 0) {
      return Promise.resolve({ value: q.items.shift() as T, done: false });
    }
    if (q.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise<IteratorResult<T>>((res) => q.resolvers.push(res));
  }

  (async () => {
    try {
      for await (const ev of source) {
        push(eventsQ, ev);
        if (ev.type === "text.delta") {
          push(textQ, ev.delta);
        } else if (ev.type === "tool.started") {
          log.debug("flush-injected", { reason: "tool.started", toolName: ev.toolName });
          push(textQ, FLUSH_SIGNAL);
        }
      }
    } catch (err: unknown) {
      log.debug("pump.error", {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      end(eventsQ);
      end(textQ);
    }
  })();

  const translatorEvents = (async function* () {
    while (true) {
      const r = await pull(eventsQ);
      if (r.done) return;
      yield r.value;
    }
  })();
  const textDeltas = (async function* () {
    while (true) {
      const r = await pull(textQ);
      if (r.done) return;
      yield r.value;
    }
  })();

  return { translatorEvents, textDeltas };
}
