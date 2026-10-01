// Host-only cross-language fixture. No sockets, services, model, or private data.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createSttSession } from "../../../../gateway/src/session-handlers/stt-session.ts";
import { handleWebSocketMessage, cleanupSession } from "../../../../gateway/src/session-handlers/ws-handlers.ts";
import { createEmptySessionData } from "../../../../gateway/src/session-handlers/ws-helpers.ts";
import { createSessionRegistry } from "../../../../gateway/src/session-handlers/session-registry.ts";
import { createUserPrincipal } from "../../../../gateway/src/identity/user-principal.ts";
import type { STTEvent } from "../../../../gateway/src/adapters/stt/stt-adapter-types.ts";

const child = spawn(process.argv[2]!, [], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
let submits = 0;
const adapters: ReturnType<typeof adapter>[] = [];
function adapter() {
  const queued: (STTEvent | null)[] = [];
  let receive: ((event: STTEvent | null) => void) | null = null;
  const emit = (event: STTEvent | null) => {
    if (receive) { const fn = receive; receive = null; fn(event); }
    else queued.push(event);
  };
  const value = {
    flushes: 0, closes: 0, bytes: 0, emit,
    open: async () => {},
    send: (bytes: Uint8Array) => { value.bytes += bytes.length; },
    endUtterance: () => { ++value.flushes; },
    setTurnMode: () => {}, suppressInputFor: () => {},
    close: async () => { ++value.closes; emit(null); },
    async *events() {
      for (;;) {
        const event = queued.length ? queued.shift()! : await new Promise<STTEvent | null>((resolve) => { receive = resolve; });
        if (event === null) return;
        yield event;
      }
    },
  };
  return value;
}
const runtime = { submit: () => { ++submits; }, bargeIn: () => {} };
const stt = createSttSession({
  sessionId: "sdk-host", factory: () => { const value = adapter(); adapters.push(value); return value; },
  config: { url: "ws://unused", language: "en", pauseRenderLanguage: "en", inputSampleRate: 16000,
    ttsEchoCooldownMs: 0, connectTimeoutMs: 10, audioFormat: "opus", finalizeTimeoutMs: 1000 },
  getRuntime: () => runtime as never, getRuntimeForInput: async () => runtime as never,
});
const data = createEmptySessionData();
data.sessionId = "sdk-host";
data.authState = "authed";
data.principal = createUserPrincipal("u_deadbeef", "adult", "home");
data.stt = stt;
const replies: string[] = [];
const ws = { data, readyState: 1, getBufferedAmount: () => 0, send: (json: string) => replies.push(json), close: () => {} };
const services = { sessionRegistry: createSessionRegistry(), authenticatedSockets: { remove: () => {} },
  sessionManager: { unbindUser: () => {}, removeSession: () => {} } };
async function sdk(command: string) {
  child.stdin!.write(`${command}\n`);
  const line = await lines.next();
  assert(!line.done, "SDK fixture exited");
  const result = JSON.parse(line.value!);
  // Translate actual SDK retirement into actual gateway teardown. Old broad
  // refusal recovery discarded A here, before delayed finalization could run.
  if (!result.ready) cleanupSession(ws as never, services as never);
  for (const frame of result.frames) await handleWebSocketMessage(ws as never, JSON.stringify(frame), services as never);
  for (let i = 0; i < result.binary; ++i) await handleWebSocketMessage(ws as never, Buffer.from([42]), services as never);
  return result;
}
try {
  const a = (await sdk("start")).frames[0].captureId;
  await tick();
  await sdk("pump");
  await sdk("end");
  assert.equal(adapters[0]!.flushes, 1);
  const b = (await sdk("start")).frames[0].captureId;
  assert.notEqual(a, b);
  const refusal = replies.shift()!;
  assert.deepEqual(JSON.parse(refusal), { type: "command.rejected", command: "audio.start", reason: "session_busy" });
  const refused = await sdk(refusal);
  if (!refused.ready) {
    adapters[0]!.emit({ type: "transcript", turnIdx: 1, text: "synthetic fixture A" });
    await tick();
    assert.equal(submits, 1, "SDK busy recovery discarded prior committing capture before its delayed finalization");
  }
  assert(refused.ready && refused.fenced);
  assert.equal((await sdk("start")).started, false); // No new admission during cleanup.
  assert.equal((await sdk("pump")).binary, 0);
  const cancelled = await sdk("settle");
  assert.deepEqual(cancelled.frames.map((f: { type: string; captureId: string }) => [f.type, f.captureId]), [["audio.cancel", b]]);
  assert.equal(adapters[0]!.closes, 0); // A remains committing on SAME adapter.
  assert.equal(adapters[0]!.bytes, 1);

  // Refusal delayed past B2 end: do not cancel any already-ended identity.
  await sdk("start");
  const delayed = replies.shift()!;
  await sdk("end");
  await sdk(delayed);
  assert.deepEqual((await sdk("settle")).frames, []);
  assert.equal(adapters[0]!.closes, 0);
  adapters[0]!.emit({ type: "transcript", turnIdx: 1, text: "synthetic fixture A" });
  await tick();
  assert.equal(submits, 1); // Real delayed STT dispatch, not a mocked success setter.
  assert.equal(adapters[0]!.closes, 1);

  // An uncorrelated late/duplicate refusal while C is OPEN can conservatively
  // cancel C, never attribute the refusal to A or cancel an ended capture.
  const c = (await sdk("start")).frames[0].captureId;
  await tick();
  await sdk(delayed);
  const cCancel = await sdk("settle");
  assert.equal(cCancel.frames[0].captureId, c);
  assert.equal(cCancel.frames[0].type, "audio.cancel");
  assert.equal(submits, 1);
  assert.equal(adapters[1]!.closes, 1);
  await sdk("start"); await tick(); await sdk("end");
  adapters[2]!.emit({ type: "transcript", turnIdx: 2, text: "synthetic fixture retry" });
  await tick();
  assert.equal(submits, 2);
  assert.equal(ws.data.audioCapture, null);
  console.log("busy refusal / delayed committing capture: PASS");
} finally {
  stt.close(); child.stdin!.end(); child.kill();
}
