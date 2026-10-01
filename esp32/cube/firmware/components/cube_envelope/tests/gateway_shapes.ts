// SPDX-License-Identifier: MIT
// Synthetic current-wire fixtures. No services, stores or production emitter side effects.
import { gatewayMessageSchema } from "../../../../../../shared/protocol/src/messages.ts";

const item = { entryId: "entry", ts: 1, kind: "user", channel: "text", content: "synthetic", sessionId: "session" };
const task = {
  id: "task",
  toolName: "delegateTask",
  kind: "background",
  status: "running",
  argsPreview: "",
  startedAtMs: 1,
};
const frames = [
  { type: "auth.ok", user: { userId: "user", displayName: "Test", role: "adult", isAdmin: false, avatarTint: "blue" } },
  { type: "auth.error", code: "auth-required", message: "synthetic" },
  {
    type: "session.ready",
    sessionId: "connection",
    audioEncoding: "pcm16",
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    enabledEffects: [],
  },
  { type: "session.attached", sessionId: "session", generation: 1 },
  { type: "command.rejected", command: "audio.start", reason: "session_busy" },
  { type: "turn.started", turnId: "turn", trigger: "user" },
  { type: "turn.text.delta", turnId: "turn", text: "synthetic" },
  { type: "turn.completed", turnId: "turn" },
  { type: "turn.aborted", turnId: "turn", cutoff: "interrupt" },
  { type: "tasklist.state", turnId: "turn", items: [task] },
  // TaskListProjector.onTurnEnded -> publishTaskList -> WsTurnEmitter.taskList.
  { type: "tasklist.state", turnId: null, items: [task] },
  { type: "turn.audio.start", turnId: "turn", encoding: "opus", sampleRate: 24000 },
  { type: "turn.audio.start", turnId: "turn", encoding: "pcm", sampleRate: 44100 },
  { type: "turn.audio.done", turnId: "turn" },
  {
    type: "permission.request",
    requestId: "request",
    toolCallId: "call",
    toolName: "tool",
    args: { seq: null, epoch: [], turnId: {}, reason: false },
    description: "synthetic",
    expiresAtMs: 1,
  },
  { type: "permission.resolved", requestId: "request", outcome: "timeout" },
  { type: "delegation.progress", taskId: "task", turnId: "turn", agent: "hermes", status: "running" },
  { type: "conversation.snapshot", items: [item] },
  { type: "conversation.entry", item },
  { type: "conversation.entry", turnId: "turn", item },
  { type: "error", code: "protocol_error", message: "synthetic" },
  { type: "pong" },
  { type: "session.expired", reason: "synthetic" },
  { type: "playback.stop", turnId: "turn", reason: "barge-in" },
  { type: "sessions.deleted", sessionId: "session" },
  { type: "sessions.renamed", sessionId: "session", title: "Test" },
  { type: "session.created", sessionId: "session", ts: 1 },
  { type: "session.draft", draftKey: "draft", ts: 1 },
  { type: "session.title", sessionId: "session", title: "Test", provenance: "generated" },
  { type: "session.switched", sessionId: "session", ts: 1 },
  { type: "sessions.error", code: "not_found", message: "synthetic" },
  { type: "stream.resumed", recovered: false, epoch: 2 },
  { type: "stream.resumed", recovered: true, epoch: 2, fromSeq: 1, toSeq: 2 },
].map((frame) => gatewayMessageSchema.parse(frame));

// This contract check must notice new union branches rather than silently assuming
// Cube's current handlers enumerate every same-wire producer shape.
const covered = new Set(frames.map((frame) => frame.type));
for (const schema of gatewayMessageSchema.options) {
  if (!covered.has(schema.shape.type.value)) throw new Error("missing synthetic gateway variant");
}
process.stdout.write(JSON.stringify(frames));
