# Streaming Typewriter — Design Spec

**Date:** 2026-04-20
**Branch:** `feature/streaming-typewriter`
**Sub-projects in this spec:** Phase 1 (adaptive-rate typewriter) + Phase 2 (semantic pause polish). Both implemented in `gateway/webui`. Phase 3 (LLM cognitive-load scoring) is explicitly deferred.

## Goal

Make the assistant chat bubble feel smooth and human-paced regardless of how the upstream provider chunks `message.delta` events. Today gpt-4.1-mini via OpenRouter often delivers the first ~50–100 chars of a short response in one chunk and then trickles smaller chunks; the user perceives "big chunk dump, then slow growth" with no character-by-character feel.

## Background

### What we observed

Confirmed via gateway logs (`content-delta` lines) and live Chrome DevTools instrumentation on 2026-04-20:

- **Provider chunking is uneven.** First few SSE chunks are often 50–100 chars; subsequent ones are 1–9 chars per token. Sometimes a single chunk carries an entire short reply.
- **Webui rendered each delta immediately, no batching, no animation.** `inflight-message-connector.ts` accumulates raw text and triggers `refreshMessages()` on every delta; `bubble-text.tsx` just renders `{text}`.
- **Bubble pop-in.** `appendInflightMessage` (`cycle-helpers.ts`) returns early when `inflight.text.length === 0`, so the bubble doesn't appear at all until the first non-empty delta arrives. With LLM TTFB of 1–16s, the user stares at empty space, then a chunk pops in.
- **Gateway forwards each provider chunk verbatim.** No batching at the gateway side; `cognitive-cycle.ts` emits one `message.delta` per LLM chunk.

### What we ruled out

- **Reducing provider chunk size:** OpenAI / OpenRouter expose no API knob for SSE granularity. Only "switch model" qualifies as a tune, and we don't want that.
- **Gateway-side re-chunking:** Modifies wire-protocol semantics ("a delta is a delta"); affects every consumer; couples to a hot path. Rejected.
- **Echoing speak's TTS text into `message.delta` for chunk display:** would conflate audio and chat channels. The whole point of separating speak from content is that the model writes whatever rich content it wants in chat and TTS-friendly prose in speak. Rejected.

### Reference designs reviewed

- **Vercel AI SDK `smoothStream`** — static delay, word/line/regex chunking. No rate adaptation. Author of Upstash blog called it "experimental"; built their own.
- **FlowToken `AnimatedText`** — adaptive `delay = 10 − (now − lastTokenTime)` per token. One-line moving rate, no semantic pacing.
- **ChatGPT / Claude.ai (observed)** — buffer-depth-aware: speed scales with how far behind the visible cursor is; sentence-end micro-pauses observed.
- **Google Bard (per literature)** — fixed "human reading speed" client buffer.
- **arXiv 2025 cognitive-load streaming** — Gunning-Fog readability + LLM-tagged complexity scores per sentence; weighted speed allocation. Research-grade, deferred.

## Architecture

A single `useTypewriterBuffer` hook in `gateway/webui/src/hooks/` decouples **buffer** (raw text accumulated from `message.delta` events, fed by `inflight-message-connector`) from **visible** (the substring rendered into the bubble). A `requestAnimationFrame` loop reveals characters from buffer to visible at a rate that varies with buffer depth and (Phase 2) semantic boundaries.

The hook's caller is the existing `useVoiceClient` (`use-voice-client.ts`) — it already owns the inflight buffer state. The hook replaces direct rendering of `inflight.text` with rendering of `visible` from the typewriter buffer; cycle completion signals end-of-stream.

### Data flow

```
provider                                   webui
   │                                          │
   │  message.delta { delta: "..." }          │
   ├─────────────────────────────────────────▶│
   │                                          │  inflight-message-connector
   │                                          │  → buffer += delta
   │                                          │  → onUpdate(inflight)
   │                                          │
   │                                          │  useTypewriterBuffer:
   │                                          │  → push(delta) → buffer.append
   │                                          │
   │                                          │  rAF tick:
   │                                          │  → compute reveal rate
   │                                          │  → visible = buffer.slice(0, n)
   │                                          │
   │                                          │  bubble-text renders visible
```

### Files

| File | Status | Responsibility |
|---|---|---|
| `gateway/webui/src/hooks/use-typewriter-buffer.ts` | **new** | The hook. Maintains buffer + visible, runs the rAF loop, exposes `{ visible, push(delta), markComplete(), reset() }`. |
| `gateway/webui/src/hooks/use-typewriter-buffer.test.ts` | **new** | Unit tests with synthetic timing (mock `requestAnimationFrame` + `performance.now()`). |
| `gateway/webui/src/hooks/use-voice-client.ts` | **modify** | Wire incoming `message.delta` (via inflight-connector update) into the typewriter; render `visible` instead of raw `inflight.text` for the inflight bubble. |
| `gateway/webui/src/hooks/cycle-helpers.ts` | **modify** | `appendInflightMessage` no longer skips when text is empty — Phase 1 wants the placeholder bubble to appear at cycle.started so the user has feedback during LLM TTFB. |
| `gateway/webui/src/components/messages/bubble-text.tsx` | **modify (light)** | Optional: render a typing indicator when text is empty AND `isStreaming === true` (the placeholder dot pulse). Default: empty paragraph rendered. |

No protocol changes, no gateway changes.

## Phase 1 — Adaptive rate typewriter (MUST-HAVE)

The hook reveals characters from the buffer at a rate proportional to how far behind the visible cursor is. The further behind, the faster it catches up.

### Algorithm

```ts
// State (per instance)
let buffer = "";          // total received
let visiblePos = 0;       // index into buffer; visible = buffer.slice(0, visiblePos)
let streamComplete = false;
let lastTickTs = 0;

// Tunables (Phase 1)
const BASE_RATE = 80;     // chars/sec — comfortable reading
const MIN_RATE = 30;      // floor — never slower
const MAX_RATE = 400;     // ceiling — burst speed when behind / draining
const GAP_GAIN = 0.02;    // each char of buffer-ahead → +2% rate

// Per-frame
function tick(now: number) {
  if (visiblePos >= buffer.length) {
    if (streamComplete) {
      stopLoop();
      return;
    }
    // Caught up but stream still live — keep the loop going (cheap)
    schedule();
    return;
  }

  const dt = (now - lastTickTs) / 1000;
  lastTickTs = now;

  const gap = buffer.length - visiblePos;
  let rate = streamComplete
    ? MAX_RATE                    // drain fast once stream ends
    : BASE_RATE * (1 + gap * GAP_GAIN);
  rate = Math.max(MIN_RATE, Math.min(MAX_RATE, rate));

  const advance = Math.max(1, Math.floor(rate * dt));
  visiblePos = Math.min(buffer.length, visiblePos + advance);
  emit(visible);
  schedule();
}
```

### Behavior

| Scenario | Provider sends | User sees |
|---|---|---|
| Tiny first chunk ("S" then trickle) | 1 char then 1–9 char chunks | Smooth reveal at ~80 chars/sec from the start. |
| Big initial chunk (50–100 chars) | One 80-char chunk, then nothing for 200ms | Bubble starts revealing at ~80 chars/sec, accelerates briefly as buffer-gap grows past 0, settles. No "dump." |
| Provider stalls mid-stream | 30 chars, then 2s pause, then more | Reveal hits buffer end during the pause, holds. When stream resumes, loop catches back up. Looks like a natural "thinking" pause. |
| Stream completes with buffer ahead | Final chunk + cycle.completed | `markComplete()` flips `streamComplete = true`; rate jumps to MAX_RATE; remaining text drains in <1s. |
| Caught up + stream live | visiblePos === buffer.length, streamComplete=false | Loop schedules but no work each tick. Tiny overhead. |

### Tunables (in `gateway/webui/src/config/typewriter.ts`)

```ts
export const TYPEWRITER = {
  baseRate: 80,
  minRate: 30,
  maxRate: 400,
  gapGain: 0.02,
};
```

A separate file because all four are user-perceptual; tuning happens in isolation. Phase 2 will add semantic-pause fields here.

### Inflight bubble appears at cycle.started, not first delta

`cycle-helpers.ts:267-277 appendInflightMessage` currently bails when `text.length === 0`. Phase 1 changes this so the bubble appears as soon as `cycle.started` arrives — even with empty text. The `bubble-text` renders a subtle three-dot pulse while `isStreaming === true && text.length === 0`. As soon as the typewriter emits its first character, the dot pulse swaps for text.

This eliminates the "stares at empty screen, then chunk pops" perception that compounds the chunkiness problem.

## Phase 2 — Semantic pause polish (NICE-TO-HAVE)

After Phase 1 lands and we've watched it for a session, layer in light pacing at semantic boundaries so prose reads like prose, not telex.

### Algorithm extension

Inside the per-frame `tick`, after computing `advance`, check whether the next visible character lies just past a sentence or paragraph boundary. If so, hold the visible cursor briefly (insert a one-frame skip equivalent to a small additional delay).

```ts
// Phase 2 tunables (added to TYPEWRITER config)
const SENTENCE_PAUSE_MS = 60;    // after . ! ? followed by whitespace
const PARAGRAPH_PAUSE_MS = 160;  // after \n\n

// State
let pauseUntil = 0;

// Inside tick (before advance):
if (now < pauseUntil) {
  schedule();
  return;
}

// After advance, check the just-revealed character:
const lastRevealed = buffer[visiblePos - 1];
const nextChar = buffer[visiblePos];
if (isSentenceBoundary(lastRevealed, nextChar)) {
  pauseUntil = now + SENTENCE_PAUSE_MS;
} else if (isParagraphBoundary(lastRevealed, buffer[visiblePos - 2])) {
  pauseUntil = now + PARAGRAPH_PAUSE_MS;
}

function isSentenceBoundary(c: string, next: string): boolean {
  return (c === "." || c === "!" || c === "?") && (next === " " || next === "\n" || next === undefined);
}
function isParagraphBoundary(c: string, prev: string): boolean {
  return c === "\n" && prev === "\n";
}
```

### Behavior

- After "Hello." the visible cursor pauses 60ms before "How are you?" starts revealing.
- After a paragraph break, a 160ms pause before the next paragraph begins. Reads as natural breath.
- Pauses cap at the same MIN/MAX rate envelope — they don't compound to "slow."
- When `streamComplete=true`, pauses are halved (or skipped entirely — TBD during Phase 2 implementation).

### Out of scope for this spec

- **LLM cognitive-load scoring per segment** (academic 2025 design). Overkill for chat; defer indefinitely.
- **Variable-rate per-language** (CJK reading speed differs from Latin). Defer.
- **Markdown-aware pacing** (slow down inside code blocks, etc.). Defer.

## Edge cases

- **Reset on new cycle:** `useTypewriterBuffer` exposes `reset()`. `useVoiceClient` calls it on `cycle.started` so each turn starts fresh.
- **Cycle aborted mid-stream (interrupt / barge-in):** `markComplete()` is called with the partial buffer; remaining text drains at MAX_RATE. The committed assistant entry's `cutoff` marker is rendered separately by `MessageBubble` after drain — typewriter doesn't need to know.
- **Multiple cycles in a chain (ReAct continuation):** each cycle gets its own typewriter instance keyed by `cycleId`. The inflight bubble disappears when the cycle commits; a new bubble (with new typewriter) appears for the continuation cycle.
- **rAF in background tab:** browsers throttle rAF when tab is hidden. Acceptable degradation — text reveals slowly until tab becomes active again, then catches up via gap-gain.

## Testing

- **Unit tests** (`use-typewriter-buffer.test.ts`) with mocked `requestAnimationFrame` + `performance.now()`. Cover: feed-and-drain at various rates, gap-gain acceleration, complete-then-drain, sentence-pause timing, reset.
- **Manual UX verification:** open the running webui, send a short prompt ("hi") and a long prompt ("tell me a one-paragraph story about X"). Both should feel smooth — short replies reveal at base rate without obvious "chunk pop"; long replies drain quickly when stream completes; sentences and paragraphs have visible breathing room (Phase 2).
- **No new browser-MCP test needed** — the existing `testing-knowledge.md` browser smoke procedures still apply.

## Acceptance

- Phase 1: short reply (~50 chars) and long reply (~600 chars) both reveal smoothly without sudden "chunk pop"; first character appears within ~100ms of first `message.delta`; cycle completion drains remaining buffer in <1s.
- Phase 2: sentence ends and paragraph breaks have perceptible (60–160ms) pauses; reading flow feels like prose, not stream.
- All unit tests green; lint, typecheck, full CI green.
- No protocol or gateway changes.

## Risks

- **Visible lag from real provider stream:** Phase 1 can lag by up to ~1s on a big initial chunk before catching up. Acceptable because we trade lag for smoothness; the "drain at MAX_RATE on complete" mitigates worst-case.
- **rAF jank on slow devices:** the hook should bail (revert to direct rendering) if rAF callbacks consistently miss their target by >50ms. Phase 1 doesn't need this; flag for Phase 2 if observed.
- **User adjustment to the base rate:** 80 chars/sec is a guess. Expose all four tunables in `config/typewriter.ts` so we can tune from data — not a code change, just a constant edit.

## References

- [GitHub - Ephibbs/flowtoken](https://github.com/Ephibbs/flowtoken)
- [Smooth Text Streaming in AI SDK v5 | Upstash Blog](https://upstash.com/blog/smooth-streaming)
- [Vercel AI SDK smoothStream source](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/smooth-stream.ts)
- [arXiv 2025 — Streaming, Fast and Slow: Cognitive Load-Aware Streaming](https://arxiv.org/html/2504.17999v2)
- Live evidence captured 2026-04-20: `~/.sentient/gateway/logs/2026-04-20.log` and Chrome DevTools MCP DOM observer output.
