# Local STT Gateway Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap Deepgram (Flux/Nova-3) for the local STT service as the gateway's only speech-to-text source, and use that pivot to shrink the pipeline, delete the barge-in controller + partial-transcript plumbing, move the energy VAD gate into the gateway, and introduce a `src/bootstrap/` factory layer that reduces `main.ts` to a thin composer.

**Architecture:** New `adapters/stt/local-stt-adapter.ts` implementing a 4-method contract (`open`/`send`/`events`/`close`) against the localSTT WebSocket. `ContinuousSession` rewrites into a ~140-line event loop over the adapter's `STTEvent` stream. Per-service factories (`stt-factory`, `tts-factory`, `llm-factory`, `context-factory`) compose through `createGatewayServices(config)`; `main.ts` is ~15 lines.

**Tech Stack:** Bun / TypeScript (strict), Vitest, zod, `shared/config`, `shared/protocol`, `shared/web-sdk` (Preact consumer), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-04-13-local-stt-gateway-refactor-design.md`

---

## Preflight

Before starting, verify environment and run baseline:

- [ ] **Step 0.1: Source env + verify tools**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun --version
```

Expected: bun ≥ 1.1.x.

- [ ] **Step 0.2: Confirm on a clean branch**

```bash
git status --short
git branch --show-current
```

Expected: branch is `develop` (or a feature branch). `git status` shows only uncommitted STT service work already tracked in earlier commits. If any untracked work beyond that, stop and ask.

- [ ] **Step 0.3: Run baseline CI**

```bash
bun run ci
```

Expected: all lint + typecheck + tests pass. Any failures here are not caused by this plan — stop and resolve first. Per `feedback_skip_broken_tests`, if the baseline has pre-existing flakes, record them now so we can distinguish them later.

---

## Phase A — Foundations (pure helpers + shared contracts)

Independent, TDD-tight tasks. Each produces files with zero downstream consumers, so they can land before any wiring.

### Task A1: Protocol schema swap

**Files:**
- Modify: `shared/protocol/src/messages.ts`
- Modify: `shared/protocol/src/messages.test.ts`

- [ ] **Step A1.1: Update `shared/protocol/src/messages.ts`**

Replace the entire file with this content. The changes are: drop `auth`/`barge_in`/`utterance.*`/`guest.auth`/`session.start` from the client discriminated union; drop `transcript.partial`/`vad.speech-start`/`vad.speech-end`/`status.processing` from the gateway discriminated union; add `turn.started` + `turn.dropped`; rewrite `transcript.final` to carry `turnIdx` + `text`.

```ts
import { z } from "zod";
import { userRoleSchema } from "./roles.ts";

// ─── Client → Gateway Messages ───

export const sessionConfigureSchema = z.object({
  type: z.literal("session.configure"),
  supportedEncodings: z.array(z.enum(["pcm16", "opus"])),
  preferredEncoding: z.enum(["pcm16", "opus"]),
  captureSampleRate: z.number().int().positive(),
  playbackSampleRate: z.number().int().positive(),
});

export const audioStartSchema = z.object({
  type: z.literal("audio.start"),
});

export const audioEndSchema = z.object({
  type: z.literal("audio.end"),
});

export const textInputSchema = z.object({
  type: z.literal("text.input"),
  text: z.string().min(1).max(10000),
});

export const toolConfirmSchema = z.object({
  type: z.literal("tool.confirm"),
  toolCallId: z.string(),
  approved: z.boolean(),
});

export const sessionEndSchema = z.object({
  type: z.literal("session.end"),
});

export const pingSchema = z.object({
  type: z.literal("ping"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  sessionConfigureSchema,
  audioStartSchema,
  audioEndSchema,
  textInputSchema,
  toolConfirmSchema,
  sessionEndSchema,
  pingSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Gateway → Client Messages ───

export const authOkSchema = z.object({
  type: z.literal("auth.ok"),
  sessionId: z.string(),
  role: userRoleSchema,
});

export const sessionReadySchema = z.object({
  type: z.literal("session.ready"),
  encoding: z.enum(["pcm16", "opus"]),
  captureSampleRate: z.number().int().positive(),
  playbackSampleRate: z.number().int().positive(),
});

export const turnStartedSchema = z.object({
  type: z.literal("turn.started"),
  turnIdx: z.number().int().min(1),
});

export const turnDroppedSchema = z.object({
  type: z.literal("turn.dropped"),
  turnIdx: z.number().int().min(1),
});

export const transcriptFinalSchema = z.object({
  type: z.literal("transcript.final"),
  turnIdx: z.number().int().min(1),
  text: z.string(),
});

export const responseStartSchema = z.object({
  type: z.literal("response.start"),
  utteranceId: z.string(),
  responseId: z.string(),
});

export const responseTextDeltaSchema = z.object({
  type: z.literal("response.text.delta"),
  text: z.string(),
  responseId: z.string().optional(),
});

export const responseTextDoneSchema = z.object({
  type: z.literal("response.text.done"),
  responseId: z.string().optional(),
});

export const responseAudioStartSchema = z.object({
  type: z.literal("response.audio.start"),
  responseId: z.string().optional(),
});

export const responseAudioDoneSchema = z.object({
  type: z.literal("response.audio.done"),
  responseId: z.string().optional(),
});

export const toolConfirmRequestSchema = z.object({
  type: z.literal("tool.confirm_request"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
  description: z.string(),
  responseId: z.string().optional(),
});

export const bargeInAckSchema = z.object({
  type: z.literal("barge_in.ack"),
  responseId: z.string().optional(),
});

export const errorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
});

export const sessionExpiredSchema = z.object({
  type: z.literal("session.expired"),
  reason: z.string(),
});

export const gatewayMessageSchema = z.discriminatedUnion("type", [
  authOkSchema,
  sessionReadySchema,
  turnStartedSchema,
  turnDroppedSchema,
  transcriptFinalSchema,
  responseStartSchema,
  responseTextDeltaSchema,
  responseTextDoneSchema,
  responseAudioStartSchema,
  responseAudioDoneSchema,
  toolConfirmRequestSchema,
  bargeInAckSchema,
  errorSchema,
  pongSchema,
  sessionExpiredSchema,
]);

export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;
```

- [ ] **Step A1.2: Update `shared/protocol/src/messages.test.ts`**

Replace test cases for dropped types with cases for new/changed types. Keep any test helpers untouched. The file's imports at the top should match what the new `messages.ts` exports. Add these blocks and remove any assertion blocks that reference `transcriptPartialSchema`, `vadSpeechStartSchema`, `vadSpeechEndSchema`, `statusProcessingSchema`, `authMessageSchema`, `bargeInSchema`, `utteranceStartSchema`, `utteranceEndSchema`, `utteranceCancelSchema`, `sessionStartSchema`, or `guestAuthSchema`.

```ts
import { describe, expect, it } from "vitest";
import {
  clientMessageSchema,
  gatewayMessageSchema,
  transcriptFinalSchema,
  turnDroppedSchema,
  turnStartedSchema,
} from "./messages.ts";

describe("turn.started", () => {
  it("parses a valid turn.started message", () => {
    const result = turnStartedSchema.safeParse({ type: "turn.started", turnIdx: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects turnIdx < 1", () => {
    const result = turnStartedSchema.safeParse({ type: "turn.started", turnIdx: 0 });
    expect(result.success).toBe(false);
  });
});

describe("turn.dropped", () => {
  it("parses a valid turn.dropped message", () => {
    const result = turnDroppedSchema.safeParse({ type: "turn.dropped", turnIdx: 5 });
    expect(result.success).toBe(true);
  });
});

describe("transcript.final (rewritten shape)", () => {
  it("parses when turnIdx and text are present", () => {
    const result = transcriptFinalSchema.safeParse({
      type: "transcript.final",
      turnIdx: 3,
      text: "hello [paused 1.2s] world",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when turnIdx is missing", () => {
    const result = transcriptFinalSchema.safeParse({ type: "transcript.final", text: "hi" });
    expect(result.success).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  it("parses audio.start", () => {
    expect(clientMessageSchema.safeParse({ type: "audio.start" }).success).toBe(true);
  });

  it("rejects removed auth type", () => {
    expect(clientMessageSchema.safeParse({ type: "auth", token: "t" }).success).toBe(false);
  });

  it("rejects removed barge_in type", () => {
    expect(clientMessageSchema.safeParse({ type: "barge_in" }).success).toBe(false);
  });
});

describe("gatewayMessageSchema", () => {
  it("parses turn.started", () => {
    expect(gatewayMessageSchema.safeParse({ type: "turn.started", turnIdx: 1 }).success).toBe(true);
  });

  it("rejects removed transcript.partial type", () => {
    expect(
      gatewayMessageSchema.safeParse({ type: "transcript.partial", text: "hi" }).success,
    ).toBe(false);
  });

  it("rejects removed vad.speech-start type", () => {
    expect(gatewayMessageSchema.safeParse({ type: "vad.speech-start" }).success).toBe(false);
  });
});
```

- [ ] **Step A1.3: Run the protocol tests**

```bash
source scripts/env.sh
bun run --cwd shared/protocol test
```

Expected: all pass.

- [ ] **Step A1.4: Commit**

```bash
git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts
git commit -m "refactor(protocol): shrink voice protocol to turn.started + transcript.final + turn.dropped

Drops client: auth, barge_in, utterance.*, guest.auth, session.start.
Drops server: transcript.partial, vad.*, status.processing.
Adds server: turn.started, turn.dropped.
transcript.final gains turnIdx and drops utteranceId.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: Config schema swap

**Files:**
- Modify: `shared/config/src/schema.ts`
- Modify: `shared/config/src/schema.test.ts`
- Modify: `gateway/config.yaml`

- [ ] **Step A2.1: Rewrite `shared/config/src/schema.ts`**

Delete `sttNova3ConfigSchema`. Replace `sttConfigSchema` with the local-stt shape. Remove `stt_nova3` from `gatewayConfigSchema`. Replace the matching block in the file — leave everything else (session, llm, tts, tls) untouched.

Find this block (lines 26-57 of the current file):

```ts
export const sttConfigSchema = z.object({
  provider: z.literal("deepgram"),
  model: z.string().default("flux-general-en"),
  // ... (Flux fields)
});

export type STTConfig = z.output<typeof sttConfigSchema>;

export const sttNova3ConfigSchema = z.object({
  // ... (Nova-3 fields)
});

export type STTNova3Config = z.output<typeof sttNova3ConfigSchema>;
```

Replace with:

```ts
export const sttConfigSchema = z.object({
  provider: z.literal("local-stt"),
  url: z.string().default("ws://stt-service:8766"),
  language: z.enum(["en", "zh"]).default("en"),
  input_sample_rate: z.number().int().min(8000).default(48000),
  energy_threshold: z.number().min(0).max(1).default(0.03),
  connect_timeout_ms: z.number().int().min(1000).default(10000),
  tokens_file: z.string().default("/app/tokens.yaml"),
});

export type STTConfig = z.output<typeof sttConfigSchema>;
```

Find the `gatewayConfigSchema` block (near the bottom of the file). Remove the `stt_nova3: sttNova3ConfigSchema.default({}),` line. The schema becomes:

```ts
export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(100).default(10),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  session_persist_ms: z.number().int().min(0).default(120000),
  tls: tlsConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
  stt: sttConfigSchema,
  llm: llmConfigSchema,
  tts: ttsConfigSchema,
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
```

Remove any remaining `STTNova3Config` export line.

- [ ] **Step A2.2: Update `shared/config/src/schema.test.ts`**

Any test that references `sttNova3ConfigSchema`, `STTNova3Config`, `provider: "deepgram"`, `eot_threshold`, `transcript_timeout_ms`, `model: "flux-general-en"`, or `stt_nova3:` fails to parse and must be rewritten against the new shape. Replace the whole STT-related describe block with:

```ts
describe("sttConfigSchema", () => {
  it("applies defaults", () => {
    const result = sttConfigSchema.parse({ provider: "local-stt" });
    expect(result.url).toBe("ws://stt-service:8766");
    expect(result.language).toBe("en");
    expect(result.input_sample_rate).toBe(48000);
    expect(result.energy_threshold).toBe(0.03);
    expect(result.connect_timeout_ms).toBe(10000);
    expect(result.tokens_file).toBe("/app/tokens.yaml");
  });

  it("rejects provider: deepgram", () => {
    const result = sttConfigSchema.safeParse({ provider: "deepgram" });
    expect(result.success).toBe(false);
  });

  it("accepts zh language", () => {
    const result = sttConfigSchema.parse({ provider: "local-stt", language: "zh" });
    expect(result.language).toBe("zh");
  });

  it("rejects unknown language", () => {
    const result = sttConfigSchema.safeParse({ provider: "local-stt", language: "fr" });
    expect(result.success).toBe(false);
  });

  it("rejects energy_threshold out of [0, 1]", () => {
    expect(
      sttConfigSchema.safeParse({ provider: "local-stt", energy_threshold: 1.5 }).success,
    ).toBe(false);
    expect(
      sttConfigSchema.safeParse({ provider: "local-stt", energy_threshold: -0.1 }).success,
    ).toBe(false);
  });
});
```

Also locate any `gatewayConfigSchema` test that references `stt_nova3` and delete/update it.

- [ ] **Step A2.3: Update `gateway/config.yaml`**

Replace the `stt:` and `stt_nova3:` blocks (current lines 46-82) with the new single `stt:` block. Leave the rest of the file exactly as-is.

```yaml
# ---------------------------------------------------------------------------
# STT — local-stt service (Silero VAD + Smart-Turn v3 + SenseVoice-Small)
# See capabilityServices/STTService/CONTRACT.md for the wire protocol.
# ---------------------------------------------------------------------------
stt:
  provider: local-stt
  # WS endpoint. In Pi docker-compose this resolves via service name;
  # for local dev override to ws://localhost:8766.
  url: ws://stt-service:8766

  # Language drives the pause-renderer template and the system-prompt
  # language hint file (gateway/system_prompts/language-prompt-<lang>.md).
  language: en                         # "en" | "zh"

  # Client capture rate. Adapter downsamples to 16 kHz before sending to STT.
  input_sample_rate: 48000

  # Normalized-RMS energy gate (0.0–1.0). Frames below this threshold
  # are dropped before hitting the STT WebSocket. Raise if you see
  # false VAD triggers from idle-room noise; lower if soft speech is missed.
  energy_threshold: 0.03

  connect_timeout_ms: 10000

  # Outbound bearer token is loaded from this file (mounted read-only
  # into the container by deploy/*/docker-compose.yml). The YAML must
  # contain a `gateway-stt` slot — managed by sentient-auth.
  tokens_file: /app/tokens.yaml
```

- [ ] **Step A2.4: Run the config tests**

```bash
bun run --cwd shared/config test
```

Expected: all pass.

- [ ] **Step A2.5: Commit**

```bash
git add shared/config/src/schema.ts shared/config/src/schema.test.ts gateway/config.yaml
git commit -m "refactor(config): swap Deepgram stt shape for local-stt

Drops sttNova3ConfigSchema entirely. Rewrites sttConfigSchema around
url, language, input_sample_rate, energy_threshold, connect_timeout_ms,
tokens_file.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: Pause renderer (pure)

**Files:**
- Create: `gateway/src/adapters/stt/pause-renderer.ts`
- Test: `gateway/src/adapters/stt/pause-renderer.test.ts`

- [ ] **Step A3.1: Write `pause-renderer.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { renderPauses } from "./pause-renderer.ts";

describe("renderPauses — english", () => {
  it("renders a single pause", () => {
    expect(renderPauses("hi [pause.0] there", [1200], "en")).toBe("hi [paused 1.2s] there");
  });

  it("renders multiple pauses in order", () => {
    const text = "a [pause.0] b [pause.1] c";
    expect(renderPauses(text, [1234, 876], "en")).toBe("a [paused 1.2s] b [paused 0.9s] c");
  });

  it("returns text unchanged when no pauses", () => {
    expect(renderPauses("plain text", [], "en")).toBe("plain text");
  });

  it("rounds to whole seconds when >= 10s", () => {
    expect(renderPauses("x [pause.0] y", [12_340], "en")).toBe("x [paused 12s] y");
  });

  it("clamps very short pauses to 0.1s", () => {
    expect(renderPauses("x [pause.0] y", [40], "en")).toBe("x [paused 0.1s] y");
  });
});

describe("renderPauses — chinese", () => {
  it("uses zh template", () => {
    expect(renderPauses("你好 [pause.0] 世界", [1200], "zh")).toBe("你好 [停顿 1.2秒] 世界");
  });
});

describe("renderPauses — contract-violation tolerance", () => {
  it("replaces what it can when pauses array is shorter", () => {
    const text = "a [pause.0] b [pause.1] c";
    expect(renderPauses(text, [1000], "en")).toBe("a [paused 1.0s] b [pause.1] c");
  });

  it("ignores extra pauses when array is longer", () => {
    const text = "a [pause.0] b";
    expect(renderPauses(text, [1000, 2000], "en")).toBe("a [paused 1.0s] b");
  });
});
```

- [ ] **Step A3.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/adapters/stt/pause-renderer.test.ts
```

Expected: fails with "cannot find module ./pause-renderer.ts" (file doesn't exist yet).

- [ ] **Step A3.3: Write `pause-renderer.ts`**

```ts
import { getLog } from "../../logging/logger.ts";

const log = getLog(["sentient", "stt", "pause-renderer"]);

const MIN_DISPLAY_MS = 100;
const WHOLE_SECONDS_THRESHOLD_MS = 10_000;

function formatDuration(ms: number, language: "en" | "zh"): string {
  const clamped = Math.max(ms, MIN_DISPLAY_MS);
  const seconds = clamped >= WHOLE_SECONDS_THRESHOLD_MS
    ? `${Math.round(clamped / 1000)}s`
    : `${(clamped / 1000).toFixed(1)}s`;
  if (language === "zh") {
    return `[停顿 ${seconds.replace("s", "秒")}]`;
  }
  return `[paused ${seconds}]`;
}

export function renderPauses(
  text: string,
  pausesMs: readonly number[],
  language: "en" | "zh",
): string {
  const placeholderCount = (text.match(/\[pause\.\d+\]/g) ?? []).length;
  if (placeholderCount !== pausesMs.length) {
    log.warn("pause-count-mismatch", {
      placeholders: placeholderCount,
      pauses: pausesMs.length,
    });
  }

  let result = text;
  const limit = Math.min(placeholderCount, pausesMs.length);
  for (let i = 0; i < limit; i++) {
    const ms = pausesMs[i] ?? 0;
    result = result.replace(`[pause.${i}]`, formatDuration(ms, language));
  }
  return result;
}
```

- [ ] **Step A3.4: Run test to verify it passes**

```bash
bun run --cwd gateway test src/adapters/stt/pause-renderer.test.ts
```

Expected: all pass.

- [ ] **Step A3.5: Commit**

```bash
git add gateway/src/adapters/stt/pause-renderer.ts gateway/src/adapters/stt/pause-renderer.test.ts
git commit -m "feat(gateway/adapters/stt): add pause renderer for localSTT transcripts

Renders [pause.N] tokens into language-aware text: [paused 1.2s] / [停顿 1.2秒].
Tolerates pause-count mismatches (logs WARN, renders what it can).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A4: PCM resampler (pure)

**Files:**
- Create: `gateway/src/adapters/stt/pcm-resampler.ts`
- Test: `gateway/src/adapters/stt/pcm-resampler.test.ts`

- [ ] **Step A4.1: Write `pcm-resampler.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { downsamplePcm16 } from "./pcm-resampler.ts";

function pcm16Of(samples: number[]): Uint8Array {
  const arr = new Int16Array(samples);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function toInt16(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

describe("downsamplePcm16", () => {
  it("returns input unchanged when rates match", () => {
    const input = pcm16Of([1, 2, 3, 4]);
    const output = downsamplePcm16(input, 16000, 16000);
    expect(Array.from(toInt16(output))).toEqual([1, 2, 3, 4]);
  });

  it("downsamples 48k → 16k by roughly 3×", () => {
    const samples = Array.from({ length: 48 }, (_, i) => i * 100);
    const output = downsamplePcm16(pcm16Of(samples), 48000, 16000);
    expect(toInt16(output).length).toBe(16);
  });

  it("handles empty input", () => {
    const output = downsamplePcm16(new Uint8Array(0), 48000, 16000);
    expect(output.byteLength).toBe(0);
  });

  it("preserves sample magnitude roughly (sanity check)", () => {
    const input = pcm16Of(new Array(48).fill(10_000));
    const output = downsamplePcm16(input, 48000, 16000);
    const outSamples = toInt16(output);
    for (const s of outSamples) {
      expect(Math.abs(s - 10_000)).toBeLessThan(10);
    }
  });
});
```

- [ ] **Step A4.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/adapters/stt/pcm-resampler.test.ts
```

Expected: fails (module missing).

- [ ] **Step A4.3: Write `pcm-resampler.ts`**

```ts
export function downsamplePcm16(
  input: Uint8Array,
  inputRate: number,
  outputRate: number,
): Uint8Array {
  if (inputRate === outputRate) return input;
  if (input.byteLength === 0) return input;

  const inSamples = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(inSamples.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, inSamples.length - 1);
    const frac = srcIndex - srcFloor;
    out[i] = Math.round((inSamples[srcFloor] ?? 0) * (1 - frac) + (inSamples[srcCeil] ?? 0) * frac);
  }

  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
```

- [ ] **Step A4.4: Run test to verify it passes**

```bash
bun run --cwd gateway test src/adapters/stt/pcm-resampler.test.ts
```

Expected: all pass.

- [ ] **Step A4.5: Commit**

```bash
git add gateway/src/adapters/stt/pcm-resampler.ts gateway/src/adapters/stt/pcm-resampler.test.ts
git commit -m "feat(gateway/adapters/stt): add PCM16 linear-interpolation downsampler

Moved from audio-stream-handler.ts (which will be deleted later) so the
new STT adapter can own its transport-layer transforms.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A5: Energy gate (pure)

**Files:**
- Create: `gateway/src/adapters/stt/energy-gate.ts`
- Test: `gateway/src/adapters/stt/energy-gate.test.ts`

- [ ] **Step A5.1: Write `energy-gate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { acceptEnergy, energyRmsNormalized } from "./energy-gate.ts";

function pcm16Of(samples: number[]): Uint8Array {
  const arr = new Int16Array(samples);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

describe("energyRmsNormalized", () => {
  it("returns 0 for silence", () => {
    const silence = pcm16Of(new Array(1024).fill(0));
    expect(energyRmsNormalized(silence)).toBe(0);
  });

  it("returns ~1.0 for full-scale square wave", () => {
    const fullScale = pcm16Of(new Array(1024).fill(32767));
    expect(energyRmsNormalized(fullScale)).toBeGreaterThan(0.99);
  });

  it("returns value in [0,1] for sine-ish input", () => {
    const samples = Array.from({ length: 1024 }, (_, i) =>
      Math.round(Math.sin((i / 1024) * 2 * Math.PI) * 16384),
    );
    const rms = energyRmsNormalized(pcm16Of(samples));
    expect(rms).toBeGreaterThan(0);
    expect(rms).toBeLessThan(1);
  });

  it("returns 0 on empty input", () => {
    expect(energyRmsNormalized(new Uint8Array(0))).toBe(0);
  });
});

describe("acceptEnergy", () => {
  it("rejects silence with threshold 0.01", () => {
    const silence = pcm16Of(new Array(1024).fill(0));
    expect(acceptEnergy(silence, 0.01)).toBe(false);
  });

  it("accepts loud audio with threshold 0.03", () => {
    const loud = pcm16Of(new Array(1024).fill(20_000));
    expect(acceptEnergy(loud, 0.03)).toBe(true);
  });

  it("accepts anything when threshold is 0", () => {
    const silence = pcm16Of(new Array(1024).fill(0));
    expect(acceptEnergy(silence, 0)).toBe(true);
  });
});
```

- [ ] **Step A5.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/adapters/stt/energy-gate.test.ts
```

Expected: fails (module missing).

- [ ] **Step A5.3: Write `energy-gate.ts`**

```ts
const INT16_SCALE = 32768;

export function energyRmsNormalized(pcm: Uint8Array): number {
  if (pcm.byteLength < 2) return 0;
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = (samples[i] ?? 0) / INT16_SCALE;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

export function acceptEnergy(pcm: Uint8Array, thresholdRms: number): boolean {
  if (thresholdRms <= 0) return true;
  return energyRmsNormalized(pcm) >= thresholdRms;
}
```

- [ ] **Step A5.4: Run test to verify it passes**

```bash
bun run --cwd gateway test src/adapters/stt/energy-gate.test.ts
```

Expected: all pass.

- [ ] **Step A5.5: Commit**

```bash
git add gateway/src/adapters/stt/energy-gate.ts gateway/src/adapters/stt/energy-gate.test.ts
git commit -m "feat(gateway/adapters/stt): add normalized-RMS energy gate

Moves the client-side VAD pre-filter into the gateway. Pure functions:
energyRmsNormalized returns RMS in [0, 1]; acceptEnergy threshold-checks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A6: STT wire-message schemas

**Files:**
- Create: `gateway/src/adapters/stt/wire-messages.ts`
- Test: `gateway/src/adapters/stt/wire-messages.test.ts`

- [ ] **Step A6.1: Write `wire-messages.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  readySchema,
  sttServerMessageSchema,
  transcriptReadySchema,
  turnRejectedSchema,
  vadStartSchema,
} from "./wire-messages.ts";

describe("readySchema", () => {
  it("parses the contract example", () => {
    const result = readySchema.safeParse({
      type: "ready",
      connId: "1a6614dab748",
      sampleRate: 16000,
      sileroChunkSamples: 512,
      pcmFormat: "int16_le_mono",
      stt: "sense-voice-small-int8",
    });
    expect(result.success).toBe(true);
  });
});

describe("vadStartSchema", () => {
  it("parses with turnIdx", () => {
    expect(vadStartSchema.safeParse({ type: "vad_start", turnIdx: 7 }).success).toBe(true);
  });
});

describe("transcriptReadySchema", () => {
  it("parses the contract example", () => {
    const result = transcriptReadySchema.safeParse({
      type: "transcript_ready",
      turnIdx: 5,
      text: "Hi [pause.0] there",
      emotion: "<|NEUTRAL|>",
      event: "<|Speech|>",
      decodeMs: 720.4,
      audioSeconds: 7.8,
      pauses: [1240],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty pauses array", () => {
    const result = transcriptReadySchema.safeParse({
      type: "transcript_ready",
      turnIdx: 1,
      text: "hello",
      emotion: "<|NEUTRAL|>",
      event: "<|Speech|>",
      decodeMs: 100,
      audioSeconds: 1.0,
      pauses: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("turnRejectedSchema", () => {
  it("parses with reason", () => {
    const result = turnRejectedSchema.safeParse({
      type: "turn_rejected",
      turnIdx: 2,
      reason: "empty_transcript",
    });
    expect(result.success).toBe(true);
  });
});

describe("sttServerMessageSchema", () => {
  it("discriminates on type", () => {
    expect(
      sttServerMessageSchema.safeParse({ type: "vad_start", turnIdx: 1 }).success,
    ).toBe(true);
    expect(sttServerMessageSchema.safeParse({ type: "unknown_type" }).success).toBe(false);
  });
});
```

- [ ] **Step A6.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/adapters/stt/wire-messages.test.ts
```

Expected: fails (module missing).

- [ ] **Step A6.3: Write `wire-messages.ts`**

```ts
import { z } from "zod";

export const readySchema = z.object({
  type: z.literal("ready"),
  connId: z.string().optional(),
  sampleRate: z.number().optional(),
  sileroChunkSamples: z.number().optional(),
  pcmFormat: z.string().optional(),
  stt: z.string().optional(),
});

export const vadStartSchema = z.object({
  type: z.literal("vad_start"),
  turnIdx: z.number().int().min(1),
});

export const transcriptReadySchema = z.object({
  type: z.literal("transcript_ready"),
  turnIdx: z.number().int().min(1),
  text: z.string(),
  emotion: z.string().optional(),
  event: z.string().optional(),
  decodeMs: z.number().optional(),
  audioSeconds: z.number().optional(),
  pauses: z.array(z.number()).default([]),
});

export const turnRejectedSchema = z.object({
  type: z.literal("turn_rejected"),
  turnIdx: z.number().int().min(1),
  reason: z.string().optional(),
  text: z.string().optional(),
  audioEvent: z.string().optional(),
  decodeMs: z.number().optional(),
  audioSeconds: z.number().optional(),
});

export const sttServerMessageSchema = z.discriminatedUnion("type", [
  readySchema,
  vadStartSchema,
  transcriptReadySchema,
  turnRejectedSchema,
]);

export type SttServerMessage = z.infer<typeof sttServerMessageSchema>;
```

- [ ] **Step A6.4: Run test to verify it passes**

```bash
bun run --cwd gateway test src/adapters/stt/wire-messages.test.ts
```

Expected: all pass.

- [ ] **Step A6.5: Commit**

```bash
git add gateway/src/adapters/stt/wire-messages.ts gateway/src/adapters/stt/wire-messages.test.ts
git commit -m "feat(gateway/adapters/stt): add zod schemas for localSTT wire frames

Covers ready, vad_start, transcript_ready, turn_rejected. Unknown types
and non-consumed fields (vad_end, smart_turn_eval, turn_continuing,
turn_complete, warning, pong) are intentionally absent — the adapter
will parse with this schema and log+drop anything that fails.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A7: Token loader

**Files:**
- Create: `gateway/src/adapters/stt/token-loader.ts`
- Test: `gateway/src/adapters/stt/token-loader.test.ts`

- [ ] **Step A7.1: Write `token-loader.test.ts`**

```ts
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGatewayOutboundToken } from "./token-loader.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "token-loader-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTokensFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

describe("loadGatewayOutboundToken", () => {
  it("returns the token value when the slot is present", () => {
    const path = join(tmpDir, "tokens.yaml");
    writeTokensFile(
      path,
      [
        "tokens:",
        "  gateway-stt:",
        "    value: sak_abc123",
        "    createdAt: 2026-04-13T00:00:00Z",
        "    rotatedAt: null",
      ].join("\n"),
    );
    expect(loadGatewayOutboundToken(path, "gateway-stt")).toBe("sak_abc123");
  });

  it("throws when the file is missing", () => {
    expect(() => loadGatewayOutboundToken(join(tmpDir, "missing.yaml"), "gateway-stt"))
      .toThrow(/tokens file not found/i);
  });

  it("throws when the slot is missing", () => {
    const path = join(tmpDir, "tokens.yaml");
    writeTokensFile(path, "tokens: {}");
    expect(() => loadGatewayOutboundToken(path, "gateway-stt"))
      .toThrow(/gateway-stt.*not found/);
  });

  it("throws on malformed YAML", () => {
    const path = join(tmpDir, "tokens.yaml");
    writeTokensFile(path, ":: not yaml ::");
    expect(() => loadGatewayOutboundToken(path, "gateway-stt"))
      .toThrow();
  });
});
```

- [ ] **Step A7.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/adapters/stt/token-loader.test.ts
```

Expected: fails (module missing).

- [ ] **Step A7.3: Write `token-loader.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getLog } from "../../logging/logger.ts";

const log = getLog(["sentient", "auth", "token-loader"]);

const tokensFileSchema = z.object({
  tokens: z.record(
    z.string(),
    z.object({
      value: z.string().min(1),
      createdAt: z.string(),
      rotatedAt: z.string().nullable().optional(),
    }),
  ),
});

function tokenFingerprint(token: string): string {
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function loadGatewayOutboundToken(tokensFile: string, slot: "gateway-stt"): string {
  if (!existsSync(tokensFile)) {
    const msg = `tokens file not found at ${tokensFile}. Run \`sentient-auth init\` or ensure the host YAML is mounted read-only to this path.`;
    log.error("token-file-missing", { tokensFile });
    throw new Error(msg);
  }

  const raw = readFileSync(tokensFile, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`malformed tokens YAML at ${tokensFile}: ${reason}`);
  }

  const result = tokensFileSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new Error(`invalid tokens file shape at ${tokensFile}: ${result.error.message}`);
  }

  const entry = result.data.tokens[slot];
  if (!entry) {
    throw new Error(
      `token slot "${slot}" not found in ${tokensFile}. Run \`sentient-auth rotate ${slot}\` to create it.`,
    );
  }

  log.info("token-loaded", { slot, tokensFile, fingerprint: tokenFingerprint(entry.value) });
  return entry.value;
}
```

- [ ] **Step A7.4: Run test to verify it passes**

```bash
bun run --cwd gateway test src/adapters/stt/token-loader.test.ts
```

Expected: all pass.

- [ ] **Step A7.5: Commit**

```bash
git add gateway/src/adapters/stt/token-loader.ts gateway/src/adapters/stt/token-loader.test.ts
git commit -m "feat(gateway/adapters/stt): add outbound token loader

Reads the gateway's tokens.yaml (mounted at /app/tokens.yaml) and
returns the gateway-stt slot value. Throws with actionable error
messages on missing file, missing slot, or malformed YAML.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task A8: STT adapter public types

**Files:**
- Create: `gateway/src/adapters/stt/stt-adapter-types.ts`

- [ ] **Step A8.1: Write the types file**

```ts
export interface STTAdapterConfig {
  readonly url: string;
  readonly token: string;
  readonly language: "en" | "zh";
  readonly inputSampleRate: number;
  readonly energyThreshold: number;
  readonly connectTimeoutMs: number;
}

export type STTEvent =
  | { readonly type: "turn_started"; readonly turnIdx: number }
  | { readonly type: "transcript"; readonly turnIdx: number; readonly text: string }
  | { readonly type: "turn_dropped"; readonly turnIdx: number };

export interface STTAdapter {
  open(signal: AbortSignal): Promise<void>;
  send(pcm: Uint8Array): void;
  events(signal: AbortSignal): AsyncGenerator<STTEvent>;
  close(): Promise<void>;
  setEnergyThreshold(t: number): void;
}

export type STTAdapterFactory = (config: STTAdapterConfig) => STTAdapter;
```

- [ ] **Step A8.2: Typecheck to verify the file compiles**

```bash
bun run --cwd gateway typecheck
```

Expected: passes.

- [ ] **Step A8.3: Commit**

```bash
git add gateway/src/adapters/stt/stt-adapter-types.ts
git commit -m "feat(gateway/adapters/stt): define STTAdapter public interface

Four-method contract: open, send, events (AsyncGenerator<STTEvent>), close.
STTEvent union: turn_started | transcript | turn_dropped. setEnergyThreshold
hook reserved for future dynamic VAD tuning.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — STT Adapter implementation

### Task B1: Local STT adapter

**Files:**
- Create: `gateway/src/adapters/stt/local-stt-adapter.ts`
- Test: `gateway/src/adapters/stt/local-stt-adapter.test.ts`

This is the largest single unit. Implementation split into a discrete set of steps. TDD is partial — we write behavior tests first, then build the file to satisfy them.

- [ ] **Step B1.1: Write `local-stt-adapter.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { STTAdapter, STTAdapterConfig } from "./stt-adapter-types.ts";
import { createLocalSttAdapter } from "./local-stt-adapter.ts";

// ---------------------------------------------------------------------------
// FakeWebSocket — a minimal scriptable WebSocket for deterministic tests.
// ---------------------------------------------------------------------------

interface FakeWebSocket {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string | ArrayBuffer>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  // test helpers:
  _openHandshake(): void;
  _receiveText(msg: object): void;
  _receiveBinary(data: ArrayBuffer): void;
  _closeRemotely(code?: number): void;
  _url: string;
  _protocols: string[];
}

function makeFakeWebSocket(url: string, protocols: string[]): FakeWebSocket {
  const ws: FakeWebSocket = {
    readyState: 0, // CONNECTING
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(() => {
      ws.readyState = 3; // CLOSED
      ws.onclose?.({ code: 1000, reason: "", wasClean: true } as CloseEvent);
    }),
    _openHandshake() {
      ws.readyState = 1; // OPEN
      ws.onopen?.({} as Event);
    },
    _receiveText(msg) {
      ws.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent<string>);
    },
    _receiveBinary(data) {
      ws.onmessage?.({ data } as MessageEvent<ArrayBuffer>);
    },
    _closeRemotely(code = 1011) {
      ws.readyState = 3;
      ws.onclose?.({ code, reason: "", wasClean: false } as CloseEvent);
    },
    _url: url,
    _protocols: protocols,
  };
  return ws;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let currentWs: FakeWebSocket | null = null;
const OriginalWebSocket = globalThis.WebSocket;

function installFakeWebSocket(): void {
  currentWs = null;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = function (
    url: string | URL,
    protocols?: string | string[],
  ) {
    const ws = makeFakeWebSocket(
      String(url),
      Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
    );
    currentWs = ws;
    return ws as unknown as WebSocket;
  } as unknown as typeof WebSocket;
  (globalThis as unknown as { WebSocket: { OPEN: number } }).WebSocket.OPEN = 1;
}

function restoreWebSocket(): void {
  (globalThis as unknown as { WebSocket: typeof OriginalWebSocket }).WebSocket =
    OriginalWebSocket;
  currentWs = null;
}

const BASE_CONFIG: STTAdapterConfig = {
  url: "ws://fake-stt:8766",
  token: "sak_fake",
  language: "en",
  inputSampleRate: 48000,
  energyThreshold: 0.0, // 0 → always accept so resampling path is exercised
  connectTimeoutMs: 1000,
};

function pcm16Loud(nSamples: number): Uint8Array {
  const arr = new Int16Array(nSamples);
  arr.fill(20_000);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

beforeEach(() => {
  installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLocalSttAdapter — open()", () => {
  it("resolves after receiving {type:'ready'}", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const signal = new AbortController().signal;
    const openPromise = adapter.open(signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await expect(openPromise).resolves.toBeUndefined();
  });

  it("rejects on connectTimeoutMs expiry", async () => {
    vi.useFakeTimers();
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, connectTimeoutMs: 100 });
    const openPromise = adapter.open(new AbortController().signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(150);
    const err = await openPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timeout/i);
  });

  it("uses Authorization: Bearer header via sub-protocol fallback when env needs it", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    // Server-to-server callers can set Authorization header; Bun's WebSocket
    // does not expose that, so the adapter falls back to Sec-WebSocket-Protocol:
    // bearer, <token> (valid per CONTRACT §1.1).
    expect(currentWs?._protocols).toEqual(["bearer", "sak_fake"]);
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
  });
});

describe("createLocalSttAdapter — events()", () => {
  async function openedAdapter(): Promise<STTAdapter> {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    return adapter;
  }

  it("yields turn_started on vad_start", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({ type: "vad_start", turnIdx: 1 });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "turn_started", turnIdx: 1 });
    controller.abort();
  });

  it("yields transcript with rendered text on transcript_ready", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({
      type: "transcript_ready",
      turnIdx: 2,
      text: "hi [pause.0] there",
      pauses: [1200],
      emotion: "<|NEUTRAL|>",
      event: "<|Speech|>",
      decodeMs: 100,
      audioSeconds: 1.0,
    });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "transcript", turnIdx: 2, text: "hi [paused 1.2s] there" });
    controller.abort();
  });

  it("yields turn_dropped on turn_rejected", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    currentWs?._receiveText({ type: "turn_rejected", turnIdx: 3, reason: "empty_transcript" });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "turn_dropped", turnIdx: 3 });
    controller.abort();
  });

  it("skips unknown types, malformed JSON, and binary frames", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    // Noise:
    currentWs?._receiveText({ type: "vad_end", turnIdx: 1 });
    currentWs?._receiveText({ type: "smart_turn_eval", turnIdx: 1 });
    currentWs?._receiveBinary(new ArrayBuffer(16));
    // Signal:
    currentWs?._receiveText({ type: "vad_start", turnIdx: 1 });
    const { value } = await gen.next();
    expect(value).toEqual({ type: "turn_started", turnIdx: 1 });
    controller.abort();
  });

  it("terminates generator when signal aborts", async () => {
    const adapter = await openedAdapter();
    const controller = new AbortController();
    const gen = adapter.events(controller.signal);
    controller.abort();
    const result = await gen.next();
    expect(result.done).toBe(true);
  });
});

describe("createLocalSttAdapter — send()", () => {
  it("drops frames below the energy threshold", async () => {
    const adapter = createLocalSttAdapter({ ...BASE_CONFIG, energyThreshold: 0.01 });
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    const silence = new Uint8Array(new Int16Array(1024).buffer);
    adapter.send(silence);
    expect(currentWs?.send).not.toHaveBeenCalled();
  });

  it("forwards loud frames after downsample when threshold is 0", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    adapter.send(pcm16Loud(48)); // 48 samples @ 48k → ~16 samples @ 16k
    expect(currentWs?.send).toHaveBeenCalledTimes(1);
    const [sent] = currentWs?.send.mock.calls[0] ?? [];
    expect(sent).toBeInstanceOf(Uint8Array);
    expect((sent as Uint8Array).byteLength).toBe(32); // 16 Int16 samples = 32 bytes
  });
});

describe("createLocalSttAdapter — close()", () => {
  it("is idempotent", async () => {
    const adapter = createLocalSttAdapter(BASE_CONFIG);
    const openPromise = adapter.open(new AbortController().signal);
    await Promise.resolve();
    currentWs?._openHandshake();
    currentWs?._receiveText({ type: "ready" });
    await openPromise;
    await adapter.close();
    await adapter.close(); // must not throw
  });
});
```

- [ ] **Step B1.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/adapters/stt/local-stt-adapter.test.ts
```

Expected: fails (module missing).

- [ ] **Step B1.3: Write `local-stt-adapter.ts`**

```ts
import { getLog } from "../../logging/logger.ts";
import { acceptEnergy } from "./energy-gate.ts";
import { renderPauses } from "./pause-renderer.ts";
import { downsamplePcm16 } from "./pcm-resampler.ts";
import type { STTAdapter, STTAdapterConfig, STTEvent } from "./stt-adapter-types.ts";
import { sttServerMessageSchema } from "./wire-messages.ts";

const log = getLog(["sentient", "stt"]);

const STT_TARGET_SAMPLE_RATE = 16000;
const BEARER_SUBPROTOCOL = "bearer";

interface EventQueue {
  enqueue(event: STTEvent): void;
  waitForEvent(signal: AbortSignal): Promise<STTEvent | null>;
  close(): void;
}

function createEventQueue(): EventQueue {
  const pending: STTEvent[] = [];
  let waitResolve: ((event: STTEvent | null) => void) | null = null;
  let closed = false;

  return {
    enqueue(event) {
      if (closed) return;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r(event);
      } else {
        pending.push(event);
      }
    },
    waitForEvent(signal) {
      const next = pending.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed || signal.aborted) return Promise.resolve(null);
      return new Promise<STTEvent | null>((res) => {
        waitResolve = res;
        signal.addEventListener(
          "abort",
          () => {
            if (waitResolve === res) {
              waitResolve = null;
              res(null);
            }
          },
          { once: true },
        );
      });
    },
    close() {
      closed = true;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r(null);
      }
    },
  };
}

export function createLocalSttAdapter(config: STTAdapterConfig): STTAdapter {
  let ws: WebSocket | null = null;
  let currentThreshold = config.energyThreshold;
  let disposed = false;
  const queue = createEventQueue();

  function handleTextFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("malformed-json", { length: raw.length });
      return;
    }
    const result = sttServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      log.debug("unhandled-wire-type", {
        type: (parsed as { type?: unknown })?.type ?? "unknown",
      });
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case "ready":
        return; // consumed only during open()
      case "vad_start":
        log.info("turn-started", { turnIdx: msg.turnIdx });
        queue.enqueue({ type: "turn_started", turnIdx: msg.turnIdx });
        return;
      case "transcript_ready": {
        const rendered = renderPauses(msg.text, msg.pauses, config.language);
        log.info("transcript", { turnIdx: msg.turnIdx, length: rendered.length });
        queue.enqueue({ type: "transcript", turnIdx: msg.turnIdx, text: rendered });
        return;
      }
      case "turn_rejected":
        log.info("turn-dropped", { turnIdx: msg.turnIdx, reason: msg.reason ?? "unknown" });
        queue.enqueue({ type: "turn_dropped", turnIdx: msg.turnIdx });
        return;
    }
  }

  return {
    async open(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(config.url, [BEARER_SUBPROTOCOL, config.token]);
        socket.binaryType = "arraybuffer";
        ws = socket;

        const timeout = setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) {
            try {
              socket.close();
            } catch {
              /* ignore */
            }
            reject(new Error(`localSTT connect timeout after ${config.connectTimeoutMs}ms`));
          }
        }, config.connectTimeoutMs);

        const abortHandler = () => {
          clearTimeout(timeout);
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", abortHandler, { once: true });

        socket.onopen = () => {
          log.info("ws-opening", { url: config.url });
        };

        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            // During open(), peek for {type:'ready'}. After open() resolves,
            // the onmessage handler is swapped to handleTextFrame.
            try {
              const parsed = JSON.parse(event.data) as { type?: string };
              if (parsed.type === "ready") {
                clearTimeout(timeout);
                signal.removeEventListener("abort", abortHandler);
                log.info("ws-ready", { url: config.url });
                socket.onmessage = (e) => {
                  if (typeof e.data === "string") handleTextFrame(e.data);
                  // binary frames (WAV payloads) are discarded silently
                };
                resolve();
                return;
              }
            } catch {
              /* not our ready frame — ignore */
            }
          }
        };

        socket.onclose = () => {
          log.info("ws-closed", { url: config.url });
          queue.close();
        };

        socket.onerror = () => {
          log.error("ws-error", { url: config.url });
          clearTimeout(timeout);
          signal.removeEventListener("abort", abortHandler);
          reject(new Error("localSTT websocket error"));
        };
      });
    },

    send(pcm: Uint8Array): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!acceptEnergy(pcm, currentThreshold)) return;
      const downsampled = downsamplePcm16(pcm, config.inputSampleRate, STT_TARGET_SAMPLE_RATE);
      ws.send(downsampled);
    },

    async *events(signal: AbortSignal): AsyncGenerator<STTEvent> {
      while (true) {
        const next = await queue.waitForEvent(signal);
        if (next === null) return;
        yield next;
      }
    },

    async close(): Promise<void> {
      if (disposed) return;
      disposed = true;
      queue.close();
      if (ws) {
        try {
          ws.close(1000, "client-close");
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },

    setEnergyThreshold(t: number): void {
      currentThreshold = Math.max(0, Math.min(1, t));
    },
  };
}
```

- [ ] **Step B1.4: Run test to verify it passes**

```bash
bun run --cwd gateway test src/adapters/stt/local-stt-adapter.test.ts
```

Expected: all pass. If the "aborted" rejection from the signal leaks in unrelated tests, the fake fixture teardown clears it; double-check by running the whole test file together.

- [ ] **Step B1.5: Commit**

```bash
git add gateway/src/adapters/stt/local-stt-adapter.ts gateway/src/adapters/stt/local-stt-adapter.test.ts
git commit -m "feat(gateway/adapters/stt): implement local-stt WebSocket adapter

Four-method STTAdapter against capabilityServices/STTService CONTRACT.md.
Auth via Sec-WebSocket-Protocol: bearer, <token>. Translates vad_start,
transcript_ready (with pause rendering), and turn_rejected into STTEvent.
All other wire frames logged at DEBUG and dropped.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — System prompts + Bootstrap

### Task C1: System prompts directory

**Files:**
- Move: `gateway/system_prompt.md` → `gateway/system_prompts/system_prompt.md`
- Create: `gateway/system_prompts/language-prompt-en.md`
- Create: `gateway/system_prompts/language-prompt-zh.md`

- [ ] **Step C1.1: Move existing system_prompt.md into new folder**

```bash
cd /Users/kevinye/Development/sentient
mkdir -p gateway/system_prompts
git mv gateway/system_prompt.md gateway/system_prompts/system_prompt.md
```

- [ ] **Step C1.2: Create `gateway/system_prompts/language-prompt-en.md`**

```
The user's primary language is English. Always reply in English.
If a transcript contains short sounds that look like another language
(e.g. "嗯", "おう", "はい"), treat them as English backchannel/filler
("hmm", "uh", "okay") and respond in English. Do not switch language.
```

- [ ] **Step C1.3: Create `gateway/system_prompts/language-prompt-zh.md`**

```
用户的主要语言是中文，请始终用中文回复。
如果转录中出现可能被误识别成其他语言的短词（如 "uh", "hmm", "okay"），
请将其视为中文语气词或背景音，不要切换回复语言。
```

- [ ] **Step C1.4: Commit**

```bash
git add gateway/system_prompts/
git commit -m "feat(gateway): move system_prompt.md into system_prompts/ + add language hints

EN and ZH language hint files steer the LLM to stay in the configured
language even when SenseVoice misidentifies short utterances across
languages. Loaded together with the shared system prompt at boot.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: Rename + rewrite system-prompt-loader

**Files:**
- Rename: `gateway/src/context/persona-prompt-loader.ts` → `gateway/src/context/system-prompt-loader.ts`
- Rename: `gateway/src/context/persona-prompt-loader.test.ts` → `gateway/src/context/system-prompt-loader.test.ts`
- Update all imports: grep for `persona-prompt-loader` and fix.

- [ ] **Step C2.1: Rename files via git mv**

```bash
cd /Users/kevinye/Development/sentient
git mv gateway/src/context/persona-prompt-loader.ts gateway/src/context/system-prompt-loader.ts
git mv gateway/src/context/persona-prompt-loader.test.ts gateway/src/context/system-prompt-loader.test.ts
```

- [ ] **Step C2.2: Find all imports of the old module**

```bash
source scripts/env.sh
```

Run:

```bash
```

Use Grep tool (from the assistant toolbox, not Bash):

- Grep pattern: `persona-prompt-loader` in `gateway/src/`
- Grep pattern: `loadPersonaPrompt` in `gateway/src/`

Expected hits: `gateway/src/main.ts` (import) and the renamed loader file itself (function definition). Update the `main.ts` import to the new path + new function name in Step C2.4.

- [ ] **Step C2.3: Replace `gateway/src/context/system-prompt-loader.ts` with the new implementation**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "context", "system-prompt"]);

const GATEWAY_ROOT = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
const DEFAULT_PERSONA = "You are Sentient, a helpful family AI assistant.";

export interface LoadSystemPromptOptions {
  readonly language: "en" | "zh";
  readonly personaFile?: string;
  readonly runtimeDir?: string;
}

function tryRead(path: string, kind: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8").trim();
    log.info(`${kind}-loaded`, { path });
    return content;
  } catch {
    log.warn(`${kind}-missing`, { path });
    return undefined;
  }
}

export function loadSystemPrompt(opts: LoadSystemPromptOptions): string {
  const runtimeDir = opts.runtimeDir ?? GATEWAY_ROOT;
  const personaFile = opts.personaFile ?? "persona.md";
  const parts: string[] = [];

  const systemPrompt = tryRead(
    join(runtimeDir, "system_prompts", "system_prompt.md"),
    "system-prompt",
  );
  if (systemPrompt) parts.push(systemPrompt);

  const languagePrompt = tryRead(
    join(runtimeDir, "system_prompts", `language-prompt-${opts.language}.md`),
    "language-prompt",
  );
  if (languagePrompt) parts.push(languagePrompt);

  const persona = tryRead(join(runtimeDir, personaFile), "persona");
  parts.push(persona ?? DEFAULT_PERSONA);

  return parts.join("\n\n");
}
```

- [ ] **Step C2.4: Rewrite `gateway/src/context/system-prompt-loader.test.ts`**

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSystemPrompt } from "./system-prompt-loader.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sys-prompt-"));
  mkdirSync(join(tmpDir, "system_prompts"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSystemPrompt", () => {
  it("concatenates system_prompt + language + persona in order", () => {
    writeFileSync(join(tmpDir, "system_prompts", "system_prompt.md"), "ROOT");
    writeFileSync(join(tmpDir, "system_prompts", "language-prompt-en.md"), "EN");
    writeFileSync(join(tmpDir, "persona.md"), "PERSONA");
    const out = loadSystemPrompt({ language: "en", runtimeDir: tmpDir });
    expect(out).toBe("ROOT\n\nEN\n\nPERSONA");
  });

  it("skips missing system_prompt.md", () => {
    writeFileSync(join(tmpDir, "system_prompts", "language-prompt-en.md"), "EN");
    writeFileSync(join(tmpDir, "persona.md"), "PERSONA");
    expect(loadSystemPrompt({ language: "en", runtimeDir: tmpDir })).toBe("EN\n\nPERSONA");
  });

  it("skips missing language prompt", () => {
    writeFileSync(join(tmpDir, "system_prompts", "system_prompt.md"), "ROOT");
    writeFileSync(join(tmpDir, "persona.md"), "PERSONA");
    expect(loadSystemPrompt({ language: "en", runtimeDir: tmpDir })).toBe("ROOT\n\nPERSONA");
  });

  it("falls back to DEFAULT_PERSONA when persona file missing", () => {
    writeFileSync(join(tmpDir, "system_prompts", "system_prompt.md"), "ROOT");
    const out = loadSystemPrompt({ language: "en", runtimeDir: tmpDir });
    expect(out).toBe("ROOT\n\nYou are Sentient, a helpful family AI assistant.");
  });

  it("uses zh language prompt when configured", () => {
    writeFileSync(join(tmpDir, "system_prompts", "language-prompt-zh.md"), "ZH");
    writeFileSync(join(tmpDir, "persona.md"), "PERSONA");
    expect(loadSystemPrompt({ language: "zh", runtimeDir: tmpDir })).toBe("ZH\n\nPERSONA");
  });

  it("returns just DEFAULT_PERSONA when all three files missing", () => {
    expect(loadSystemPrompt({ language: "en", runtimeDir: tmpDir })).toBe(
      "You are Sentient, a helpful family AI assistant.",
    );
  });
});
```

- [ ] **Step C2.5: Run tests**

```bash
bun run --cwd gateway test src/context/system-prompt-loader.test.ts
```

Expected: all pass.

- [ ] **Step C2.6: Commit**

```bash
git add gateway/src/context/system-prompt-loader.ts gateway/src/context/system-prompt-loader.test.ts
git commit -m "refactor(gateway/context): rename loader + load language-hint prompt

persona-prompt-loader → system-prompt-loader. Adds loadSystemPrompt({
language, personaFile?, runtimeDir? }) that composes system_prompt.md
+ language-prompt-<lang>.md + persona.md (in order, blank-line joined).
main.ts wiring updated in a later task.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C3: LLM factory

**Files:**
- Create: `gateway/src/bootstrap/llm-factory.ts`
- Test: `gateway/src/bootstrap/llm-factory.test.ts`

- [ ] **Step C3.1: Write `llm-factory.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { StartupConfig } from "../config/startup-config.ts";
import { createLlmService } from "./llm-factory.ts";

function baseConfig(overrides: Partial<StartupConfig> = {}): StartupConfig {
  return {
    logging: { logLevel: undefined, logDir: "logs" },
    port: 8888,
    host: "0.0.0.0",
    maxSessions: 10,
    authTimeoutMs: 5000,
    sessionPersistMs: 120000,
    webDistDir: undefined,
    tls: {
      enabled: true,
      hostnames: ["localhost"],
      certsDir: "/tmp/certs",
    },
    session: {
      inactivity_timeout_ms: 300000,
      inactivity_check_interval_ms: 30000,
      barge_in: { no_interrupt_ms: 500, min_speech_duration_ms: 50 },
    },
    language: "en",
    stt: undefined,
    llm: undefined,
    tts: undefined,
    emotionTags: { enabled: true, model: "google/gemini-2.0-flash-lite-001" },
    ...overrides,
  } as StartupConfig;
}

describe("createLlmService", () => {
  it("returns null when llm config is absent", () => {
    expect(createLlmService(baseConfig())).toBeNull();
  });

  it("returns a provider when llm config is present", () => {
    const cfg = baseConfig({
      llm: {
        apiKey: "sk-test",
        provider: "openrouter",
        chat_model: "google/gemini-2.5-flash",
        tool_model: "anthropic/claude-3.5-sonnet",
        classifier_model: "google/gemini-flash-lite",
        max_tokens: 1024,
        timeout_ms: 30000,
        emotion_tags: { enabled: true, model: "google/gemini-2.0-flash-lite-001" },
      },
    });
    const svc = createLlmService(cfg);
    expect(svc).not.toBeNull();
    expect(typeof svc?.stream).toBe("function");
  });
});
```

- [ ] **Step C3.2: Run test to verify it fails**

```bash
bun run --cwd gateway test src/bootstrap/llm-factory.test.ts
```

Expected: fails (module missing; may also fail on StartupConfig shape — that gets fixed in Task C7 when we update startup-config.ts).

- [ ] **Step C3.3: Write `llm-factory.ts`**

```ts
import { getLog } from "../logging/logger.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import { createOpenRouterProvider } from "../providers/openrouter.ts";

const log = getLog(["sentient", "bootstrap", "llm"]);
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function createLlmService(cfg: StartupConfig): LLMProvider | null {
  if (!cfg.llm) {
    log.warn("service-disabled", { reason: "OPENROUTER_API_KEY not set" });
    return null;
  }
  log.info("service-enabled", { chatModel: cfg.llm.chat_model });
  return createOpenRouterProvider({
    apiKey: cfg.llm.apiKey,
    baseUrl: OPENROUTER_BASE_URL,
    siteName: "Sentient",
  });
}
```

- [ ] **Step C3.4: Commit (defer tests until Task C7 lands the matching StartupConfig shape)**

```bash
git add gateway/src/bootstrap/llm-factory.ts gateway/src/bootstrap/llm-factory.test.ts
git commit -m "feat(gateway/bootstrap): extract createLlmService from main.ts

Returns LLMProvider or null. Tests run green after StartupConfig is
updated in Task C7.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C4: STT factory

**Files:**
- Create: `gateway/src/bootstrap/stt-factory.ts`
- Test: `gateway/src/bootstrap/stt-factory.test.ts`

- [ ] **Step C4.1: Write `stt-factory.test.ts`**

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StartupConfig } from "../config/startup-config.ts";
import { createSttService } from "./stt-factory.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "stt-factory-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTokens(slot: string, value: string): string {
  const path = join(tmpDir, "tokens.yaml");
  writeFileSync(
    path,
    [
      "tokens:",
      `  ${slot}:`,
      `    value: ${value}`,
      "    createdAt: 2026-04-13T00:00:00Z",
      "    rotatedAt: null",
    ].join("\n"),
  );
  return path;
}

function baseConfig(overrides: Partial<StartupConfig> = {}): StartupConfig {
  return {
    logging: { logLevel: undefined, logDir: "logs" },
    port: 8888,
    host: "0.0.0.0",
    maxSessions: 10,
    authTimeoutMs: 5000,
    sessionPersistMs: 120000,
    webDistDir: undefined,
    tls: { enabled: false, hostnames: [], certsDir: "/tmp" },
    session: {
      inactivity_timeout_ms: 300000,
      inactivity_check_interval_ms: 30000,
      barge_in: { no_interrupt_ms: 500, min_speech_duration_ms: 50 },
    },
    language: "en",
    llm: undefined,
    tts: undefined,
    emotionTags: { enabled: false, model: "m" },
    stt: undefined,
    ...overrides,
  } as StartupConfig;
}

describe("createSttService", () => {
  it("builds adapterConfig from startup config + loaded token", () => {
    const tokensPath = writeTokens("gateway-stt", "sak_abc");
    const cfg = baseConfig({
      language: "en",
      stt: {
        provider: "local-stt",
        url: "ws://stt:8766",
        language: "en",
        input_sample_rate: 48000,
        energy_threshold: 0.03,
        connect_timeout_ms: 10000,
        tokens_file: tokensPath,
      },
    });
    const svc = createSttService(cfg);
    expect(svc.adapterConfig.url).toBe("ws://stt:8766");
    expect(svc.adapterConfig.token).toBe("sak_abc");
    expect(svc.adapterConfig.language).toBe("en");
    expect(svc.adapterConfig.inputSampleRate).toBe(48000);
    expect(svc.adapterConfig.energyThreshold).toBe(0.03);
    expect(typeof svc.adapterFactory).toBe("function");
  });
});
```

- [ ] **Step C4.2: Run test (will fail — implementation missing + StartupConfig shape pending)**

```bash
bun run --cwd gateway test src/bootstrap/stt-factory.test.ts
```

Expected: fails.

- [ ] **Step C4.3: Write `stt-factory.ts`**

```ts
import { getLog } from "../logging/logger.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { createLocalSttAdapter } from "../adapters/stt/local-stt-adapter.ts";
import type {
  STTAdapterConfig,
  STTAdapterFactory,
} from "../adapters/stt/stt-adapter-types.ts";
import { loadGatewayOutboundToken } from "../adapters/stt/token-loader.ts";

const log = getLog(["sentient", "bootstrap", "stt"]);

export interface SttService {
  readonly adapterFactory: STTAdapterFactory;
  readonly adapterConfig: STTAdapterConfig;
}

export function createSttService(cfg: StartupConfig): SttService {
  if (!cfg.stt) {
    throw new Error("createSttService called without stt config");
  }
  const token = loadGatewayOutboundToken(cfg.stt.tokens_file, "gateway-stt");
  const adapterConfig: STTAdapterConfig = {
    url: cfg.stt.url,
    token,
    language: cfg.language,
    inputSampleRate: cfg.stt.input_sample_rate,
    energyThreshold: cfg.stt.energy_threshold,
    connectTimeoutMs: cfg.stt.connect_timeout_ms,
  };
  log.info("service-enabled", {
    url: adapterConfig.url,
    language: adapterConfig.language,
    energyThreshold: adapterConfig.energyThreshold,
  });
  return { adapterFactory: createLocalSttAdapter, adapterConfig };
}
```

- [ ] **Step C4.4: Commit (tests green after C7)**

```bash
git add gateway/src/bootstrap/stt-factory.ts gateway/src/bootstrap/stt-factory.test.ts
git commit -m "feat(gateway/bootstrap): extract createSttService

Loads the gateway-stt token, builds STTAdapterConfig, returns the
per-session adapter factory. Tests run green after StartupConfig is
updated in Task C7.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C5: TTS factory

**Files:**
- Create: `gateway/src/bootstrap/tts-factory.ts`
- Test: `gateway/src/bootstrap/tts-factory.test.ts`

- [ ] **Step C5.1: Write `tts-factory.ts`**

This absorbs the inline IIFE from the current `main.ts` (lines 66-80). The connection + turn factory are tightly coupled via an `activeTurn` closure variable; keep that coupling inside the factory rather than letting it leak to consumers.

```ts
import { getLog } from "../logging/logger.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { createTTSProcessor } from "../pipeline/processors/tts-processor.ts";
import type { TTSProcessorFactory } from "../pipeline/processors/tts-processor.ts";
import { createFishAudioConnection } from "../providers/tts/fish-audio-connection.ts";
import { createFishAudioTurn } from "../providers/tts/fish-audio-provider.ts";
import type { TTSConnectionManager } from "../providers/tts/tts-connection.ts";
import type { TTSConfig } from "../providers/tts/tts-types.ts";

const log = getLog(["sentient", "bootstrap", "tts"]);

export interface TtsService {
  readonly connectionManager: TTSConnectionManager;
  readonly processorFactory: TTSProcessorFactory;
}

export function createTtsService(cfg: StartupConfig): TtsService | null {
  if (!cfg.tts) {
    log.warn("service-disabled", {
      reason: "FISH_AUDIO_API_KEY or tts.voice_id not set",
    });
    return null;
  }

  const ttsConfig: TTSConfig = {
    apiKey: cfg.tts.apiKey,
    voiceId: cfg.tts.voice_id,
    modelId: cfg.tts.model_id,
    format: cfg.tts.format,
    bitrate: cfg.tts.bitrate,
    sampleRate: cfg.tts.sample_rate,
    latency: cfg.tts.latency,
    chunkLengthMs: cfg.tts.chunk_length_ms,
    connectTimeoutMs: cfg.tts.connect_timeout_ms,
  };

  let activeTurn: ReturnType<typeof createFishAudioTurn> | null = null;
  const connection = createFishAudioConnection(ttsConfig, (event) => {
    activeTurn?.handleEvent(event);
  });

  const processorFactory: TTSProcessorFactory = async () => {
    activeTurn = null;
    await connection.resetSession();
    const turn = createFishAudioTurn((data) => connection.send(data), ttsConfig);
    activeTurn = turn;
    return createTTSProcessor(turn);
  };

  log.info("service-enabled", { voiceId: ttsConfig.voiceId, modelId: ttsConfig.modelId });
  return { connectionManager: connection, processorFactory };
}
```

- [ ] **Step C5.2: Write `tts-factory.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { StartupConfig } from "../config/startup-config.ts";
import { createTtsService } from "./tts-factory.ts";

function baseConfig(overrides: Partial<StartupConfig> = {}): StartupConfig {
  return {
    logging: { logLevel: undefined, logDir: "logs" },
    port: 8888,
    host: "0.0.0.0",
    maxSessions: 10,
    authTimeoutMs: 5000,
    sessionPersistMs: 120000,
    webDistDir: undefined,
    tls: { enabled: false, hostnames: [], certsDir: "/tmp" },
    session: {
      inactivity_timeout_ms: 300000,
      inactivity_check_interval_ms: 30000,
      barge_in: { no_interrupt_ms: 500, min_speech_duration_ms: 50 },
    },
    language: "en",
    llm: undefined,
    stt: undefined,
    tts: undefined,
    emotionTags: { enabled: false, model: "m" },
    ...overrides,
  } as StartupConfig;
}

describe("createTtsService", () => {
  it("returns null when tts config is absent", () => {
    expect(createTtsService(baseConfig())).toBeNull();
  });

  it("returns connectionManager + processorFactory when tts config is present", () => {
    const cfg = baseConfig({
      tts: {
        apiKey: "fa-test",
        provider: "fish-audio",
        voice_id: "test-voice",
        model_id: "s2",
        format: "pcm",
        bitrate: 48000,
        sample_rate: 44100,
        latency: "balanced",
        chunk_length_ms: 200,
        connect_timeout_ms: 10000,
        stop_timeout_ms: 10000,
        idle_timeout_ms: 10000,
      },
    });
    const svc = createTtsService(cfg);
    expect(svc).not.toBeNull();
    expect(typeof svc?.connectionManager.connect).toBe("function");
    expect(typeof svc?.processorFactory).toBe("function");
  });
});
```

- [ ] **Step C5.3: Commit**

```bash
git add gateway/src/bootstrap/tts-factory.ts gateway/src/bootstrap/tts-factory.test.ts
git commit -m "feat(gateway/bootstrap): extract createTtsService

Moves the inline IIFE from main.ts into a named factory. Encapsulates
the connection ↔ turn coupling via a local activeTurn closure. Returns
null when TTS is not configured.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C6: Context factory

**Files:**
- Create: `gateway/src/bootstrap/context-factory.ts`
- Test: `gateway/src/bootstrap/context-factory.test.ts`

- [ ] **Step C6.1: Write `context-factory.ts`**

```ts
import { getLog } from "../logging/logger.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import type { ContextAssembler } from "../context/context-assembler.ts";
import { createContextAssembler } from "../context/context-assembler.ts";
import { loadSystemPrompt } from "../context/system-prompt-loader.ts";
import { loadEmotionTagSet } from "../pipeline/processors/emotion-tag-set.ts";
import type { EmotionTagOptions } from "../pipeline/voice-turn.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";

const log = getLog(["sentient", "bootstrap", "context"]);

export interface ContextServices {
  readonly contextAssembler: ContextAssembler;
  readonly emotionTagOptions: EmotionTagOptions | undefined;
}

export function createContextServices(
  cfg: StartupConfig,
  llmProvider: LLMProvider | null,
): ContextServices {
  const systemPrompt = loadSystemPrompt({ language: cfg.language });
  const contextAssembler = createContextAssembler(systemPrompt);

  let emotionTagOptions: EmotionTagOptions | undefined;
  if (cfg.emotionTags.enabled && llmProvider) {
    emotionTagOptions = {
      llmProvider,
      model: cfg.emotionTags.model,
      tagSet: loadEmotionTagSet("fish-audio", cfg.language === "zh" ? "zh" : "en"),
    };
    log.info("emotion-tags-enabled", { model: cfg.emotionTags.model });
  } else {
    log.info("emotion-tags-disabled", {
      reason: cfg.emotionTags.enabled ? "no LLM provider" : "config disabled",
    });
  }

  return { contextAssembler, emotionTagOptions };
}
```

- [ ] **Step C6.2: Write `context-factory.test.ts`**

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupConfig } from "../config/startup-config.ts";
import { createContextServices } from "./context-factory.ts";

let tmpDir: string;
let originalRuntimeDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "context-factory-"));
  mkdirSync(join(tmpDir, "system_prompts"));
  writeFileSync(join(tmpDir, "system_prompts", "system_prompt.md"), "SYSTEM");
  writeFileSync(join(tmpDir, "system_prompts", "language-prompt-en.md"), "EN");
  writeFileSync(join(tmpDir, "persona.md"), "PERSONA");
  originalRuntimeDir = process.env.GATEWAY_RUNTIME_DIR;
  process.env.GATEWAY_RUNTIME_DIR = tmpDir;
});

afterEach(() => {
  process.env.GATEWAY_RUNTIME_DIR = originalRuntimeDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<StartupConfig> = {}): StartupConfig {
  return {
    logging: { logLevel: undefined, logDir: "logs" },
    port: 8888,
    host: "0.0.0.0",
    maxSessions: 10,
    authTimeoutMs: 5000,
    sessionPersistMs: 120000,
    webDistDir: undefined,
    tls: { enabled: false, hostnames: [], certsDir: "/tmp" },
    session: {
      inactivity_timeout_ms: 300000,
      inactivity_check_interval_ms: 30000,
      barge_in: { no_interrupt_ms: 500, min_speech_duration_ms: 50 },
    },
    language: "en",
    llm: undefined,
    stt: undefined,
    tts: undefined,
    emotionTags: { enabled: false, model: "m" },
    ...overrides,
  } as StartupConfig;
}

describe("createContextServices", () => {
  it("returns context assembler with composed system prompt", () => {
    const ctx = createContextServices(baseConfig(), null);
    expect(typeof ctx.contextAssembler.buildMessages).toBe("function");
  });

  it("disables emotion tags when llmProvider is null", () => {
    const ctx = createContextServices(baseConfig({ emotionTags: { enabled: true, model: "m" } }), null);
    expect(ctx.emotionTagOptions).toBeUndefined();
  });

  it("enables emotion tags when llmProvider is present and flag is true", () => {
    const fakeLlm = { stream: vi.fn() } as unknown as Parameters<typeof createContextServices>[1];
    const ctx = createContextServices(
      baseConfig({ emotionTags: { enabled: true, model: "m" } }),
      fakeLlm,
    );
    expect(ctx.emotionTagOptions).toBeDefined();
    expect(ctx.emotionTagOptions?.model).toBe("m");
  });
});
```

- [ ] **Step C6.3: Commit**

```bash
git add gateway/src/bootstrap/context-factory.ts gateway/src/bootstrap/context-factory.test.ts
git commit -m "feat(gateway/bootstrap): extract createContextServices

Loads system prompt (with language hint), builds ContextAssembler,
composes EmotionTagOptions when enabled+LLM available.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C7: Update StartupConfig for the new shape

**Files:**
- Modify: `gateway/src/config/startup-config.ts`

This is the switch-over moment. After this commit, the old Nova-3 + Deepgram stt types are gone from StartupConfig. The factory tests from C3–C6 will compile.

- [ ] **Step C7.1: Rewrite `gateway/src/config/startup-config.ts`**

```ts
import { join } from "node:path";
import type {
  EmotionTagsConfig,
  LLMConfig as LLMYaml,
  STTConfig as STTYaml,
  SessionConfig as SessionYaml,
  TTSConfig as TTSYaml,
  TlsConfig as TlsYaml,
} from "@sentient/config";
import { getLog } from "../logging/logger.ts";
import { loadGatewayConfig } from "./gateway-config.ts";

export interface LoggingConfig {
  logLevel: string | undefined;
  logDir: string;
}

export interface StartupConfig {
  logging: LoggingConfig;

  port: number;
  host: string;
  maxSessions: number;
  authTimeoutMs: number;
  sessionPersistMs: number;

  webDistDir: string | undefined;

  tls: TlsYaml & { certsDir: string };

  session: SessionYaml;

  /** Top-level language ("en" | "zh") mirrored from stt.language for ergonomics. */
  language: "en" | "zh";

  /** `undefined` when no stt block — voice STT disabled. Always defined in
   *  current config.yaml schema (stt is required), but kept optional for
   *  forward compatibility. */
  stt: STTYaml | undefined;

  /** `undefined` when OPENROUTER_API_KEY is missing. */
  llm: (LLMYaml & { apiKey: string }) | undefined;

  /** `undefined` when FISH_AUDIO_API_KEY missing OR voice_id unset ("default"). */
  tts: (TTSYaml & { apiKey: string }) | undefined;

  emotionTags: EmotionTagsConfig;
}

export function loadLoggingConfig(): LoggingConfig {
  return {
    logLevel: process.env.LOG_LEVEL,
    logDir: process.env.LOG_DIR ?? "logs",
  };
}

const TTS_VOICE_ID_UNSET = "default";

export function loadStartupConfig(): StartupConfig {
  const log = getLog(["sentient", "config"]);

  const gatewayRoot = join(import.meta.dir, "..", "..");
  const configPath = process.env.GATEWAY_CONFIG_PATH ?? join(gatewayRoot, "config.yaml");

  const cfg = loadGatewayConfig(configPath);
  log.info("config-loaded", { path: configPath });

  const openrouterApiKey = process.env.OPENROUTER_API_KEY ?? "";
  const fishAudioApiKey = process.env.FISH_AUDIO_API_KEY ?? "";

  return {
    logging: loadLoggingConfig(),

    port: cfg.port,
    host: cfg.host,
    maxSessions: cfg.max_sessions,
    authTimeoutMs: cfg.auth_timeout_ms,
    sessionPersistMs: cfg.session_persist_ms,

    webDistDir: process.env.WEB_DIST_DIR,

    tls: { ...cfg.tls, certsDir: process.env.GATEWAY_CERTS_DIR ?? join(gatewayRoot, "certs") },

    session: cfg.session,

    language: cfg.stt.language,

    stt: cfg.stt,

    llm: openrouterApiKey ? { ...cfg.llm, apiKey: openrouterApiKey } : undefined,

    tts:
      fishAudioApiKey && cfg.tts.voice_id !== TTS_VOICE_ID_UNSET
        ? { ...cfg.tts, apiKey: fishAudioApiKey }
        : undefined,

    emotionTags: cfg.llm.emotion_tags,
  };
}
```

- [ ] **Step C7.2: Run the bootstrap factory tests + gateway typecheck**

```bash
bun run --cwd gateway typecheck
bun run --cwd gateway test src/bootstrap/
```

Expected: typecheck passes; factory tests pass.

- [ ] **Step C7.3: Commit**

```bash
git add gateway/src/config/startup-config.ts
git commit -m "refactor(gateway/config): drop Nova-3, swap Deepgram stt for local-stt

Removes deepgramApiKey and sttNova3 fields from StartupConfig. Adds
top-level language mirrored from stt.language for factory ergonomics.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task C8: Services composer

**Files:**
- Create: `gateway/src/bootstrap/create-gateway-services.ts`
- Test: `gateway/src/bootstrap/create-gateway-services.test.ts`

- [ ] **Step C8.1: Write `create-gateway-services.ts`**

```ts
import { ensureTlsMaterial } from "@sentient/tls";
import { createSessionManager } from "../auth/session-manager.ts";
import type { SessionManager } from "../auth/session-manager.ts";
import { getLog } from "../logging/logger.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import type { ContextServices } from "./context-factory.ts";
import { createContextServices } from "./context-factory.ts";
import { createLlmService } from "./llm-factory.ts";
import type { SttService } from "./stt-factory.ts";
import { createSttService } from "./stt-factory.ts";
import type { TtsService } from "./tts-factory.ts";
import { createTtsService } from "./tts-factory.ts";

const log = getLog(["sentient", "bootstrap"]);
const DEFAULT_CHAT_MODEL = "google/gemini-2.5-flash";

export interface GatewayServices {
  readonly sessionManager: SessionManager;
  readonly context: ContextServices;
  readonly llmProvider: LLMProvider | null;
  readonly stt: SttService | null;
  readonly tts: TtsService | null;
  readonly chatModel: string;
  readonly language: "en" | "zh";
  readonly tls: GatewayTlsMaterial | undefined;
  readonly webDistDir: string | undefined;
}

export function createGatewayServices(cfg: StartupConfig): GatewayServices {
  const sessionManager = createSessionManager({ maxSessions: cfg.maxSessions });
  const llmProvider = createLlmService(cfg);
  const context = createContextServices(cfg, llmProvider);
  const stt = cfg.stt ? createSttService(cfg) : null;
  const tts = createTtsService(cfg);
  const tls = cfg.tls.enabled
    ? ensureTlsMaterial({ hostnames: cfg.tls.hostnames, certsDir: cfg.tls.certsDir, logTag: "gateway" })
    : undefined;

  log.info("services-composed", {
    llm: llmProvider !== null,
    stt: stt !== null,
    tts: tts !== null,
    tls: tls !== undefined,
    language: cfg.language,
  });

  return {
    sessionManager,
    context,
    llmProvider,
    stt,
    tts,
    chatModel: cfg.llm?.chat_model ?? DEFAULT_CHAT_MODEL,
    language: cfg.language,
    tls,
    webDistDir: cfg.webDistDir,
  };
}
```

- [ ] **Step C8.2: Write a composition smoke test**

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StartupConfig } from "../config/startup-config.ts";
import { createGatewayServices } from "./create-gateway-services.ts";

let tmpDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gws-"));
  mkdirSync(join(tmpDir, "system_prompts"));
  writeFileSync(join(tmpDir, "system_prompts", "system_prompt.md"), "sp");
  writeFileSync(join(tmpDir, "system_prompts", "language-prompt-en.md"), "en");
  writeFileSync(join(tmpDir, "persona.md"), "p");
  writeFileSync(
    join(tmpDir, "tokens.yaml"),
    "tokens:\n  gateway-stt:\n    value: sak_x\n    createdAt: 2026-04-13T00:00:00Z\n    rotatedAt: null\n",
  );
  origEnv = process.env.GATEWAY_RUNTIME_DIR;
  process.env.GATEWAY_RUNTIME_DIR = tmpDir;
});

afterEach(() => {
  process.env.GATEWAY_RUNTIME_DIR = origEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function cfg(overrides: Partial<StartupConfig> = {}): StartupConfig {
  return {
    logging: { logLevel: undefined, logDir: "logs" },
    port: 8888,
    host: "0.0.0.0",
    maxSessions: 10,
    authTimeoutMs: 5000,
    sessionPersistMs: 120000,
    webDistDir: undefined,
    tls: { enabled: false, hostnames: [], certsDir: "/tmp" },
    session: {
      inactivity_timeout_ms: 300000,
      inactivity_check_interval_ms: 30000,
      barge_in: { no_interrupt_ms: 500, min_speech_duration_ms: 50 },
    },
    language: "en",
    llm: undefined,
    stt: {
      provider: "local-stt",
      url: "ws://stt:8766",
      language: "en",
      input_sample_rate: 48000,
      energy_threshold: 0.03,
      connect_timeout_ms: 10000,
      tokens_file: join(tmpDir, "tokens.yaml"),
    },
    tts: undefined,
    emotionTags: { enabled: false, model: "m" },
    ...overrides,
  } as StartupConfig;
}

describe("createGatewayServices", () => {
  it("composes all services from config", () => {
    const services = createGatewayServices(cfg());
    expect(services.sessionManager).toBeDefined();
    expect(services.context.contextAssembler).toBeDefined();
    expect(services.llmProvider).toBeNull();
    expect(services.stt).not.toBeNull();
    expect(services.tts).toBeNull();
    expect(services.chatModel).toBe("google/gemini-2.5-flash");
    expect(services.language).toBe("en");
  });
});
```

- [ ] **Step C8.3: Run tests**

```bash
bun run --cwd gateway test src/bootstrap/
```

Expected: all pass.

- [ ] **Step C8.4: Commit**

```bash
git add gateway/src/bootstrap/create-gateway-services.ts gateway/src/bootstrap/create-gateway-services.test.ts
git commit -m "feat(gateway/bootstrap): compose GatewayServices from StartupConfig

One-stop factory used by main.ts. Returns an immutable container of
sessionManager, context, llmProvider, stt, tts, chatModel, language,
tls, webDistDir.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Pipeline rewrite

### Task D1: Strip draft methods from SessionHistory

**Files:**
- Modify: `gateway/src/context/session-history.ts`
- Modify: `gateway/src/context/session-history.test.ts`

- [ ] **Step D1.1: Replace `gateway/src/context/session-history.ts` with the simplified version**

```ts
import { getLog } from "../logging/logger.ts";
import type { ConversationTurn } from "./context-assembler.ts";

const log = getLog(["sentient", "session", "history"]);

export interface HistoryEntry {
  readonly id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
}

export interface SessionHistory {
  /** Read the conversation; adjacent same-role entries merge into one message. */
  messages(): readonly ConversationTurn[];
  /** Append a finalized segment. Empty/whitespace text is ignored. */
  append(role: "user" | "assistant", text: string): void;
  /** Read-only snapshot of all entries. */
  entries(): readonly HistoryEntry[];
  /** Clear all history. */
  clear(): void;
}

export function createSessionHistory(): SessionHistory {
  const store: HistoryEntry[] = [];
  let nextId = 1;

  return {
    messages(): readonly ConversationTurn[] {
      if (store.length === 0) return [];
      const merged: ConversationTurn[] = [];
      const first = store[0];
      if (!first) return [];
      let current = { role: first.role, parts: [first.text] };
      for (let i = 1; i < store.length; i++) {
        const entry = store[i];
        if (!entry) continue;
        if (entry.role === current.role) {
          current.parts.push(entry.text);
        } else {
          merged.push({ role: current.role, content: current.parts.join(" ") });
          current = { role: entry.role, parts: [entry.text] };
        }
      }
      merged.push({ role: current.role, content: current.parts.join(" ") });
      return merged;
    },

    append(role: "user" | "assistant", text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = Date.now();
      log.debug("append", { role, length: trimmed.length });
      store.push({ id: nextId++, role, text: trimmed, createdAt: now });
    },

    entries(): readonly HistoryEntry[] {
      return [...store];
    },

    clear(): void {
      store.length = 0;
    },
  };
}
```

- [ ] **Step D1.2: Update `gateway/src/context/session-history.test.ts`**

Delete every test block that calls `setDraft`, `clearDraft`, `amendPendingUser`, `finalizePendingUser`, `pendingUserText`, or `hasPendingUserSpeech`. Keep tests for `append()`, `messages()`, `entries()`, `clear()` — update any signature changes (e.g., entries no longer have `state` / `confidence` / `updatedAt`).

Typical surviving structure:

```ts
import { describe, expect, it } from "vitest";
import { createSessionHistory } from "./session-history.ts";

describe("SessionHistory.append", () => {
  it("ignores empty text", () => {
    const h = createSessionHistory();
    h.append("user", "   ");
    expect(h.messages()).toEqual([]);
  });

  it("stores trimmed text", () => {
    const h = createSessionHistory();
    h.append("user", "  hello  ");
    expect(h.messages()).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("SessionHistory.messages", () => {
  it("merges adjacent same-role entries", () => {
    const h = createSessionHistory();
    h.append("user", "hello");
    h.append("user", "world");
    expect(h.messages()).toEqual([{ role: "user", content: "hello world" }]);
  });

  it("alternates when roles differ", () => {
    const h = createSessionHistory();
    h.append("user", "hi");
    h.append("assistant", "hello there");
    h.append("user", "how are you");
    expect(h.messages()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
      { role: "user", content: "how are you" },
    ]);
  });
});

describe("SessionHistory.clear", () => {
  it("removes all entries", () => {
    const h = createSessionHistory();
    h.append("user", "hi");
    h.clear();
    expect(h.messages()).toEqual([]);
    expect(h.entries()).toEqual([]);
  });
});
```

- [ ] **Step D1.3: Run tests + typecheck**

```bash
bun run --cwd gateway typecheck
bun run --cwd gateway test src/context/session-history.test.ts
```

Expected: typecheck may report errors in consumers that still call the removed draft methods (continuous-session.ts). That's fine — those will be fixed in D2. Tests in this file must pass.

- [ ] **Step D1.4: Commit**

```bash
git add gateway/src/context/session-history.ts gateway/src/context/session-history.test.ts
git commit -m "refactor(gateway/context): strip draft/pending methods from SessionHistory

append + messages + entries + clear only. All draft/partial-transcript
logic existed for Deepgram streaming partials and is unreachable after
the STT swap.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task D2: Rewrite ContinuousSession

**Files:**
- Rewrite: `gateway/src/pipeline/continuous-session.ts`
- Rewrite: `gateway/src/pipeline/continuous-session.test.ts`
- Delete: `gateway/src/pipeline/__tests__/continuous-session.integration.test.ts` (it asserts against the old emitter + Deepgram event types; a replacement is out of scope — the rewritten unit test covers the same paths)

- [ ] **Step D2.1: Delete the integration test (covered by rewritten unit test)**

```bash
git rm gateway/src/pipeline/__tests__/continuous-session.integration.test.ts
```

- [ ] **Step D2.2: Replace `gateway/src/pipeline/continuous-session.ts`**

```ts
import type { ContextAssembler } from "../context/context-assembler.ts";
import type { SessionHistory } from "../context/session-history.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-provider.ts";
import type {
  STTAdapter,
  STTAdapterConfig,
  STTAdapterFactory,
  STTEvent,
} from "../adapters/stt/stt-adapter-types.ts";
import type { TTSConnectionManager } from "../providers/tts/tts-connection.ts";
import type { TTSProcessorFactory } from "./processors/tts-processor.ts";
import { type TurnController, createTurnController } from "./turn-controller.ts";
import type { TurnSink } from "./turn-sink.ts";
import { createTurnTransition } from "./turn-transition.ts";
import type { EmotionTagOptions } from "./voice-turn.ts";

const log = getLog(["sentient", "session"]);

export interface ContinuousSessionOptions {
  sttAdapterFactory: STTAdapterFactory;
  sttAdapterConfig: STTAdapterConfig;
  ttsConnectionManager: TTSConnectionManager;
  history: SessionHistory;
  sink: TurnSink;
  contextAssembler: ContextAssembler;
  llmProvider: LLMProvider;
  ttsProcessorFactory: TTSProcessorFactory;
  chatModel: string;
  language: "en" | "zh";
  emotionTags?: EmotionTagOptions;
}

export interface ContinuousSession {
  start(): Promise<void>;
  sendAudio(audio: Uint8Array): void;
  close(): Promise<void>;
  isConnected(): boolean;
}

export function createContinuousSession(options: ContinuousSessionOptions): ContinuousSession {
  const {
    sttAdapterFactory,
    sttAdapterConfig,
    ttsConnectionManager,
    history,
    sink,
    contextAssembler,
    llmProvider,
    ttsProcessorFactory,
    chatModel,
    language,
    emotionTags,
  } = options;

  const controller = new AbortController();
  const turnTransition = createTurnTransition();
  let adapter: STTAdapter | null = null;
  let activeTurn: TurnController | null = null;
  let isClosed = false;
  let eventLoopPromise: Promise<void> | null = null;
  let connected = false;

  function startTurn(transcript: string): void {
    if (activeTurn) {
      log.warn("start-turn-while-active", { transcript });
      activeTurn.abort();
    }
    log.info("start-turn", { transcript });
    const turn = createTurnController({
      transcript,
      history,
      sink,
      contextAssembler,
      llmProvider,
      ttsProcessorFactory,
      chatModel,
      language,
      ...(emotionTags ? { emotionTags } : {}),
    });
    activeTurn = turn;
    turn
      .run()
      .catch((err: unknown) => {
        log.error("turn-run-rejected", {
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (activeTurn === turn) activeTurn = null;
      });
  }

  async function executeBargeIn(): Promise<void> {
    const turn = activeTurn;
    if (!turn) return;
    activeTurn = null;
    log.info("barge-in-execute");
    await turnTransition.execute({ turn, ttsConnectionManager, sink });
  }

  function handleEvent(event: STTEvent): void {
    switch (event.type) {
      case "turn_started":
        if (activeTurn?.isAssistantSpeaking()) {
          executeBargeIn().catch((err: unknown) => {
            log.error("barge-in-failed", {
              message: err instanceof Error ? err.message : String(err),
            });
          });
        }
        sink.sendJson({ type: "turn.started", turnIdx: event.turnIdx });
        return;
      case "transcript":
        sink.sendJson({ type: "transcript.final", turnIdx: event.turnIdx, text: event.text });
        history.append("user", event.text);
        startTurn(event.text);
        return;
      case "turn_dropped":
        log.info("turn-dropped-forwarded", { turnIdx: event.turnIdx });
        sink.sendJson({ type: "turn.dropped", turnIdx: event.turnIdx });
        return;
    }
  }

  async function runEventLoop(): Promise<void> {
    if (!adapter) return;
    try {
      for await (const event of adapter.events(controller.signal)) {
        if (controller.signal.aborted || isClosed) break;
        handleEvent(event);
      }
    } catch (err: unknown) {
      if (!isClosed) {
        log.error("stt-event-loop-failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (isClosed) return;
      if (adapter) return;
      log.info("session-start");
      adapter = sttAdapterFactory(sttAdapterConfig);
      await Promise.all([ttsConnectionManager.connect(), adapter.open(controller.signal)]);
      connected = true;
      log.info("session-ready");
      eventLoopPromise = runEventLoop();
    },

    sendAudio(audio: Uint8Array): void {
      if (!connected || isClosed) return;
      adapter?.send(audio);
    },

    async close(): Promise<void> {
      if (isClosed) return;
      isClosed = true;
      log.info("session-close");
      controller.abort();
      activeTurn?.abort();
      activeTurn = null;
      await Promise.allSettled([
        adapter?.close() ?? Promise.resolve(),
        ttsConnectionManager.close(),
        eventLoopPromise ?? Promise.resolve(),
      ]);
      adapter = null;
      connected = false;
    },

    isConnected: () => connected && !isClosed,
  };
}
```

- [ ] **Step D2.3: Replace `gateway/src/pipeline/continuous-session.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  STTAdapter,
  STTAdapterConfig,
  STTEvent,
} from "../adapters/stt/stt-adapter-types.ts";
import { createSessionHistory } from "../context/session-history.ts";
import { createContinuousSession } from "./continuous-session.ts";
import type { TurnSink } from "./turn-sink.ts";

// ---------------------------------------------------------------------------
// FakeSttAdapter — scriptable event source
// ---------------------------------------------------------------------------

interface FakeSttAdapter extends STTAdapter {
  _emit(event: STTEvent): void;
  _endStream(): void;
}

function createFakeSttAdapter(): FakeSttAdapter {
  const queue: STTEvent[] = [];
  let waiter: ((v: IteratorResult<STTEvent>) => void) | null = null;
  let done = false;
  let opened = false;
  const closeFn = vi.fn(async () => {
    done = true;
    waiter?.({ value: undefined as unknown as STTEvent, done: true });
    waiter = null;
  });
  return {
    async open() {
      opened = true;
    },
    send: vi.fn(),
    async *events() {
      while (!done) {
        if (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
          continue;
        }
        await new Promise<IteratorResult<STTEvent>>((res) => {
          waiter = res;
        });
      }
    },
    close: closeFn,
    setEnergyThreshold: vi.fn(),
    _emit(event) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    _endStream() {
      done = true;
      waiter?.({ value: undefined as unknown as STTEvent, done: true });
      waiter = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_ADAPTER_CONFIG: STTAdapterConfig = {
  url: "ws://fake",
  token: "x",
  language: "en",
  inputSampleRate: 48000,
  energyThreshold: 0,
  connectTimeoutMs: 1000,
};

function createFakeTtsConnectionManager() {
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function createFakeSink(): TurnSink & { _jsonCalls: unknown[]; _binaryCalls: Uint8Array[] } {
  const _jsonCalls: unknown[] = [];
  const _binaryCalls: Uint8Array[] = [];
  return {
    sendJson(p) {
      _jsonCalls.push(p);
    },
    sendBinary(d) {
      _binaryCalls.push(d);
    },
    _jsonCalls,
    _binaryCalls,
  };
}

function createFakeTurnController() {
  let assistantSpeaking = false;
  let aborted = false;
  return {
    _setSpeaking(s: boolean) {
      assistantSpeaking = s;
    },
    _aborted: () => aborted,
    run: vi.fn(async () => {}),
    settled: vi.fn(async () => {}),
    isAssistantSpeaking: () => assistantSpeaking,
    abort: vi.fn(() => {
      aborted = true;
    }),
  };
}

// turn-controller is stubbed at the module boundary for these tests.
vi.mock("./turn-controller.ts", () => {
  const instances: ReturnType<typeof createFakeTurnController>[] = [];
  return {
    createTurnController: vi.fn(() => {
      const turn = createFakeTurnController();
      instances.push(turn);
      return turn;
    }),
    __getInstances: () => instances,
  };
});

const turnControllerModule = await import("./turn-controller.ts");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeSession(adapter: FakeSttAdapter) {
  const tts = createFakeTtsConnectionManager();
  const sink = createFakeSink();
  const history = createSessionHistory();
  const ctx = { buildMessages: vi.fn(() => []) } as unknown as Parameters<
    typeof createContinuousSession
  >[0]["contextAssembler"];
  const llm = { stream: vi.fn() } as unknown as Parameters<
    typeof createContinuousSession
  >[0]["llmProvider"];
  const session = createContinuousSession({
    sttAdapterFactory: () => adapter,
    sttAdapterConfig: BASE_ADAPTER_CONFIG,
    ttsConnectionManager: tts,
    history,
    sink,
    contextAssembler: ctx,
    llmProvider: llm,
    ttsProcessorFactory: async () =>
      ({ push: vi.fn(), pushSystem: vi.fn(), name: "fake" }) as unknown as Awaited<
        ReturnType<Parameters<typeof createContinuousSession>[0]["ttsProcessorFactory"]>
      >,
    chatModel: "m",
    language: "en",
  });
  return { session, sink, tts, history };
}

beforeEach(() => {
  (turnControllerModule as unknown as { createTurnController: { mockClear(): void } })
    .createTurnController.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContinuousSession", () => {
  it("opens both STT and TTS on start()", async () => {
    const adapter = createFakeSttAdapter();
    const { session, tts } = makeSession(adapter);
    await session.start();
    expect(tts.connect).toHaveBeenCalledTimes(1);
    expect(session.isConnected()).toBe(true);
    await session.close();
  });

  it("forwards turn_started as turn.started to sink", async () => {
    const adapter = createFakeSttAdapter();
    const { session, sink } = makeSession(adapter);
    await session.start();
    adapter._emit({ type: "turn_started", turnIdx: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink._jsonCalls).toContainEqual({ type: "turn.started", turnIdx: 1 });
    await session.close();
  });

  it("forwards transcript with rendered text and starts a turn", async () => {
    const adapter = createFakeSttAdapter();
    const { session, sink, history } = makeSession(adapter);
    await session.start();
    adapter._emit({ type: "transcript", turnIdx: 2, text: "hi [paused 1.2s] there" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink._jsonCalls).toContainEqual({
      type: "transcript.final",
      turnIdx: 2,
      text: "hi [paused 1.2s] there",
    });
    expect(history.messages()).toEqual([
      { role: "user", content: "hi [paused 1.2s] there" },
    ]);
    const mock = (
      turnControllerModule as unknown as {
        createTurnController: { mock: { calls: unknown[][] } };
      }
    ).createTurnController.mock;
    expect(mock.calls.length).toBe(1);
    await session.close();
  });

  it("forwards turn_dropped without starting a turn", async () => {
    const adapter = createFakeSttAdapter();
    const { session, sink, history } = makeSession(adapter);
    await session.start();
    adapter._emit({ type: "turn_dropped", turnIdx: 3 });
    await new Promise((r) => setTimeout(r, 0));
    expect(sink._jsonCalls).toContainEqual({ type: "turn.dropped", turnIdx: 3 });
    expect(history.messages()).toEqual([]);
    await session.close();
  });

  it("close() is idempotent", async () => {
    const adapter = createFakeSttAdapter();
    const { session } = makeSession(adapter);
    await session.start();
    await session.close();
    await session.close();
  });
});
```

- [ ] **Step D2.4: Run the pipeline tests**

```bash
bun run --cwd gateway test src/pipeline/continuous-session.test.ts
```

Expected: all pass.

- [ ] **Step D2.5: Commit**

```bash
git add gateway/src/pipeline/continuous-session.ts gateway/src/pipeline/continuous-session.test.ts
git rm gateway/src/pipeline/__tests__/continuous-session.integration.test.ts
git commit -m "refactor(gateway/pipeline): rewrite ContinuousSession for local-stt

459 → ~140 lines. One STT WS per voice-mode session. No emitter — sink
messages sent inline. Event loop handles exactly three STTEvent types.
Barge-in delegates to TurnTransition; no no-interrupt window (SDK's
WebRTC AEC + energy gate handle echo).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task D3: Simplify ws-handlers; fold continuous-voice-handler

**Files:**
- Modify: `gateway/src/session-handlers/ws-handlers.ts`
- Delete: `gateway/src/session-handlers/continuous-voice-handler.ts` (+ test)

- [ ] **Step D3.1: Rewrite `gateway/src/session-handlers/ws-handlers.ts`**

```ts
import { clientMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.ts";
import { getLog } from "../logging/logger.ts";
import { createContinuousSession } from "../pipeline/continuous-session.ts";
import type { TurnSink } from "../pipeline/turn-sink.ts";
import { type ClientData, errorMessage, sendError } from "./ws-helpers.ts";

const log = getLog(["sentient", "ws"]);

export type { ClientData };

export interface GatewayTlsMaterial {
  readonly cert: string;
  readonly key: string;
}

const WS_NORMAL_CLOSURE = 1000;

function createTurnSink(ws: ServerWebSocket<ClientData>): TurnSink {
  return {
    sendJson(payload: unknown): void {
      ws.send(JSON.stringify(payload));
    },
    sendBinary(data: Uint8Array): void {
      ws.send(data);
    },
  };
}

export function openSession(
  ws: ServerWebSocket<ClientData>,
  services: GatewayServices,
): void {
  const result = services.sessionManager.createSession();
  if (!result.ok) {
    sendError(ws, "session_limit", result.error);
    ws.close(WS_NORMAL_CLOSURE, "Session limit reached");
    return;
  }

  ws.data.sessionId = result.value.sessionId;
  log.info("session-opened", { sessionId: result.value.sessionId });

  ws.send(
    JSON.stringify({
      type: "auth.ok",
      sessionId: result.value.sessionId,
      role: result.value.role,
    }),
  );

  services.tts?.connectionManager.connect().catch((err: unknown) => {
    log.error("tts-prewarm-failed", { message: err instanceof Error ? err.message : String(err) });
  });
}

async function handleTextInput(
  ws: ServerWebSocket<ClientData>,
  text: string,
  services: GatewayServices,
): Promise<void> {
  const { context, llmProvider, chatModel } = services;
  if (!llmProvider) {
    sendError(ws, "provider_error", "LLM provider not configured");
    return;
  }
  const messages = context.contextAssembler.buildMessages([...ws.data.history.messages()], text);
  ws.data.history.append("user", text);
  let fullResponse = "";
  try {
    for await (const token of llmProvider.stream({
      model: chatModel,
      messages,
      signal: new AbortController().signal,
    })) {
      fullResponse += token;
      ws.send(JSON.stringify({ type: "response.text.delta", text: token }));
    }
    ws.data.history.append("assistant", fullResponse);
    ws.send(JSON.stringify({ type: "response.text.done" }));
  } catch (error: unknown) {
    sendError(ws, "provider_error", errorMessage(error, "LLM error"));
  }
}

async function handleAudioStart(
  ws: ServerWebSocket<ClientData>,
  services: GatewayServices,
): Promise<void> {
  const { stt, tts, context, llmProvider, chatModel, language } = services;
  if (!stt || !tts || !llmProvider) {
    sendError(ws, "stt_error", "Voice pipeline not fully configured");
    return;
  }
  if (ws.data.continuousSession) return;

  const session = createContinuousSession({
    sttAdapterFactory: stt.adapterFactory,
    sttAdapterConfig: stt.adapterConfig,
    ttsConnectionManager: tts.connectionManager,
    history: ws.data.history,
    sink: createTurnSink(ws),
    contextAssembler: context.contextAssembler,
    llmProvider,
    ttsProcessorFactory: tts.processorFactory,
    chatModel,
    language,
    ...(context.emotionTagOptions ? { emotionTags: context.emotionTagOptions } : {}),
  });
  ws.data.continuousSession = session;

  try {
    await session.start();
  } catch (err: unknown) {
    const msg = errorMessage(err, "Continuous session start failed");
    log.error("session-start-failed", { message: msg });
    ws.send(JSON.stringify({ type: "error", code: "stt_error", message: msg }));
    await session.close().catch(() => {});
    ws.data.continuousSession = null;
  }
}

async function handleAudioEnd(ws: ServerWebSocket<ClientData>): Promise<void> {
  const session = ws.data.continuousSession;
  if (!session) return;
  await session.close();
  ws.data.continuousSession = null;
}

function handleSessionEnd(
  ws: ServerWebSocket<ClientData>,
  services: GatewayServices,
): void {
  if (!ws.data.sessionId) return;
  services.sessionManager.removeSession(ws.data.sessionId);
  ws.data.sessionId = null;
  ws.data.history.clear();
  ws.close(WS_NORMAL_CLOSURE, "Session ended");
}

export async function handleWebSocketMessage(
  ws: ServerWebSocket<ClientData>,
  message: string | Buffer,
  services: GatewayServices,
): Promise<void> {
  if (typeof message !== "string") {
    ws.data.continuousSession?.sendAudio(new Uint8Array(message));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    sendError(ws, "protocol_error", "Malformed JSON");
    return;
  }

  const msgResult = clientMessageSchema.safeParse(parsed);
  if (!msgResult.success) {
    sendError(ws, "protocol_error", `Invalid message: ${msgResult.error.message}`);
    return;
  }
  const msg = msgResult.data;

  if (msg.type !== "ping") {
    log.debug("message-received", { type: msg.type });
  }

  switch (msg.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    case "text.input":
      await handleTextInput(ws, msg.text, services);
      return;
    case "audio.start":
      await handleAudioStart(ws, services);
      return;
    case "audio.end":
      await handleAudioEnd(ws);
      return;
    case "session.end":
      handleSessionEnd(ws, services);
      return;
    case "session.configure":
      ws.send(
        JSON.stringify({
          type: "session.ready",
          encoding: msg.preferredEncoding,
          captureSampleRate: msg.captureSampleRate,
          playbackSampleRate: msg.playbackSampleRate,
        }),
      );
      return;
    case "tool.confirm":
      // Tool-confirm handling belongs in the pipeline and is not yet wired;
      // receiving one today is a no-op handshake.
      return;
  }
}
```

- [ ] **Step D3.2: Delete the continuous-voice-handler file + test**

```bash
git rm gateway/src/session-handlers/continuous-voice-handler.ts gateway/src/session-handlers/continuous-voice-handler.test.ts
```

- [ ] **Step D3.3: Update any stale tests under `session-handlers/`**

If `gateway/src/session-handlers/ws-handlers.test.ts` references `auth`/`barge_in`/`utterance.*` or the old `options`-bag signature, rewrite those tests to:
- Pass a `services: GatewayServices` object (mock via `as unknown as GatewayServices`)
- Drop cases for deleted message types; assert that unknown types land in the default branch (rejected by `clientMessageSchema.safeParse`)

- [ ] **Step D3.4: Run tests**

```bash
bun run --cwd gateway typecheck
bun run --cwd gateway test src/session-handlers/
```

Expected: all pass.

- [ ] **Step D3.5: Commit**

```bash
git add gateway/src/session-handlers/
git commit -m "refactor(gateway/session-handlers): thread GatewayServices; drop dead branches

ws-handlers takes services: GatewayServices. Removes auth, barge_in,
utterance.start/end/cancel, guest.auth, session.start branches. Folds
continuous-voice-handler into ws-handlers; ContinuousSession is
constructed inline in handleAudioStart.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task D4: Rewrite server.ts

**Files:**
- Modify: `gateway/src/server.ts`

- [ ] **Step D4.1: Replace `gateway/src/server.ts`**

```ts
import type { Server, ServerWebSocket } from "bun";
import { createAdminHandler } from "./api/handlers/admin.ts";
import { createHealthHandler } from "./api/handlers/health.ts";
import { createReadyHandler } from "./api/handlers/ready.ts";
import { createWebuiHandler } from "./api/handlers/webui.ts";
import { createWsUpgradeHandler } from "./api/handlers/ws.ts";
import { createApiRouter } from "./api/router.ts";
import type { GatewayServices } from "./bootstrap/create-gateway-services.ts";
import { getLog } from "./logging/logger.ts";
import {
  type ClientData,
  handleWebSocketMessage,
  openSession,
} from "./session-handlers/ws-handlers.ts";

export type { ClientData };
export type { GatewayTlsMaterial } from "./session-handlers/ws-handlers.ts";

const log = getLog(["sentient", "ws"]);

export interface GatewayServerOptions {
  port: number;
  host: string;
  services: GatewayServices;
}

export function createGatewayServer(options: GatewayServerOptions): Server<ClientData> {
  const { services } = options;
  const adminToken = process.env.ADMIN_TOKEN;
  let activeConnections = 0;

  return Bun.serve<ClientData>({
    port: options.port,
    hostname: options.host,
    ...(services.tls ? { tls: services.tls } : {}),

    async fetch(request, serverInstance) {
      const router = createApiRouter({
        handleHealth: createHealthHandler(),
        handleReady: createReadyHandler({ getActiveConnections: () => activeConnections }),
        handleWsUpgrade: createWsUpgradeHandler(serverInstance),
        handleAdmin: createAdminHandler({ adminToken }),
        handleStatic: createWebuiHandler({ distDir: services.webDistDir }),
      });
      return router(request);
    },

    websocket: {
      open(ws: ServerWebSocket<ClientData>) {
        activeConnections++;
        log.info("client-connected");
        openSession(ws, services);
      },
      async message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
        await handleWebSocketMessage(ws, message, services);
      },
      close(ws: ServerWebSocket<ClientData>) {
        activeConnections--;
        log.info("client-disconnected");
        ws.data.continuousSession?.close().catch(() => {});
        ws.data.continuousSession = null;
        if (ws.data.sessionId) services.sessionManager.removeSession(ws.data.sessionId);
      },
    },
  });
}
```

- [ ] **Step D4.2: Typecheck + run all gateway tests**

```bash
bun run --cwd gateway typecheck
bun run --cwd gateway test
```

Expected: passes. The old `GatewayServerOptions` shape from ws-handlers is no longer referenced; any test still importing the old shape must be updated in D3 (already covered).

- [ ] **Step D4.3: Commit**

```bash
git add gateway/src/server.ts
git commit -m "refactor(gateway/server): take GatewayServices; drop old options bag

createGatewayServer({ port, host, services }). Router and WS lifecycle
read everything they need from services. Removes inline adminToken /
webDistDir / sessionManager threading.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task D5: Rewrite main.ts

**Files:**
- Modify: `gateway/src/main.ts`

- [ ] **Step D5.1: Replace `gateway/src/main.ts`**

```ts
import { createGatewayServices } from "./bootstrap/create-gateway-services.ts";
import { loadLoggingConfig, loadStartupConfig } from "./config/startup-config.ts";
import { createGatewayLogger, getLog } from "./logging/logger.ts";
import { createGatewayServer } from "./server.ts";

const loggingConfig = loadLoggingConfig();
await createGatewayLogger({
  ...(loggingConfig.logLevel ? { logLevel: loggingConfig.logLevel } : {}),
  enableFile: true,
  logDir: loggingConfig.logDir,
});

const log = getLog(["sentient"]);
const config = loadStartupConfig();
const services = createGatewayServices(config);
const server = createGatewayServer({ port: config.port, host: config.host, services });

log.info("gateway-started", { host: server.hostname, port: server.port });

export { server };
```

- [ ] **Step D5.2: Typecheck + gateway tests**

```bash
bun run --cwd gateway typecheck
bun run --cwd gateway test
```

Expected: passes.

- [ ] **Step D5.3: Commit**

```bash
git add gateway/src/main.ts
git commit -m "refactor(gateway/main): thin composer — config → services → server

15-line entry point. All service wiring lives in src/bootstrap/.
Missing-API-key WARNs now emitted by the individual factories.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task D6: Delete Deepgram providers + audio-stream-handler + barge-in-controller

**Files deleted:**
- `gateway/src/providers/stt/` (whole directory — 11 files)
- `gateway/src/pipeline/barge-in-controller.ts` + `.test.ts` + `barge-in-integration.test.ts`

- [ ] **Step D6.1: Remove Deepgram providers + audio-stream-handler**

```bash
cd /Users/kevinye/Development/sentient
git rm -r gateway/src/providers/stt/
```

- [ ] **Step D6.2: Remove barge-in-controller + its tests**

```bash
git rm gateway/src/pipeline/barge-in-controller.ts gateway/src/pipeline/barge-in-controller.test.ts gateway/src/pipeline/barge-in-integration.test.ts
```

- [ ] **Step D6.3: Verify no dangling imports**

Grep for removed symbols to be sure nothing left imports them:

- Grep pattern: `providers/stt` in `gateway/src/`
- Grep pattern: `createDeepgramProvider|createNova3Provider|createSTTProvider|createSTTConfig|audioStreamHandler|createBargeInController|BargeInController|STT_DEFAULTS|NOVA3_DEFAULTS|FluxTurnEvent` in `gateway/src/`

Expected: no hits in any remaining file. If any, rewrite the hit to the new shape or delete the reference.

- [ ] **Step D6.4: Run full gateway CI**

```bash
bun run --cwd gateway typecheck
bun run --cwd gateway test
```

Expected: green.

- [ ] **Step D6.5: Commit**

```bash
git add -A gateway/src/
git commit -m "chore(gateway): delete Deepgram providers, audio-stream-handler, barge-in-controller

Coverage dropped in lockstep with the code — replacement functionality
lives in adapters/stt/ + the simplified ContinuousSession.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase E — SDK shrink

### Task E1: Delete client-side VAD primitives + transcript accumulator

**Files deleted:**
- `shared/web-sdk/src/energy-vad-filter.ts` + test
- `shared/web-sdk/src/preroll-buffer.ts`
- `shared/web-sdk/src/trailing-vad-filter.ts` + test
- `shared/web-sdk/src/vad-filter.ts` + test
- `shared/web-sdk/src/transcript-accumulator.ts` + test

- [ ] **Step E1.1: Remove the files**

```bash
cd /Users/kevinye/Development/sentient
git rm shared/web-sdk/src/energy-vad-filter.ts shared/web-sdk/src/energy-vad-filter.test.ts
git rm shared/web-sdk/src/preroll-buffer.ts
git rm shared/web-sdk/src/trailing-vad-filter.ts shared/web-sdk/src/trailing-vad-filter.test.ts
git rm shared/web-sdk/src/vad-filter.ts shared/web-sdk/src/vad-filter.test.ts
git rm shared/web-sdk/src/transcript-accumulator.ts shared/web-sdk/src/transcript-accumulator.test.ts
```

- [ ] **Step E1.2: Strip exports from `shared/web-sdk/src/index.ts`**

Open `shared/web-sdk/src/index.ts` and remove any lines that `export` from the deleted files (e.g., `createEnergyVadFilter`, `createPrerollBuffer`, `createTrailingVadFilter`, `createVadFilter`, `createTranscriptAccumulator`, and their associated types). Leave all other exports untouched.

- [ ] **Step E1.3: Commit**

```bash
git add -A shared/web-sdk/src/
git commit -m "chore(web-sdk): delete client-side VAD primitives + transcript accumulator

Energy VAD moves into the gateway (adapters/stt/energy-gate.ts).
Partial transcripts are no longer emitted by the gateway, so the
accumulator is dead code.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task E2: Rewrite voice-client.ts

**Files:**
- Modify: `shared/web-sdk/src/voice-client.ts`
- Modify: `shared/web-sdk/src/voice-client.test.ts` (trim)

- [ ] **Step E2.1: Replace `shared/web-sdk/src/voice-client.ts`**

```ts
import type { AudioCaptureAdapter } from "./audio-capture-adapter.ts";
import type { AudioPlaybackAdapter } from "./audio-playback-adapter.ts";
import { sdkDebug } from "./debug.ts";
import { createEmitter } from "./event-emitter.ts";
import type { ChatMessage } from "./message-store.ts";
import { createMessageStore } from "./message-store.ts";
import type { SpeechService } from "./speech-service.ts";
import { createTransport } from "./transport.ts";
import type { VoiceState, VoiceStatus } from "./voice-state-machine.ts";
import {
  SPEAKABLE_STATES,
  STATUS_LABELS,
  type SideEffect,
  type VoiceEvent,
  transition,
} from "./voice-state-machine.ts";
import { createWsSpeechService } from "./ws-speech-service.ts";

interface LocationLike {
  protocol: string;
  host: string;
}

export function resolveDefaultWsUrl(loc: LocationLike | undefined): string {
  if (!loc) {
    throw new Error(
      "wsUrl is required when @sentient/web-sdk runs outside a browser — pass wsUrl explicitly.",
    );
  }
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/api/v1/ws`;
}

export interface VoiceClientConfig {
  wsUrl?: string;
  token: string;
  capture: AudioCaptureAdapter;
  playback: AudioPlaybackAdapter;
  createWebSocket?: (url: string) => WebSocket;
}

// biome-ignore lint/suspicious/noExplicitAny: event handler map
export interface VoiceClientEvents extends Record<string, (...args: any[]) => any> {
  statusChange: (status: VoiceStatus) => void;
  transcript: (text: string) => void;
  response: (text: string, isFinal: boolean) => void;
  messages: (messages: readonly ChatMessage[]) => void;
  error: (message: string) => void;
}

export interface VoiceClient {
  connect(): void;
  disconnect(): void;
  startVoiceMode(): Promise<void>;
  stopVoiceMode(): void;
  sendText(text: string): void;
  voiceState(): VoiceState;
  status(): VoiceStatus;
  messages(): readonly ChatMessage[];
  on<K extends keyof VoiceClientEvents>(event: K, handler: VoiceClientEvents[K]): () => void;
}

export function createVoiceClient(config: VoiceClientConfig): VoiceClient {
  const { token, capture, playback, createWebSocket } = config;
  const wsUrl =
    config.wsUrl ?? resolveDefaultWsUrl(typeof window === "undefined" ? undefined : window.location);

  const emitter = createEmitter<VoiceClientEvents>();
  const messageStore = createMessageStore();
  const transportConfig =
    createWebSocket !== undefined ? { url: wsUrl, token, createWebSocket } : { url: wsUrl, token };
  const transport = createTransport(transportConfig);
  const speechService: SpeechService = createWsSpeechService(transport);

  let voiceStateValue: VoiceState = "inactive";
  let lastError: string | undefined;
  let isPlaybackActive = false;
  let playbackRejecting = false;
  let voiceModeRequested = false;
  let activeStreamId: string | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function buildStatus(): VoiceStatus {
    const status: VoiceStatus = {
      state: voiceStateValue,
      label: voiceModeRequested ? STATUS_LABELS[voiceStateValue] : "Connected",
      canSpeak: SPEAKABLE_STATES.has(voiceStateValue) && voiceModeRequested,
      isActive: voiceModeRequested && voiceStateValue !== "inactive",
    };
    if (voiceStateValue === "error" && lastError) status.error = lastError;
    return status;
  }

  function dispatchVoice(event: VoiceEvent): void {
    const prev = voiceStateValue;
    const result = transition(voiceStateValue, event);
    voiceStateValue = result.state;
    if (prev === "error" && result.state !== "error") lastError = undefined;
    if (prev !== result.state || result.effects.length > 0) {
      sdkDebug("voice", `${prev} + ${event.type} → ${result.state}`, result.effects.map((e) => e.type));
    }
    for (const effect of result.effects) runEffect(effect);
    emitter.emit("statusChange", buildStatus());
  }

  function runEffect(effect: SideEffect): void {
    switch (effect.type) {
      case "OPEN_WS":
        transport.connect();
        break;
      case "SEND_AUTH":
        break;
      case "START_PLAYBACK":
        playback.clear();
        isPlaybackActive = true;
        break;
      case "STOP_PLAYBACK":
        isPlaybackActive = false;
        break;
      case "CLEAR_PLAYBACK":
        playback.clear();
        break;
      case "START_TIMEOUT": {
        const { key, ms } = effect;
        const t = setTimeout(() => {
          timers.delete(`voice:${key}`);
          dispatchVoice({ type: "TIMEOUT", context: key });
        }, ms);
        timers.set(`voice:${key}`, t);
        break;
      }
      case "CANCEL_TIMEOUT": {
        const { key } = effect;
        const t = timers.get(`voice:${key}`);
        if (t !== undefined) {
          clearTimeout(t);
          timers.delete(`voice:${key}`);
        }
        break;
      }
      case "START_RECONNECT_BACKOFF":
        break;
      case "CLEANUP":
        isPlaybackActive = false;
        capture.stop();
        transport.disconnect();
        speechService.dispose();
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        break;
      case "LOG_WARNING":
        break;
    }
  }

  // SpeechService → state machine
  speechService.on("turn-started", (turnIdx) => {
    messageStore.addUserPlaceholder(turnIdx);
    dispatchVoice({ type: "TURN_STARTED" });
  });

  speechService.on("transcript-final", (turnIdx, text) => {
    messageStore.replaceUserPlaceholder(turnIdx, text);
    emitter.emit("transcript", text);
    dispatchVoice({ type: "TRANSCRIPT_FINAL" });
  });

  speechService.on("turn-dropped", (turnIdx) => {
    messageStore.removeUserPlaceholder(turnIdx);
    dispatchVoice({ type: "TURN_DROPPED" });
  });

  speechService.on("barge-in", () => {
    if (activeStreamId !== null) {
      messageStore.finalizeStream(activeStreamId);
      activeStreamId = null;
    }
    playbackRejecting = true;
    isPlaybackActive = false;
    playback.clear();
    dispatchVoice({ type: "BARGE_IN_ACK" });
  });

  // Capture → transport (continuous streaming while voice mode is on)
  capture.onAudioData((data) => {
    if (!voiceModeRequested) return;
    speechService.sendAudio(data);
  });

  capture.onError((message) => {
    emitter.emit("error", message);
  });

  // Transport → state machine
  transport.on("authSuccess", (sessionId) => {
    sdkDebug("transport", "authSuccess", sessionId);
    dispatchVoice({ type: "AUTH_OK", sessionId });
  });

  transport.on("authFailed", (reason) => {
    sdkDebug("transport", "authFailed", reason);
    lastError = reason || "Authentication failed";
    emitter.emit("error", lastError);
    dispatchVoice({ type: "AUTH_FAILED", reason });
  });

  transport.on("stateChange", (state) => {
    sdkDebug("transport", "stateChange", state);
    if (state === "reconnecting") dispatchVoice({ type: "WS_DROP" });
    if (state === "connected" && voiceStateValue === "reconnecting") {
      dispatchVoice({ type: "RECONNECTED" });
    }
  });

  transport.on("jsonMessage", (msg) => {
    sdkDebug("msg", msg.type, msg);
    handleJsonMessage(msg);
  });

  transport.on("binaryMessage", (data) => {
    if (playbackRejecting || !isPlaybackActive) return;
    const pcm16 = new Int16Array(data);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = (pcm16[i] ?? 0) / 32768;
    playback.enqueue(float32);
  });

  messageStore.onChange((messages) => emitter.emit("messages", messages));

  function handleJsonMessage(msg: Record<string, unknown>): void {
    switch (msg.type as string) {
      case "response.start":
        activeStreamId = messageStore.startAssistantStream();
        dispatchVoice({ type: "RESPONSE_START" });
        return;
      case "response.audio.start":
        playbackRejecting = false;
        isPlaybackActive = true;
        return;
      case "response.audio.done":
        isPlaybackActive = false;
        if (activeStreamId !== null) {
          messageStore.finalizeStream(activeStreamId);
          activeStreamId = null;
        }
        dispatchVoice({ type: "AUDIO_DONE" });
        return;
      case "response.text.done":
        if (activeStreamId !== null) {
          messageStore.finalizeStream(activeStreamId);
          activeStreamId = null;
        }
        dispatchVoice({ type: "RESPONSE_TEXT_DONE" });
        emitter.emit("response", (msg.text as string) ?? "", true);
        return;
      case "response.text.delta": {
        const delta = (msg.text as string) ?? "";
        if (activeStreamId === null) activeStreamId = messageStore.startAssistantStream();
        messageStore.appendToStream(activeStreamId, delta);
        emitter.emit("response", delta, false);
        return;
      }
      case "error": {
        const errorMsg = (msg.message as string) ?? "Unknown error";
        lastError = errorMsg;
        emitter.emit("error", errorMsg);
        return;
      }
    }
  }

  return {
    connect() {
      dispatchVoice({ type: "CONNECT" });
    },
    disconnect() {
      dispatchVoice({ type: "DISCONNECT" });
    },
    async startVoiceMode() {
      voiceModeRequested = true;
      transport.sendJson({ type: "audio.start" });
      await Promise.all([playback.init(), capture.start()]);
      emitter.emit("statusChange", buildStatus());
    },
    stopVoiceMode() {
      voiceModeRequested = false;
      transport.sendJson({ type: "audio.end" });
      capture.stop();
      emitter.emit("statusChange", buildStatus());
    },
    sendText(text: string) {
      messageStore.addUserMessage(text);
      transport.sendJson({ type: "text.input", text });
    },
    voiceState: () => voiceStateValue,
    status: buildStatus,
    messages: () => messageStore.messages(),
    on<K extends keyof VoiceClientEvents>(event: K, handler: VoiceClientEvents[K]): () => void {
      return emitter.on(event, handler);
    },
  };
}
```

- [ ] **Step E2.2: Update `shared/web-sdk/src/voice-client.test.ts`**

Delete any test that references `vadPreFilter`, `prerollMs`, `createEnergyVadFilter`, `createTrailingVadFilter`, `createTranscriptAccumulator`, or the `SEND_BARGE_IN` effect. Any test that used to expect `transcript.partial` must be rewritten to expect `turn.started` → `transcript.final` flow. The `resolveDefaultWsUrl` tests keep as-is.

(Detailed replacement tests follow once `ws-speech-service` / `voice-state-machine` / `message-store` are updated in E3–E5 — this commit is primarily the voice-client rewrite + trimming.)

- [ ] **Step E2.3: Typecheck**

```bash
bun run --cwd shared/web-sdk typecheck
```

Expected: one or more errors about `VoiceEvent` missing `TURN_STARTED` / `TRANSCRIPT_FINAL` / `TURN_DROPPED`, and `SpeechService` missing `turn-started` / `transcript-final` / `turn-dropped` events. These are fixed in E3 + E4. Commit the current state anyway so the diff stays per-responsibility.

- [ ] **Step E2.4: Commit (typecheck temporarily red until E3+E4 land)**

```bash
git add shared/web-sdk/src/voice-client.ts shared/web-sdk/src/voice-client.test.ts
git commit -m "refactor(web-sdk): voice-client streams audio continuously; drop VAD wiring

Removes vadPreFilter, prerollMs, SEND_BARGE_IN, transcript.partial
handling. New SpeechService events wired: turn-started, transcript-final,
turn-dropped. Typecheck goes green after ws-speech-service +
voice-state-machine updates land in the next two tasks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task E3: Update ws-speech-service + speech-service interface

**Files:**
- Modify: `shared/web-sdk/src/speech-service.ts`
- Modify: `shared/web-sdk/src/ws-speech-service.ts`
- Modify: `shared/web-sdk/src/ws-speech-service.test.ts`

- [ ] **Step E3.1: Update `shared/web-sdk/src/speech-service.ts` interface**

Replace the SpeechService event surface. Exact diff depends on the current file; the new shape must expose exactly these event handlers (and no partial/vad ones):

```ts
// biome-ignore lint/suspicious/noExplicitAny: event handler map
export interface SpeechServiceEvents extends Record<string, (...args: any[]) => any> {
  "turn-started": (turnIdx: number) => void;
  "transcript-final": (turnIdx: number, text: string) => void;
  "turn-dropped": (turnIdx: number) => void;
  "barge-in": () => void;
}

export interface SpeechService {
  sendAudio(data: ArrayBuffer): void;
  on<K extends keyof SpeechServiceEvents>(event: K, handler: SpeechServiceEvents[K]): () => void;
  dispose(): void;
}
```

- [ ] **Step E3.2: Update `shared/web-sdk/src/ws-speech-service.ts`**

Replace the gateway→client message handlers:
- Drop `transcript.partial`, `vad.speech-start`, `vad.speech-end`, `vad.voice-detected`, `status.processing` handling.
- Add `turn.started`, `transcript.final`, `turn.dropped` handling.
- Keep `barge_in.ack` handling (emit `"barge-in"`).

Replacement (this is the whole file body — copy verbatim into `ws-speech-service.ts`):

```ts
import { createEmitter } from "./event-emitter.ts";
import type { SpeechService, SpeechServiceEvents } from "./speech-service.ts";
import type { Transport } from "./transport.ts";

export function createWsSpeechService(transport: Transport): SpeechService {
  const emitter = createEmitter<SpeechServiceEvents>();

  const unsubscribe = transport.on("jsonMessage", (msg) => {
    switch (msg.type as string) {
      case "turn.started":
        emitter.emit("turn-started", (msg.turnIdx as number) ?? 0);
        return;
      case "transcript.final":
        emitter.emit(
          "transcript-final",
          (msg.turnIdx as number) ?? 0,
          (msg.text as string) ?? "",
        );
        return;
      case "turn.dropped":
        emitter.emit("turn-dropped", (msg.turnIdx as number) ?? 0);
        return;
      case "barge_in.ack":
        emitter.emit("barge-in");
        return;
    }
  });

  return {
    sendAudio(data: ArrayBuffer): void {
      transport.sendBinary(data);
    },
    on<K extends keyof SpeechServiceEvents>(event: K, handler: SpeechServiceEvents[K]): () => void {
      return emitter.on(event, handler);
    },
    dispose(): void {
      unsubscribe();
      emitter.removeAll();
    },
  };
}
```

- [ ] **Step E3.3: Update `shared/web-sdk/src/ws-speech-service.test.ts`**

Replace with:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Transport } from "./transport.ts";
import { createWsSpeechService } from "./ws-speech-service.ts";

function createFakeTransport(): Transport & { _emitJson(msg: Record<string, unknown>): void } {
  const jsonHandlers: Array<(msg: Record<string, unknown>) => void> = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const t: any = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendJson: vi.fn(),
    sendBinary: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "jsonMessage") {
        jsonHandlers.push(handler as (msg: Record<string, unknown>) => void);
      }
      return () => {};
    },
    _emitJson(msg: Record<string, unknown>) {
      for (const h of jsonHandlers) h(msg);
    },
  };
  return t as Transport & { _emitJson(msg: Record<string, unknown>): void };
}

describe("ws-speech-service", () => {
  it("emits turn-started from turn.started message", () => {
    const transport = createFakeTransport();
    const svc = createWsSpeechService(transport);
    const handler = vi.fn();
    svc.on("turn-started", handler);
    transport._emitJson({ type: "turn.started", turnIdx: 7 });
    expect(handler).toHaveBeenCalledWith(7);
  });

  it("emits transcript-final with turnIdx and text", () => {
    const transport = createFakeTransport();
    const svc = createWsSpeechService(transport);
    const handler = vi.fn();
    svc.on("transcript-final", handler);
    transport._emitJson({
      type: "transcript.final",
      turnIdx: 2,
      text: "hi [paused 1.2s] there",
    });
    expect(handler).toHaveBeenCalledWith(2, "hi [paused 1.2s] there");
  });

  it("emits turn-dropped with turnIdx", () => {
    const transport = createFakeTransport();
    const svc = createWsSpeechService(transport);
    const handler = vi.fn();
    svc.on("turn-dropped", handler);
    transport._emitJson({ type: "turn.dropped", turnIdx: 4 });
    expect(handler).toHaveBeenCalledWith(4);
  });

  it("emits barge-in on barge_in.ack", () => {
    const transport = createFakeTransport();
    const svc = createWsSpeechService(transport);
    const handler = vi.fn();
    svc.on("barge-in", handler);
    transport._emitJson({ type: "barge_in.ack" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown message types", () => {
    const transport = createFakeTransport();
    const svc = createWsSpeechService(transport);
    const handler = vi.fn();
    svc.on("turn-started", handler);
    transport._emitJson({ type: "response.text.delta", text: "x" });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step E3.4: Run tests**

```bash
bun run --cwd shared/web-sdk test src/ws-speech-service.test.ts
```

Expected: all pass.

- [ ] **Step E3.5: Commit**

```bash
git add shared/web-sdk/src/speech-service.ts shared/web-sdk/src/ws-speech-service.ts shared/web-sdk/src/ws-speech-service.test.ts
git commit -m "refactor(web-sdk): speech service surface turn.started/transcript.final/turn.dropped

Drops transcript.partial and all vad.* handling. SpeechService contract
matches the gateway's simplified wire protocol.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task E4: Update voice-state-machine transitions

**Files:**
- Modify: `shared/web-sdk/src/voice-state-machine.ts`
- Modify: `shared/web-sdk/src/voice-state-machine.test.ts`

- [ ] **Step E4.1: Add the new events and remove dead ones**

Open `shared/web-sdk/src/voice-state-machine.ts`. Find the `VoiceEvent` union. Replace its "speech/VAD" related members with the new members. Specifically:

- Remove: `SPEECH_START`, `SPEECH_END`, `VOICE_DETECTED` (any speech-related events originating from the old SpeechService).
- Add: `TURN_STARTED`, `TRANSCRIPT_FINAL`, `TURN_DROPPED`.

Then update the `transition()` function so that:
- In any state that previously handled `SPEECH_START`, replace the handler with a `TURN_STARTED` handler that moves to `userSpeaking`.
- In any state that previously handled `SPEECH_END`, replace with a `TRANSCRIPT_FINAL` handler that moves to `thinking`.
- In any state that handled speech, add a `TURN_DROPPED` handler that moves back to `listening` / `idle` with no side effects.

The exact current state machine body is long; the rule is: grep for `SPEECH_START` / `SPEECH_END` / `VOICE_DETECTED` and rewrite each branch according to the mapping above. Keep state names unchanged; only events change. The `SEND_BARGE_IN` side effect was already dropped by E2 — if it still exists anywhere in this file, delete it and any `case` arms that emit it.

- [ ] **Step E4.2: Update tests**

Find every test that dispatches `{ type: "SPEECH_START" }` or `{ type: "SPEECH_END" }` — rename to `TURN_STARTED` / `TRANSCRIPT_FINAL` respectively. Add at least one new test per added event:

```ts
it("transitions userSpeaking → thinking on TRANSCRIPT_FINAL", () => {
  const result = transition("userSpeaking", { type: "TRANSCRIPT_FINAL" });
  expect(result.state).toBe("thinking");
});

it("transitions userSpeaking → listening on TURN_DROPPED", () => {
  const result = transition("userSpeaking", { type: "TURN_DROPPED" });
  expect(result.state).toBe("listening");
});
```

- [ ] **Step E4.3: Typecheck + test**

```bash
bun run --cwd shared/web-sdk typecheck
bun run --cwd shared/web-sdk test src/voice-state-machine.test.ts
```

Expected: both green. The voice-client and ws-speech-service should now also typecheck clean.

- [ ] **Step E4.4: Commit**

```bash
git add shared/web-sdk/src/voice-state-machine.ts shared/web-sdk/src/voice-state-machine.test.ts
git commit -m "refactor(web-sdk): state machine events renamed to turn-centric vocabulary

SPEECH_START → TURN_STARTED, SPEECH_END → TRANSCRIPT_FINAL, VOICE_DETECTED dropped.
Adds TURN_DROPPED. Drops SEND_BARGE_IN side effect.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task E5: Message store — placeholder bubble flow

**Files:**
- Modify: `shared/web-sdk/src/message-store.ts`
- Modify: `shared/web-sdk/src/message-store.test.ts`

- [ ] **Step E5.1: Extend `message-store.ts` with placeholder methods**

Add three methods to `MessageStore`:

```ts
export interface MessageStore {
  // ... existing methods ...
  addUserPlaceholder(turnIdx: number): void;
  replaceUserPlaceholder(turnIdx: number, text: string): void;
  removeUserPlaceholder(turnIdx: number): void;
}
```

Implementation semantics:
- `addUserPlaceholder(turnIdx)` — append a user `ChatMessage` with `text: "..."` and a stable id derived from turnIdx (e.g., `user-placeholder-<turnIdx>`). If a placeholder for this turnIdx already exists, no-op.
- `replaceUserPlaceholder(turnIdx, text)` — find the placeholder by its id; replace `text`. If no placeholder exists, append as a normal user message.
- `removeUserPlaceholder(turnIdx)` — find and splice out the placeholder. No-op if absent.

Concretely, inside the existing `createMessageStore()`:

```ts
function placeholderId(turnIdx: number): string {
  return `user-placeholder-${turnIdx}`;
}

// Inside the returned object:
addUserPlaceholder(turnIdx: number): void {
  const id = placeholderId(turnIdx);
  if (messages.some((m) => m.id === id)) return;
  messages.push({ id, role: "user", text: "...", isStreaming: false });
  emitChange();
},

replaceUserPlaceholder(turnIdx: number, text: string): void {
  const id = placeholderId(turnIdx);
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) {
    addUserMessage(text);
    return;
  }
  messages[idx] = { ...messages[idx], text };
  emitChange();
},

removeUserPlaceholder(turnIdx: number): void {
  const id = placeholderId(turnIdx);
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return;
  messages.splice(idx, 1);
  emitChange();
},
```

(If the file's internal field names differ — e.g., the state array is called `_messages` or similar — substitute while keeping the behavior.)

- [ ] **Step E5.2: Add tests**

```ts
describe("MessageStore user placeholder flow", () => {
  it("addUserPlaceholder emits a user message with '...'", () => {
    const store = createMessageStore();
    store.addUserPlaceholder(1);
    const msgs = store.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.text).toBe("...");
  });

  it("replaceUserPlaceholder swaps '...' for the final text", () => {
    const store = createMessageStore();
    store.addUserPlaceholder(2);
    store.replaceUserPlaceholder(2, "hi [paused 1.2s] there");
    const msgs = store.messages();
    expect(msgs[0]?.text).toBe("hi [paused 1.2s] there");
  });

  it("removeUserPlaceholder deletes the placeholder", () => {
    const store = createMessageStore();
    store.addUserPlaceholder(3);
    store.removeUserPlaceholder(3);
    expect(store.messages()).toEqual([]);
  });

  it("replaceUserPlaceholder appends a user message if placeholder absent", () => {
    const store = createMessageStore();
    store.replaceUserPlaceholder(99, "fallback");
    const msgs = store.messages();
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.text).toBe("fallback");
  });

  it("duplicate addUserPlaceholder for same turnIdx is a no-op", () => {
    const store = createMessageStore();
    store.addUserPlaceholder(1);
    store.addUserPlaceholder(1);
    expect(store.messages().length).toBe(1);
  });
});
```

- [ ] **Step E5.3: Run tests**

```bash
bun run --cwd shared/web-sdk test src/message-store.test.ts
```

Expected: all pass.

- [ ] **Step E5.4: Commit**

```bash
git add shared/web-sdk/src/message-store.ts shared/web-sdk/src/message-store.test.ts
git commit -m "feat(web-sdk): message store supports user placeholder bubble

addUserPlaceholder/replaceUserPlaceholder/removeUserPlaceholder drive
the '...' → rendered-transcript transition the webui uses between
turn.started and transcript.final.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task E6: SDK full-suite check

- [ ] **Step E6.1: Run the whole web-sdk test suite + typecheck**

```bash
bun run --cwd shared/web-sdk typecheck
bun run --cwd shared/web-sdk test
```

Expected: green. If individual tests under `voice-client.test.ts` still reference deleted symbols, trim or replace them so the suite passes. Do NOT fix broken tests from unrelated features — note them for a follow-up if any surface.

- [ ] **Step E6.2: Commit any test touch-ups**

```bash
git add -A shared/web-sdk/
git commit -m "chore(web-sdk): trim voice-client tests to match new surface

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

(Skip this commit if no touch-ups were needed.)

---

## Phase F — WebUI hook update

### Task F1: Simplify `use-voice-client.ts`

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`

- [ ] **Step F1.1: Replace the hook**

```ts
import { useSignal } from "@preact/signals";
import { type ChatMessage, type VoiceStatus, createVoiceClient } from "@sentient/web-sdk";
import { useEffect, useMemo } from "preact/hooks";
import { createWebAudioCapture } from "../adapters/web-audio-capture.ts";
import { createWebAudioPlayback } from "../adapters/web-audio-playback.ts";

export interface UseVoiceClientOptions {
  /** Override the default SDK URL. Defaults to
   *  `wss://<same origin>/api/v1/ws` (resolved by @sentient/web-sdk). */
  wsUrl?: string;
  token: string;
}

export function useVoiceClient(options: UseVoiceClientOptions) {
  const status = useSignal<VoiceStatus>({
    state: "inactive",
    label: "Ready",
    canSpeak: false,
    isActive: false,
  });
  const messages = useSignal<readonly ChatMessage[]>([]);
  const transcript = useSignal<string>("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: options deps are stable per wsUrl/token
  const client = useMemo(() => {
    const capture = createWebAudioCapture();
    const playback = createWebAudioPlayback();
    return createVoiceClient({ ...options, capture, playback });
  }, [options.wsUrl, options.token]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: signals are stable refs, not re-created on render
  useEffect(() => {
    const unsubs = [
      client.on("statusChange", (s) => {
        status.value = s;
      }),
      client.on("messages", (m) => {
        messages.value = m;
      }),
      client.on("transcript", (text) => {
        transcript.value = text;
      }),
    ];
    client.connect();
    return () => {
      for (const u of unsubs) u();
      client.disconnect();
    };
  }, [client]);

  return {
    status,
    messages,
    transcript,
    startVoiceMode: () => client.startVoiceMode(),
    stopVoiceMode: () => client.stopVoiceMode(),
    sendText: (text: string) => client.sendText(text),
  };
}
```

- [ ] **Step F1.2: Grep for stale SDK imports in webui**

Use Grep tool:
- Pattern: `createEnergyVadFilter` in `gateway/webui/src/`

Expected: no hits.

- [ ] **Step F1.3: Typecheck + test**

```bash
bun run --cwd gateway/webui typecheck
bun run --cwd gateway/webui test
```

Expected: green. Update the `transcript` signal's consumer if the old `isFinal` argument is referenced anywhere — the new SDK emits `(text: string)` only.

- [ ] **Step F1.4: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-client.ts
git commit -m "refactor(webui): drop vadPreFilter; let SDK stream continuously

createVoiceClient no longer takes a VAD filter — the energy gate is
server-side now. Webui renders the '...' placeholder via the SDK's
messages signal (driven by turn.started / transcript.final).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase G — Deploy / Docker

### Task G1: Docker-compose gateway tokens mount

**Files:**
- Modify: `deploy/pi/docker-compose.yml`
- Modify: `deploy/docker/docker-compose.yml`

- [ ] **Step G1.1: Add tokens mount to the Pi compose gateway service**

Open `deploy/pi/docker-compose.yml`. In the `services.gateway.volumes:` block, add these 6 lines (after the existing cert mount):

```yaml
      # Outbound auth tokens for gateway → STT. Read-only; managed by sentient-auth.
      - type: bind
        source: ~/.sentient/auth/tokens/gateway.yaml
        target: /app/tokens.yaml
        read_only: true
        bind:
          create_host_path: false
```

- [ ] **Step G1.2: Add the same mount to the Mac-local compose**

Open `deploy/docker/docker-compose.yml`. Add the identical mount block to the gateway service's `volumes:` section. If the local compose uses a different host path convention, substitute it here; the container path stays `/app/tokens.yaml`.

- [ ] **Step G1.3: Sanity-check by parsing both compose files**

```bash
docker compose -f deploy/pi/docker-compose.yml config > /dev/null
docker compose -f deploy/docker/docker-compose.yml config > /dev/null
```

Expected: no errors printed. (Docker isn't building anything here — just validating YAML + mount syntax.)

- [ ] **Step G1.4: Commit**

```bash
git add deploy/pi/docker-compose.yml deploy/docker/docker-compose.yml
git commit -m "build(deploy): mount gateway.yaml tokens into gateway container

Gateway reads /app/tokens.yaml to fetch the gateway-stt outbound token
at boot (loadGatewayOutboundToken). Read-only host bind prevents the
container from ever mutating the shared-token store.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task G2: Dockerfile COPY system_prompts/

**Files:**
- Modify: `gateway/Dockerfile`

- [ ] **Step G2.1: Swap the system-prompt COPY line**

Open `gateway/Dockerfile`. Find the line:

```
COPY gateway/system_prompt.md ./system_prompt.md
```

Replace with:

```
COPY gateway/system_prompts/ ./system_prompts/
```

Leave the `COPY gateway/persona.md ./persona.md` line on the next line untouched.

- [ ] **Step G2.2: Commit**

```bash
git add gateway/Dockerfile
git commit -m "build(gateway/docker): copy system_prompts/ directory recursively

Replaces the single-file copy with a directory copy so the new language
hint files (language-prompt-en.md, language-prompt-zh.md) ship in the
image alongside system_prompt.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task G3: setup.sh ensures tokens exist

**Files:**
- Modify: `deploy/pi/setup.sh`
- Modify: `deploy/local/setup.sh`

- [ ] **Step G3.1: Open `deploy/pi/setup.sh`**

Locate the block that creates `~/.sentient/gateway/` directories. Add these lines (adjust the surrounding bash style to match the existing script):

```bash
# Ensure gateway outbound token file exists. sentient-auth owns it.
mkdir -p "$HOME/.sentient/auth/tokens"
if [ ! -s "$HOME/.sentient/auth/tokens/gateway.yaml" ]; then
  echo "ERROR: $HOME/.sentient/auth/tokens/gateway.yaml is missing or empty."
  echo "       Run: cd sentient-auth && ./run.sh init"
  echo "       (or ./run.sh rotate gateway-stt to create just this slot)"
  exit 1
fi
```

- [ ] **Step G3.2: Apply the same change to `deploy/local/setup.sh`**

If the local setup.sh has the same pattern, add the same block. If it uses a different token-bootstrapping convention, adapt the check to match but keep the "fail loudly when gateway.yaml is missing" behavior.

- [ ] **Step G3.3: Dry-run both scripts (in a throwaway shell — they should be idempotent)**

```bash
bash -n deploy/pi/setup.sh
bash -n deploy/local/setup.sh
```

Expected: no syntax errors. Actual execution is deferred to Phase H.

- [ ] **Step G3.4: Commit**

```bash
git add deploy/pi/setup.sh deploy/local/setup.sh
git commit -m "build(deploy): fail setup when gateway.yaml tokens file is missing

Actionable hint points to sentient-auth init / rotate. Prevents a
container start failure with a less clear error when the bind mount
source doesn't exist.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task G4: Remove DEEPGRAM_API_KEY from examples + docs

**Files:**
- Modify: `gateway/.env.example` (if it exists)
- Modify: `deploy/pi/.env.example` (if it exists)
- Modify: `deploy/docker/.env.example` (if it exists)
- Modify: `gateway/README.md`
- Modify: `README.md` (root, if it references Deepgram)

- [ ] **Step G4.1: Grep for DEEPGRAM_API_KEY usages**

Use Grep tool:
- Pattern: `DEEPGRAM_API_KEY` in repo root (exclude node_modules + memory + committed spec).

Expected hits: env.example files, possibly README, possibly scripts. Nothing in `gateway/src/` (startup-config.ts dropped it in C7).

- [ ] **Step G4.2: Remove or comment out each occurrence**

For each hit:
- `.env.example` files → delete the line (or the comment block documenting it).
- `README.md` files → delete the row from any API-key table and adjust prose (e.g., "Deepgram for STT" → "local STT service").

Do not edit the committed design spec (`docs/superpowers/specs/...`) — that's historical.

- [ ] **Step G4.3: Commit**

```bash
git add -A
git commit -m "docs: drop DEEPGRAM_API_KEY from .env examples + README

STT is now the in-cluster local service; no Deepgram credentials
required.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task G5: Update gateway/README.md STT section

**Files:**
- Modify: `gateway/README.md`

- [ ] **Step G5.1: Rewrite the STT-related paragraph**

Open `gateway/README.md`. Find any section describing STT (probably mentions Deepgram Flux and/or Nova-3). Replace with:

```
### STT

The gateway speaks to `capabilityServices/STTService` over WebSocket. The
adapter lives in `src/adapters/stt/` and handles: auth (Bearer token from
`/app/tokens.yaml`), 48k→16k PCM downsample, a normalized-RMS energy
gate, and pause-aware transcript rendering (`[paused 1.2s]` / `[停顿 1.2秒]`).
Configuration: see the `stt:` block in `config.yaml`. See
`capabilityServices/STTService/CONTRACT.md` for the wire contract.
```

Remove any paragraph describing the old Deepgram Flux or Nova-3 setup, connection pool, or silence-keepalive mechanism.

- [ ] **Step G5.2: Commit**

```bash
git add gateway/README.md
git commit -m "docs(gateway): rewrite STT section around the local-stt adapter

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Phase H — Verification

Per `feedback_docker_verify_before_done`: the task is not done until the Docker stack builds, starts, and passes a real exercise.

### Task H1: Local CI green

- [ ] **Step H1.1: Run the full quality gate**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run ci
```

Expected: lint + typecheck + tests all pass. If anything fails, fix it before moving on. If a test flakes unrelated to this PR, use the "skip-broken-tests-during-refactor" convention (`--no-verify` with a note in the final commit) but keep a list of what was skipped.

---

### Task H2: Docker build

- [ ] **Step H2.1: Ensure host tokens file exists**

```bash
ls -la ~/.sentient/auth/tokens/gateway.yaml || true
```

If missing: build and run `sentient-auth` locally (see `feedback_docker_verify_before_done`):

```bash
cd /Users/kevinye/Development/sentient/sentient-auth
docker build -t sentient-auth:local .
# Mirror run.sh's mount shape, using the local tag:
docker run --rm -it \
  --network none \
  -v "$HOME/.sentient/auth/tokens:/tokens" \
  sentient-auth:local init
```

Then verify the slot exists:

```bash
grep -q "gateway-stt" ~/.sentient/auth/tokens/gateway.yaml || \
  docker run --rm -it --network none \
    -v "$HOME/.sentient/auth/tokens:/tokens" \
    sentient-auth:local rotate gateway-stt
```

Expected: `~/.sentient/auth/tokens/gateway.yaml` exists and contains a `gateway-stt:` slot with a `value: sak_…` line.

- [ ] **Step H2.2: Build all images via the Mac-local compose**

```bash
cd /Users/kevinye/Development/sentient/deploy/docker
docker compose build
```

Expected: gateway + stt-service (if this compose builds STT locally too) images build cleanly. Any build error in the gateway image most often comes from the `COPY gateway/system_prompts/` path being wrong — verify Task G2 landed.

---

### Task H3: Stack starts clean

- [ ] **Step H3.1: Start the stack**

```bash
cd /Users/kevinye/Development/sentient/deploy/docker
docker compose up -d
```

- [ ] **Step H3.2: Wait for health, then check logs**

```bash
sleep 10
docker compose ps
docker logs --tail 200 sentient-gateway
docker logs --tail 200 sentient-stt-service 2>/dev/null || true
```

Expected: both containers up. Gateway log shows:
- `sentient.config config-loaded`
- `sentient.bootstrap services-composed { llm: …, stt: true, tts: …, tls: …, language: "en" }`
- `sentient.auth.token-loader token-loaded { slot: "gateway-stt", fingerprint: "sak…" }`
- `sentient gateway-started`

If instead you see `token-file-missing` or `token-slot-not-found`, revisit H2.1.
If `service-disabled` appears for stt, the config failed to parse — check `gateway/config.yaml` stt block.

---

### Task H4: Exercise the stack (English)

- [ ] **Step H4.1: Open the webui**

```bash
open https://localhost:8888/
```

Accept the self-signed cert warning. Expect the app to load and `auth.ok` to arrive (check browser devtools Network tab → WS frames).

- [ ] **Step H4.2: Toggle voice on and say "Hello, what's your name?"**

Expected sequence in devtools WS panel (client ← gateway):
1. `auth.ok`
2. (after clicking voice) `turn.started { turnIdx: 1 }` → "..." bubble appears
3. `transcript.final { turnIdx: 1, text: "Hello, what's your name?" }` → bubble fills in
4. `response.start` / `response.text.delta`* / `response.audio.start` / audio binary frames / `response.audio.done` / `response.text.done`

In the gateway container logs (`docker logs -f sentient-gateway`):
- `sentient.session session-start` / `session-ready`
- `sentient.stt ws-opening` / `ws-ready`
- `sentient.stt turn-started { turnIdx: 1 }`
- `sentient.stt transcript { turnIdx: 1, length: … }`
- `sentient.session start-turn { transcript: "…" }`

- [ ] **Step H4.3: Exercise barge-in**

While the assistant is still speaking, say "Stop, tell me about Mars instead."

Expected: the assistant audio cuts. Next WS frames:
- `barge_in.ack`
- `turn.started { turnIdx: 2 }`
- `transcript.final { turnIdx: 2, text: "Stop, tell me about Mars instead." }`
- new `response.*` sequence

Gateway logs:
- `sentient.session barge-in-execute`
- `sentient.pipeline.turn-transition abort-turn` / `tts-reconnected` / `barge-in-ack-sent`

- [ ] **Step H4.4: Exercise turn_dropped**

Briefly tap the mic (don't actually speak — or make a short, sharp non-speech noise like a knock). Local STT should emit `turn_rejected`.

Expected:
- `turn.started { turnIdx: N }` (bubble appears)
- `turn.dropped { turnIdx: N }` (bubble disappears)
- No `transcript.final`, no `response.*`

Gateway logs:
- `sentient.stt turn-dropped { turnIdx: N, reason: "empty_transcript" }`
- `sentient.session turn-dropped-forwarded`

- [ ] **Step H4.5: Toggle voice off**

Expect `audio.end` on the client→gateway channel. Gateway logs: `session-close`, `sentient.stt ws-closed`.

---

### Task H5: Exercise the stack (Chinese)

- [ ] **Step H5.1: Flip language**

Edit `~/.sentient/gateway/config.yaml` (the mounted config on the host — per `feedback_dont_clobber_host_config`, never copy the repo file over it, edit it in place):

Change `stt.language: en` → `stt.language: zh`.

- [ ] **Step H5.2: Restart gateway**

```bash
cd /Users/kevinye/Development/sentient/deploy/docker
docker compose restart gateway
sleep 5
docker logs --tail 50 sentient-gateway
```

Expected: `sentient.context.system-prompt language-prompt-loaded` line shows the `language-prompt-zh.md` path.

- [ ] **Step H5.3: Reload webui, say a short Chinese utterance**

E.g. "你好，今天天气怎么样？"

Expected: `transcript.final` carries the rendered Chinese text. Assistant replies in Chinese. Check gateway log `sentient.stt transcript` line for the rendered text.

- [ ] **Step H5.4: Restore English**

Edit `~/.sentient/gateway/config.yaml` back to `language: en`, restart, verify.

---

### Task H6: Log hygiene check

- [ ] **Step H6.1: Scan for unexpected errors**

```bash
docker logs sentient-gateway 2>&1 | grep -iE 'ERROR|WARN' | head -50
```

Expected: each WARN is explainable (e.g., missing OPENROUTER_API_KEY if you ran without one). Any ERROR is a blocker — fix before claiming done.

- [ ] **Step H6.2: Verify JSONL log files**

```bash
ls -la ~/.sentient/gateway/logs/
tail -30 ~/.sentient/gateway/logs/$(date -u +%Y-%m-%d).log
```

Expected: INFO lines from §6.3 of the design spec (services-composed, session-start, turn-started, transcript, etc.) all present with `sessionId` + `turnIdx` fields.

---

### Task H7: Tear down + final commit

- [ ] **Step H7.1: Stop the stack**

```bash
cd /Users/kevinye/Development/sentient/deploy/docker
docker compose down
```

- [ ] **Step H7.2: Run `bun run ci` one more time (clean-tree verification)**

```bash
cd /Users/kevinye/Development/sentient
source scripts/env.sh
bun run ci
```

Expected: green.

- [ ] **Step H7.3: Final summary commit (only if fix-ups were needed)**

If any stray fixes were made during verification:

```bash
git add -A
git commit -m "fix: address issues surfaced during docker verification

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

Otherwise skip.

---

## Done

All tasks complete when:
- All checkboxes above are checked
- `bun run ci` is green on a clean tree
- `docker compose up -d` runs the full stack without ERRORs
- Manual exercise in H4–H5 showed the expected WS frame sequences
- Log files in `~/.sentient/gateway/logs/` show the expected INFO lifecycle

At that point open the PR against `main` with the commit log as the changelog. Include a brief note that the spec file is at `docs/superpowers/specs/2026-04-13-local-stt-gateway-refactor-design.md` and the design was pre-approved.
