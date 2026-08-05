// Session titling (session-model spec §6) — the auxiliary-task seam's first
// user. What is pinned here is NOT "the model wrote a nice title": it is the
// two independent store guards, the fallback, and the shape of the line that
// tells an operator which of them fired.
//
// THE RACE IS REAL, NOT THEORETICAL. The generator fires seconds after the
// first reply commits — exactly the window in which a person renames the
// thread they are looking at. Both of task 2's guards are needed and neither
// is redundant:
//
//   - the CAS VERSION catches a CONCURRENT write. It is read BEFORE the
//     provider round trip; re-reading it at write time (the tempting
//     simplification, because it always succeeds) silently makes the guard a
//     no-op, so there is a counter-case below that fails for that form.
//   - the PROVENANCE check catches a LATER write that happens to carry a
//     valid version — a person's title that was already there when the
//     generator started.
//
// Zero-cost: real on-disk stores under a scratch root (session-store.test.ts's
// precedent), hand-rolled provider doubles, no keys and no network.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { reset } from "@logtape/logtape";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createGatewayLogger } from "../logging/logger.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../provider/provider-client.js";
import type { NewSessionEntry } from "../store/entry-types.js";
import type { TitleProvenance } from "../store/session-metadata.js";
import { openSessionStore } from "../store/session-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { AuxiliaryTaskConfig } from "./auxiliary-task.js";
import { TITLE_FALLBACK, runTitler } from "./titler.js";

const ROOT = "/tmp/sentient-titler-test";
const USER_ID = "u_aaaaaaaa";
const SESSION_ID = "s_00000000000000000000000000000001";
const MINT_KEY = "mint-1";
const FIRST_MESSAGE = "Can you turn the kitchen lights down to about thirty percent after seven every evening?";

mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const logLines: string[] = [];
beforeAll(async () => {
  await createGatewayLogger({ logLevel: "debug", testSink: (line) => logLines.push(line) });
});
afterAll(async () => {
  // PROCESS-GLOBAL and configured with `reset: true`, so leaving the test sink
  // installed redirects every LATER test file's logs into this array and
  // silences their stderr. Same discipline as session-permission-broker.test.ts.
  await reset();
});

let storeCount = 0;

/** A real store with a real `sessions` row and a first user + assistant turn —
 *  the state the titler is actually fired in. */
function makeStore(): SessionStore {
  storeCount += 1;
  const am = createAccessManager({ userDataRoot: `${ROOT}/case${storeCount}` });
  const alice = createUserPrincipal(USER_ID, "adult", "home");
  mkdirSync(am.userHomeDir(alice), { recursive: true });
  const store = openSessionStore(am.grant(alice, "session-store"));
  store.createSession(SESSION_ID, MINT_KEY);
  append(store, "user", FIRST_MESSAGE);
  append(store, "assistant", "Sure — I've set the kitchen lights to 30% from 7pm.");
  return store;
}

function append(store: SessionStore, kind: NewSessionEntry["kind"], text: string): void {
  store.append({
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: null,
    kind,
    createdAt: Date.now(),
    text,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  });
}

function testConfig(): AuxiliaryTaskConfig {
  return {
    enabled: true,
    template_dir: "system_prompts/auxiliary",
    override_dir: "config/auxiliary",
    max_output_tokens: 200,
    input_truncation_chars: 4000,
    reasoning_effort: "none",
    title_word_target: 5,
    title_max_chars: 60,
  };
}

interface EmittedTitle {
  title: string;
  provenance: TitleProvenance;
}

interface Harness {
  store: SessionStore;
  emitted: EmittedTitle[];
  providerCalls: ProviderRequest[];
  run: () => Promise<unknown>;
}

/** [answer] is what the model streams back; `null` makes the provider fail.
 *  [beforeWrite] runs AFTER the provider answers and BEFORE the store write —
 *  the race window a rename lands in. */
function harness(opts: {
  answer: string | null;
  store?: SessionStore;
  beforeWrite?: (store: SessionStore) => void;
}): Harness {
  const store = opts.store ?? makeStore();
  const emitted: EmittedTitle[] = [];
  const providerCalls: ProviderRequest[] = [];
  const provider: ProviderClient = {
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      providerCalls.push(req);
      if (opts.answer === null) throw new Error("provider exploded");
      yield { type: "text", content: opts.answer };
      yield { type: "done", finishReason: "stop" };
      opts.beforeWrite?.(store);
    },
  };
  return {
    store,
    emitted,
    providerCalls,
    run: () =>
      runTitler({
        store,
        provider,
        sessionId: SESSION_ID,
        userId: USER_ID,
        config: testConfig(),
        loadTemplate: () => "Name this: {{conversation}} in {{word_target}} words.",
        emitTitle: (title, provenance) => emitted.push({ title, provenance }),
        signal: new AbortController().signal,
      }),
  };
}

function titleOf(store: SessionStore): string | null {
  return store.getSession(SESSION_ID)?.title ?? null;
}

function linesSince(mark: number, event: string): string[] {
  return logLines.slice(mark).filter((line) => line.includes(event));
}

describe("runTitler", () => {
  it("titles an untitled session from the model's answer", async () => {
    const h = harness({ answer: '{"title":"Kitchen light schedule"}' });
    await h.run();
    expect(titleOf(h.store)).toBe("Kitchen light schedule");
    expect(h.emitted).toEqual([{ title: "Kitchen light schedule", provenance: "generated" }]);
    h.store.close();
  });

  it("SECURITY-ADJACENT: a generated title never overwrites a title the user set", async () => {
    const store = makeStore();
    const s = store.getSession(SESSION_ID);
    if (s === null) throw new Error("session row missing");
    store.setTitle(SESSION_ID, "Kitchen lights", "user", s.version);

    const h = harness({ answer: '{"title":"Something else entirely"}', store });
    await h.run();

    expect(titleOf(store)).toBe("Kitchen lights");
    // The up-front provenance check is what saves the provider call; the
    // store's own provenance guard is what makes it SAFE if that check ever
    // races (session-metadata.test.ts pins that half).
    expect(h.providerCalls).toHaveLength(0);
    expect(h.emitted).toEqual([]);
    store.close();
  });

  it("SECURITY-ADJACENT: a rename that lands DURING generation still keeps the user's name", async () => {
    // The version the titler is holding was valid when it started, and the
    // rename arrives while the model is thinking. Nothing in the titler can
    // see it — the refusal is the store's, and in THIS ordering it is the CAS
    // that fires (a rename bumps the version). The provenance half of the same
    // statement is the independent second refusal, pinned directly in
    // store/session-metadata.test.ts rather than restated here.
    const h = harness({
      answer: '{"title":"Model chosen title"}',
      beforeWrite: (store) => {
        const current = store.getSession(SESSION_ID);
        if (current === null) throw new Error("session row missing");
        store.setTitle(SESSION_ID, "Evening lights", "user", current.version);
      },
    });
    await h.run();
    expect(titleOf(h.store)).toBe("Evening lights");
    // Nothing is pushed to the windows for a write the store refused.
    expect(h.emitted).toEqual([]);
    h.store.close();
  });

  it("refuses to write over a version that moved, even when the winner is also generated", async () => {
    // The CAS guard ALONE. Provenance cannot save this one — both writes are
    // "generated" — so a titler that re-reads the version immediately before
    // writing (the tempting simplification, because it always succeeds) lets
    // the second run clobber the first and fails here.
    const h = harness({
      answer: '{"title":"Second run"}',
      beforeWrite: (store) => {
        const current = store.getSession(SESSION_ID);
        if (current === null) throw new Error("session row missing");
        store.setTitle(SESSION_ID, "First run", "generated", current.version);
      },
    });
    await h.run();
    expect(titleOf(h.store)).toBe("First run");
    h.store.close();
  });

  it("INVARIANT: a failed titling attempt leaves a readable title, never 'Untitled'", async () => {
    const mark = logLines.length;
    const h = harness({ answer: null });
    await h.run();

    const stored = titleOf(h.store);
    expect(stored).not.toBeNull();
    expect(FIRST_MESSAGE.startsWith((stored ?? "").replace(/…$/, ""))).toBe(true);
    expect(h.emitted).toEqual([{ title: stored ?? "", provenance: "generated" }]);
    h.store.close();

    // The LITERAL log shape. "A failure is logged with a reason" is satisfiable
    // by `title.failed` with no reason at all, which is how a vacuous pass gets
    // shipped: the line must name BOTH the root cause and which fallback ran.
    const warned = linesSince(mark, "titler.generation-failed");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("WARN");
    expect(warned[0]).toMatch(/reason="[^"]+"/);
    expect(warned[0]).toContain(`fallback="${TITLE_FALLBACK}"`);
  });

  it("caps a title the model made too long, so the frame is never rejected on the wire", async () => {
    // `session.title` validates against a 200-char TITLE_MAX and a rejected
    // frame is DROPPED before it leaves — a silent no-title, indistinguishable
    // from the generator never running.
    const h = harness({ answer: `{"title":"${"very ".repeat(40)}long"}` });
    await h.run();
    expect((titleOf(h.store) ?? "").length).toBeLessThanOrEqual(testConfig().title_max_chars);
    h.store.close();
  });

  it("does nothing when the session has no metadata row to title", async () => {
    const h = harness({ answer: '{"title":"anything"}' });
    // A legacy `c::` session id has no `sessions` row: there is nowhere to
    // compare-and-set against, so there is nothing safe to write.
    await runTitler({
      store: h.store,
      provider: { async *stream() {} },
      sessionId: "c::u_aaaaaaaa::web",
      userId: USER_ID,
      config: testConfig(),
      loadTemplate: () => "unused",
      emitTitle: (title, provenance) => h.emitted.push({ title, provenance }),
      signal: new AbortController().signal,
    });
    expect(h.emitted).toEqual([]);
    h.store.close();
  });
});
