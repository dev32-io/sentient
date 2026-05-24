/**
 * Test helpers — event collection, assertions, async utilities.
 */

import type { PipelineEvent, PipelineState, FlowManager } from "./pipeline";

// ─── Event Collector ───

export class EventCollector {
  readonly events: PipelineEvent[] = [];
  private waiters: Array<{ predicate: (e: PipelineEvent) => boolean; resolve: () => void }> = [];

  handler = (event: PipelineEvent) => {
    this.events.push(event);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].predicate(event)) {
        this.waiters[i].resolve();
        this.waiters.splice(i, 1);
      }
    }
  };

  /** Wait for an event matching a predicate, with timeout */
  waitFor(predicate: (e: PipelineEvent) => boolean, timeoutMs = 2000): Promise<void> {
    // Check if already received
    if (this.events.some(predicate)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timed out waiting for event (${timeoutMs}ms). Events received: ${this.summary()}`));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: () => { clearTimeout(timer); resolve(); },
      });
    });
  }

  /** Wait for a specific state transition */
  waitForState(state: PipelineState, timeoutMs = 2000): Promise<void> {
    return this.waitFor(
      (e) => e.type === "state.changed" && e.to === state,
      timeoutMs
    );
  }

  /** Wait for an event of a specific type */
  waitForType(type: PipelineEvent["type"], timeoutMs = 2000): Promise<void> {
    return this.waitFor((e) => e.type === type, timeoutMs);
  }

  /** Get all events of a specific type */
  ofType<T extends PipelineEvent["type"]>(type: T): Extract<PipelineEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as any;
  }

  /** Get state transition sequence */
  stateSequence(): PipelineState[] {
    return this.ofType("state.changed").map((e) => e.to);
  }

  /** Get all partial transcript texts */
  partialTexts(): string[] {
    return this.ofType("transcript.partial").map((e) => e.text);
  }

  /** Get all text deltas concatenated */
  fullResponseText(): string {
    return this.ofType("response.text.delta").map((e) => e.text).join("");
  }

  /** Count audio frames received */
  audioFrameCount(): number {
    return this.ofType("response.audio.frame").length;
  }

  /** Check if audio.done was received */
  hasAudioDone(): boolean {
    return this.events.some((e) => e.type === "response.audio.done");
  }

  /** Check if any error was emitted */
  hasError(): boolean {
    return this.events.some((e) => e.type === "error");
  }

  /** Get error events */
  errors(): Extract<PipelineEvent, { type: "error" }>[] {
    return this.ofType("error");
  }

  /** Short summary of events for debugging */
  summary(): string {
    return this.events.map((e) => {
      if (e.type === "state.changed") return `state:${e.from}→${e.to}`;
      if (e.type === "transcript.partial") return `partial:"${e.text}"`;
      if (e.type === "transcript.final") return `final:"${e.text}"`;
      if (e.type === "response.text.delta") return `delta`;
      if (e.type === "response.audio.frame") return `audio`;
      return e.type;
    }).join(", ");
  }

  clear() {
    this.events.length = 0;
  }
}

// ─── Simple Test Runner ───

type TestFn = () => Promise<void>;
const tests: Array<{ name: string; fn: TestFn; category: string }> = [];
let currentCategory = "";

export function describe(name: string, fn: () => void) {
  const prev = currentCategory;
  currentCategory = prev ? `${prev} > ${name}` : name;
  fn();
  currentCategory = prev;
}

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn, category: currentCategory });
}

export async function runTests() {
  let passed = 0;
  let failed = 0;
  let lastCategory = "";

  for (const t of tests) {
    if (t.category !== lastCategory) {
      console.log(`\n  ${t.category}`);
      lastCategory = t.category;
    }
    try {
      await t.fn();
      passed++;
      console.log(`    ✓ ${t.name}`);
    } catch (err: any) {
      failed++;
      console.log(`    ✗ ${t.name}`);
      console.log(`      ${err.message}`);
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
}

// ─── Assertions ───

export function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, label?: string) {
  if (actual !== expected) {
    throw new Error(`${label ?? "assertEqual"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes<T>(arr: T[], item: T, label?: string) {
  if (!arr.includes(item)) {
    throw new Error(`${label ?? "assertIncludes"}: expected array to include ${JSON.stringify(item)}, got ${JSON.stringify(arr)}`);
  }
}

export function assertDeepEqual<T>(actual: T, expected: T, label?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label ?? "assertDeepEqual"}: expected ${b}, got ${a}`);
  }
}

// ─── Async Utilities ───

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run a full turn: utteranceStart → sendAudio × N → utteranceEnd, wait for completion */
export async function runFullTurn(
  pipeline: FlowManager,
  collector: EventCollector,
  options?: { audioChunks?: number }
) {
  const chunks = options?.audioChunks ?? 3;
  pipeline.utteranceStart();
  for (let i = 0; i < chunks; i++) {
    pipeline.sendAudio(new Uint8Array([i]));
  }
  pipeline.utteranceEnd();
  // Wait for full turn to complete (back to listening)
  await collector.waitForType("response.audio.done", 3000);
  // Small delay for state transition
  await delay(10);
}
