# localTTS PoC — local TTS bake-off for sentient

Goal: replace paid cloud **Fish Audio** with a **local, private** TTS on the Mac mini
(`mini0`, base M4 16GB) that is (a) on par with Fish quality, (b) supports **voice
cloning**, and ideally (c) has community voices. One PoC per candidate, one shared
harness so the numbers compare.

## Why this matters

The local-LLM-on-mini idea was shelved — base M4 prefill is too slow (~200 t/s →
~10s TTFT on an 8B, minutes at long context). TTS models are ~0.5B (not 8B), so the
freed RAM is better spent here. RAM is a non-issue; **compute (RTF) and latency (TTFA)
are the questions.**

## Candidates

| Option | Params | Clone? | Community voices | Role |
|---|---|---|---|---|
| **kokoro** | 82M | ❌ (fixed packs) | 54 presets | speed reference / canned-voice fallback |
| **chatterbox** | 0.5B | ✅ zero-shot | shareable prompts | quality king (blind-beats ElevenLabs) |
| **qwen3tts** | ~0.5B | ✅ 3s ref | growing | streaming wildcard |

Fish Speech / OpenAudio S1 = the literal parity option, but no mature MLX port — it's a
Phase-2 *quality* check (torch/MPS), not a fair MLX *speed* contender here.

## Metrics (see `bench.py`)

- **ttfa_ms** — time-to-first-audio. The voice-latency KPI.
- **rtf** — compute ÷ audio duration. **< 1.0 = faster than real time.**
- **xrt** — audio-sec per compute-sec (headroom). Higher = safer for streaming.
- **rss_mb** — peak process memory.

## Hardware note

Runs on this dev box (**M3 Pro**, 14-core GPU, 150 GB/s). Target mini is **base M4**
(10-core GPU, 120 GB/s) ≈ **1.25–1.3× slower**. For a mini estimate: **ttfa ×1.3, xrt ÷1.3**.
Relative ranking between options is chip-independent — that's why comparing here is valid.

## Run

Each option is isolated (own uv env). No args needed:

```bash
cd kokoro && ./run.sh          # then chatterbox/, qwen3tts/
```

Writes `<option>/out/metrics.json` + `sample.wav`.

## Results (fill in as runs land)

See `RESULTS.md` for the full generated table. Headline (M3 Pro; mini = ×1.3):

| model | quant | ttfa (ms) | rtf | mini rtf | clone? | note |
|---|---|---|---|---|---|---|
| kokoro | 8bit | 297 | 0.06 | 0.08 | ❌ | fastest; no clone; 54 presets |
| **chatterbox-turbo** | **8bit** | **1415** | **0.28** | **0.36** | ✅ | **WINNER — fast + top quality + no tuning** |
| qwen3tts | 8bit | 1677 | 0.36 | 0.47 | ✅ | backup; higher ceiling but fiddly |
| chatterbox-turbo | fp16 | 3597 | 0.73 | 0.95 | ✅ | slower than 8bit here |
| chatterbox-std | fp16 | 4718 | 0.85 | 1.10 | ✅ | standard 10-step diffusion = too slow |
| omnivoice | bf16 | 4757 | 0.74 | 0.96 | ✅ | no streaming headroom |
| voxtral | bf16 (4B) | 18536 | 3.38 | 4.4 | ✅ | 4B — dead on this hardware |

## Verdict

**Chatterbox Turbo 8bit** — cloning + fast enough to stream (RTF 0.36 on the mini, per-sentence
~0.72s inside a 1s budget) + the ElevenLabs-blind-test-winning quality + zero tuning + 1.4GB.
Kokoro stays the fallback if cloning is ever dropped (12× realtime, 54 preset voices).

Notes: 8bit beat fp16 for Turbo (opposite of standard Chatterbox — quant speed is arch-dependent).
Numbers are idle M3 Pro; a real test on the mini *under concurrent STT+LLM load* is the Phase-2
confirmation. Integration: cache the voice conditionals once (the "voice pack") and stream
per-sentence.
