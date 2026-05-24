# localVAD PoC — Tuning & Alternatives Reference

Every configurable knob in this PoC, what it does, what else you could pick,
and the trade-off. Written so that when one of these libraries or models gets
abandoned, renamed, or starts misbehaving, you can swap it out without
re-reading upstream source.

---

## Quick index

| Knob                         | Where                            | Default                     | Primary impact                        |
| ---------------------------- | -------------------------------- | --------------------------- | ------------------------------------- |
| `VAD_THRESHOLD`              | `turn_pipeline.py`               | `0.5`                       | How "loud" a sample must be to count  |
| `VAD_MIN_SILENCE_MS`         | `turn_pipeline.py`               | `200`                       | Pause length before endpointing fires |
| `VAD_SPEECH_PAD_MS`          | `turn_pipeline.py`               | `30`                        | Pre/post-roll around detected speech  |
| `SILERO_CHUNK_SAMPLES`       | `turn_pipeline.py`               | `512`                       | **Fixed by Silero** — don't change    |
| Silero backend               | `turn_pipeline.get_silero_model` | `onnx=False` (torch JIT)    | Startup time + RAM vs simplicity      |
| `DECISION_THRESHOLD`         | `smart_turn.py`                  | `0.5`                       | How confident Smart-Turn must be      |
| `MAX_SECONDS`                | `smart_turn.py`                  | `8`                         | **Fixed by model arch** — don't change|
| `MODEL_FILENAME`             | `smart_turn.py`                  | `smart-turn-v3.2-cpu.onnx`  | Smart-Turn version / variant          |
| `intra_op_threads`           | `smart_turn.py` (SmartTurn ctor) | `4`                         | ONNX parallelism on RPi5              |
| `TARGET_SAMPLE_RATE` (client)| `capture-worklet.js`             | `16000`                     | **Fixed by model contract**           |
| `BATCH_SAMPLES` (client)     | `capture-worklet.js`             | `1024` (64 ms @ 16 kHz)     | WS frame size                         |
| mic constraints              | `app.js` startMic                | AEC + NS + AGC on           | Mic quality vs rawness                |
| `OMP_NUM_THREADS`            | `Dockerfile` ENV                 | `4`                         | Torch thread pool                     |
| `MKL_NUM_THREADS`            | `Dockerfile` ENV                 | `4`                         | MKL thread pool (no-op on ARM)        |
| `LOCALVAD_METRICS_INTERVAL_MS`| `Dockerfile` ENV                | `1000`                      | Metrics sampling cadence              |
| `LOCALVAD_PORT`              | `Dockerfile` ENV                 | `8765`                      | WS port                               |

---

## 1. Silero VAD

### `VAD_THRESHOLD` — speech probability cutoff

**Default:** `0.5`
**Range:** 0.0 – 1.0
**What it does:** Silero emits a speech-probability score in [0, 1] for every
512-sample chunk. The `VADIterator` wrapper fires a `{'start'}` event when that
probability crosses this threshold, and `{'end'}` when it drops back and stays
below for `VAD_MIN_SILENCE_MS`.

**Lower (0.3–0.4):** more permissive. Catches quiet speech, mumbling, whispers,
children. Risk: background noise, fans, and keyboard clacks start firing
`vad_start` events → wasted Smart-Turn evaluations.
**Higher (0.6–0.7):** stricter. Ignores background. Risk: drops the first
syllable of a sentence while the speaker "warms up"; may miss soft-spoken users
entirely.

**When to change:** if you see phantom turns in logs with very short audio
(<300 ms) and low Smart-Turn probability, bump this up. If you see missing
turn starts ("VAD start never fired but user clearly spoke"), bump it down.

---

### `VAD_MIN_SILENCE_MS` — pause before endpointing

**Default:** `200` (200 ms)
**Typical range:** 100 – 800 ms
**What it does:** After speech-probability drops below `VAD_THRESHOLD`, how
long must the drop persist before Silero fires `{'end'}`. This is the pause
length that triggers a Smart-Turn evaluation.

**Lower (100 ms):** very snappy endpoint detection but Smart-Turn runs more
often. If you trust Smart-Turn to correctly say "not yet" on mid-sentence
pauses, a low value here is *fine* — Smart-Turn absorbs the false alarms.
This is actually the architectural bet of the whole PoC: "let VAD be hair-
triggered, let Smart-Turn be the adult in the room."
**Higher (500+ ms):** fewer Smart-Turn evaluations but noticeable lag at the
end of every turn. Users feel like the assistant is slow.

**Interaction with Smart-Turn:** this value is effectively the *minimum*
additional latency you add at end of speech on top of the Smart-Turn
inference time (~100 ms on RPi5). Total tail latency ≈ `VAD_MIN_SILENCE_MS` +
`smart_turn_eval_ms`. With defaults that's ~300 ms — the industry
"natural conversation" sweet spot.

---

### `VAD_SPEECH_PAD_MS` — context padding

**Default:** `30` (30 ms)
**Typical range:** 0 – 200 ms
**What it does:** How much audio before the speech onset (and after the
offset) to include in the emitted segment. Important for capturing the
attack and release of words.

**Lower (0):** minimal context. Works fine for our use case since we buffer
the whole turn audio ourselves, not just the Silero-reported segments.
**Higher (100+):** more context around each detected speech region. Useful
if you were using Silero to produce standalone speech clips for an STT that
can't handle abrupt starts.

**For this PoC:** low sensitivity. We accumulate the full turn audio from
first `vad_start` onward, so this knob mostly affects the internal Silero
state, not our recording. Leave at 30.

---

### `SILERO_CHUNK_SAMPLES` — **DO NOT CHANGE**

**Default:** `512`
**What it does:** Silero v5+ at 16 kHz *requires* exactly 512 samples per
call. At 8 kHz it's 256. Any other value raises at runtime. The pipeline's
rolling byte buffer in `TurnPipeline.process()` exists precisely to rechunk
arbitrary client frame sizes into this fixed window.

**If you upgrade Silero:** check the `VADIterator` source in
`silero-vad/src/silero_vad/utils_vad.py`. Version 4 accepted variable chunks;
version 5 tightened to fixed windows. Version 6 kept this. Future versions
may vary.

---

### Silero backend: `onnx=False` vs `onnx=True`

**Default:** `onnx=False` (PyTorch JIT — the "real Python" path per PoC brief)
**What it does:** `load_silero_vad(onnx=False)` returns a torch JIT module.
`onnx=True` returns an ONNX-wrapped object with the same call interface,
using onnxruntime under the hood.

**PyTorch JIT (default):**
- **Pros:** lets you debug the model with standard torch tooling; unified
  tensor flow with the rest of the Python stack.
- **Cons:** pulls ~300 MB of torch + torchaudio into the image. ~250 MB
  resident RAM at runtime.

**ONNX:**
- **Pros:** the service runs without torch at all. Image drops by ~300 MB.
  RAM drops by ~200 MB (onnxruntime is much leaner). Same silero-vad API.
  **Same inference accuracy.**
- **Cons:** you have to convert your audio feed to numpy (trivial — we
  already do) and cannot call `torch.from_numpy()` on the input anymore.
  One-line change: instead of `vad_iter(torch.from_numpy(chunk_f32))`,
  use `vad_iter(chunk_f32)` directly.

**Recommendation for long-term:** switch to `onnx=True` when you move this
PoC to production. Halves the image size, halves the RAM footprint, no
accuracy loss. The only reason we default to torch JIT here is because the
user's PoC brief said "the real python one" — not because torch is better.

---

### Silero version

**Installed:** `silero-vad>=5.1,<7` (pip). Currently resolves to 6.x as of
April 2026.

**Upstream location:** <https://github.com/snakers4/silero-vad>. Active
project, MIT license, single maintainer (snakers4) but consistent release
cadence. Model weights vendored inside the pip package; no HF download
required.

**If silero-vad is abandoned:** see §8 for VAD alternatives.

---

## 2. Smart-Turn v3

### `DECISION_THRESHOLD` — turn-complete probability cutoff

**Default:** `0.5`
**Range:** 0.0 – 1.0
**What it does:** Smart-Turn's sigmoid output is a probability that the user
is done speaking. Probability > `DECISION_THRESHOLD` → `prediction = 1` →
turn finalized. Your logs showed confidences of 0.83–0.99 on finalized
turns — you are nowhere near this boundary, so there's no pressure to tune.

**Lower (0.3–0.4):** more turns finalize, fewer "continuing" events. Risk:
Smart-Turn cuts the user off while they're still thinking. In an agentic
assistant that's rude and triggers unnecessary LLM calls.
**Higher (0.6–0.7):** more cautious. Fewer false finalizations. Risk: users
have to leave longer pauses to get a response; feels sluggish.

**When to change:** only if you see a specific failure mode in logs. E.g.
"every time I say 'umm' the assistant starts talking over me" → raise the
threshold. "I finish my question and it waits forever" → lower it.

---

### `MAX_SECONDS` — **DO NOT CHANGE**

**Default:** `8`
**What it does:** Smart-Turn v3 was trained with an 8-second context window.
The WhisperFeatureExtractor pads/truncates input to exactly 8 × 16000 =
128,000 samples. The ONNX graph expects this shape. Changing this value
means changing the model.

**Notable consequence:** for turns longer than 8 seconds, Smart-Turn only
sees the *last* 8 seconds. The accumulated turn buffer in `TurnPipeline` is
still longer; we just feed the tail to Smart-Turn. This is handled inside
`SmartTurn.predict()` via `audio[-MAX_SAMPLES:]`.

**In your logs:** turns 3 and 5 were >8 seconds and both were classified
correctly with only the trailing 8 seconds of context. This is working as
intended.

---

### `MODEL_FILENAME` — which Smart-Turn variant

**Default:** `smart-turn-v3.2-cpu.onnx` (8.68 MB)
**Source:** <https://huggingface.co/pipecat-ai/smart-turn-v3>

**Available files in that HF repo:**

| File                       | Size    | What it's for                              |
| -------------------------- | ------- | ------------------------------------------ |
| `smart-turn-v3.0.onnx`     | 8.76 MB | Initial v3 release; superseded             |
| `smart-turn-v3.1-cpu.onnx` | 8.68 MB | First CPU/GPU split                        |
| `smart-turn-v3.1-gpu.onnx` | 32.4 MB | FP32 version for GPUs                      |
| `smart-turn-v3.2-cpu.onnx` | 8.68 MB | **Current CPU default (what we use)**      |
| `smart-turn-v3.2-gpu.onnx` | 32.4 MB | FP32 version for GPUs                      |

**CPU vs GPU files:** The CPU files are int8-quantized (~8 MB), the GPU
files are FP32 (~32 MB). On ARM/CPU, always use the `-cpu` variant — the
FP32 version runs on CPU but is 3–4× slower for no accuracy gain on this
model scale.

**v3.0 → v3.1 → v3.2:** mostly training data and minor fine-tunes.
v3.2 is the one Daily currently recommends. v3.0 still works but is
slightly less accurate on edge cases. Roll back if v3.2 regresses for
you on a specific language.

**Earlier generations that live elsewhere:**
- **smart-turn v1/v2** — different repos (`pipecat-ai/smart-turn`,
  `pipecat-ai/smart-turn-v2`). Different model architectures entirely
  (Wav2Vec2-based instead of Whisper-Tiny). Slower inference (~300+ ms
  on RPi5 based on community reports), larger RAM footprint. Only worth
  going back to v2 if v3 has a specific regression for your use case.

**How to change:** edit `MODEL_FILENAME` in `smart_turn.py` and
`FILENAME` in `scripts/download_model.py`, then `docker build` again.
The build downloads the new file; no code changes needed beyond the
constant.

**If the HF repo disappears:** the weights are tiny (~9 MB). Mirror
`smart-turn-v3.2-cpu.onnx` to your own object storage (S3, GitLab LFS,
or just the repo itself) and change `download_model.py` to `curl` from
there. Smart-Turn weights are the kind of thing you want a local copy
of anyway.

---

### `intra_op_threads` — ONNX Runtime CPU parallelism

**Default:** `4` (passed to `SessionOptions.intra_op_num_threads` in
`smart_turn.py`)
**What it does:** How many CPU threads ONNX Runtime uses to parallelize a
single inference. The RPi5 has 4 Cortex-A76 cores, so 4 is the natural
default.

**Lower (1–2):** leaves cores free for other workloads (e.g. if you run STT
and smart-turn on the same Pi, lowering this to 2 leaves 2 cores for STT).
Inference gets slower (roughly 1.5–2× at threads=1).
**Higher (>4):** wasted — the RPi5 has exactly 4 physical cores, no SMT.
ONNX Runtime will just context-switch between threads for no benefit.

**Your benchmark said 107 ms at threads=4.** At threads=2 expect ~170 ms.
At threads=1 expect ~280 ms. The linear speedup isn't perfect because of
memory bandwidth constraints, but it's close.

**When to change:** when you share the Pi with other compute-heavy
workloads and want a predictable "smart-turn always uses N cores" budget
instead of a "smart-turn briefly saturates everything" spike.

---

## 3. Audio format

### `SAMPLE_RATE`, `TARGET_SAMPLE_RATE` — **DO NOT CHANGE**

**Default:** `16000`
**What it does:** Both Silero (in the 16 kHz config, which is the default)
and Smart-Turn v3 (which wraps WhisperFeatureExtractor) expect exactly
16 kHz mono audio. Silero supports 8 kHz as a fallback but the chunk size
shifts from 512 to 256. Smart-Turn does not support 8 kHz at all.

**Changing this means retraining or swapping models.** Leave it alone.

The client-side `TARGET_SAMPLE_RATE` in `capture-worklet.js` is a mirror of
the server-side value; keep them in sync.

---

### `BATCH_SAMPLES` — client WS batch size

**Default:** `1024` (64 ms at 16 kHz)
**Typical range:** 256 – 4096
**What it does:** The worklet accumulates resampled Int16 samples until it
has this many, then sends one binary WebSocket frame.

**Lower (256 – 512):** lower latency — each frame reaches the server sooner.
Higher WS overhead (more messages per second). With 256 at 16 kHz you're
sending 16 ms frames, ~62 frames/sec.
**Higher (2048 – 4096):** batched efficiency, fewer WS messages. Higher
latency floor because the last sample of a batch waits for the whole batch
before being sent. 4096 at 16 kHz = 256 ms of buffering at the client.

**Interaction with Silero:** the server rechunks these into 512-sample
Silero windows regardless, so only the client-side ingestion latency
changes. 1024 is a sweet spot: 2× Silero's window size (clean division),
64 ms of buffering (imperceptible), 16 frames/sec (easy on the WS library).

---

## 4. Browser mic constraints

In `app.js`, `navigator.mediaDevices.getUserMedia` is called with:

```js
{
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
}
```

### `channelCount: 1` — mono

Silero and Smart-Turn both want mono. Don't change. If the browser hands you
stereo anyway, the worklet only reads channel 0 (`inputs[0][0]`).

### `echoCancellation: true` (AEC)

Modern browsers (Chrome in particular) apply their own AEC when this is on.
For a PoC where you're just playing audio back from the same tab, AEC
rarely matters. But if you later integrate TTS playback *in the same
browser tab*, AEC becomes critical to prevent the assistant from hearing
itself.

**Change to `false` if:** you're seeing AEC eating quiet speech as if it
were echo. Rare but real on some hardware.

### `noiseSuppression: true` (NS)

The browser applies a noise filter before the audio hits your worklet.
Usually helpful — cleans up fans, keyboard, HVAC. Smart-Turn and Silero
both handle noisy audio poorly, so this is a freebie.

**Change to `false` if:** you want to test how the pipeline handles raw,
un-denoised audio, or if NS is eating the beginning of consonants (can
happen on over-aggressive Chromium builds).

### `autoGainControl: true` (AGC)

The browser dynamically adjusts input gain. Helpful for users who sit
variable distances from the mic. Neutral for the pipeline.

**Change to `false` if:** you want deterministic amplitude (e.g. for
comparing two recordings).

---

## 5. Threading / CPU environment

Set in the Dockerfile:

```dockerfile
ENV OMP_NUM_THREADS=4 \
    MKL_NUM_THREADS=4 \
    TOKENIZERS_PARALLELISM=false
```

### `OMP_NUM_THREADS=4`

OpenMP thread pool. Torch's ATen kernels and numpy's BLAS both read this.
On RPi5 (4 cores), 4 is optimal. Setting it higher just causes context
switching. Setting it lower (1 or 2) leaves cores free for other
processes.

### `MKL_NUM_THREADS=4`

Intel MKL thread count. **No-op on ARM** — there's no MKL on Cortex-A76;
ATen falls through to OpenBLAS. Setting this variable is harmless and
means you don't have to remember to remove it when moving the same
image to an x86 host for debugging.

### `TOKENIZERS_PARALLELISM=false`

Silences the HuggingFace tokenizers warning about forking with parallelism
enabled. Cosmetic — you can flip it to true, it just logs more noise on
startup.

### `torch.set_num_threads(1)` in `turn_pipeline.get_silero_model`

Overrides `OMP_NUM_THREADS` for torch specifically. Silero VAD is
lightweight enough that single-threaded is fine and avoids fighting
ONNX Runtime for cores during Smart-Turn inference. If you upgrade to a
heavier VAD model, raise this.

---

## 6. Service environment (env vars read by `server.py`)

| Variable                       | Default             | Purpose                                         |
| ------------------------------ | ------------------- | ----------------------------------------------- |
| `LOCALVAD_HOST`                | `0.0.0.0`           | Bind address for WS server                      |
| `LOCALVAD_PORT`                | `8765`              | WS port                                         |
| `LOCALVAD_MODEL_DIR`           | `/app/models`       | Where Smart-Turn ONNX lives                     |
| `LOCALVAD_LOG_DIR`             | `/app/logs`         | JSONL log output (mount a volume here)          |
| `LOCALVAD_RECORDING_DIR`       | `/app/recordings`   | Per-turn WAV output (mount a volume here)       |
| `LOCALVAD_METRICS_INTERVAL_MS` | `1000`              | Metrics sampling cadence                        |

**`LOCALVAD_METRICS_INTERVAL_MS` trade-off:**
- Lower (100–500 ms): catches short CPU spikes you'd miss at 1 Hz. Useful
  for measuring the *instantaneous* Smart-Turn CPU footprint (which is
  currently smoothed out by the 1-second window). Doubles your logs file
  size per unit time at 500 ms, 10× at 100 ms.
- Higher (5000+ ms): lower log volume for long-running production use.

For your benchmarking, try bumping it to `200` ms temporarily if you want
sharper CPU% numbers.

---

## 7. Alternatives — when upstream disappears or regresses

### If **silero-vad** is abandoned or broken

1. **WebRTC VAD** — the classic. Google's C++ VAD ported to Python as
   `py-webrtcvad`. Extremely fast (microseconds per 30 ms frame), tiny
   (~30 KB), deterministic. Accuracy is noticeably worse than Silero on
   non-English and on noisy inputs, but it's battle-tested and will never
   disappear. Drop-in replacement at the `VADIterator` level: you'd write
   a thin state machine that treats 3 consecutive non-speech frames as
   `{'end'}`.

2. **`@ricky0123/vad-web`** — Silero's ONNX model wrapped for browsers.
   Already in your `bun.lock`. If silero-vad the Python package breaks,
   you can extract the same weights and call them via `onnxruntime`
   directly — this is what `@ricky0123/vad-web` does, just on the JS side.

3. **Picovoice Cobra** — commercial VAD, very good at non-English and
   noisy environments. Free tier available. Proprietary so not a long-
   term open-source play, but a fallback if you need accuracy.

4. **Funasr VAD (`fsmn-vad`)** — Alibaba's VAD, strong on Chinese. Since
   you tested Chinese and it worked great, you probably don't need it,
   but worth knowing about if Silero ever regresses for Chinese.

5. **Hand-rolled energy-based VAD** — your main gateway already has
   `energy-vad-filter.ts`. It works for coarse gating but misses too many
   edge cases to be a standalone turn detector. Useful only as a fast
   prefilter before a real VAD.

### If **smart-turn v3** is abandoned

1. **Pure silence-duration heuristic** — the dumbest possible fallback.
   If the user has been silent for N milliseconds, consider the turn
   done. N=800 ms is the industry default for "no model" pipelines.
   Downside: handles thinking pauses poorly; the user has to artificially
   keep talking to avoid premature finalization. This is what Deepgram
   does internally when you use their native endpointing.

2. **Smart-Turn v2** — older generation at `pipecat-ai/smart-turn-v2`.
   Wav2Vec2-based (~95 MB model), ~300 ms CPU inference on RPi5 based
   on community reports. Slower but proven. Only worth reaching for if
   v3 breaks in a way that affects you specifically.

3. **Livekit turn detector** — Livekit open-sourced a similar
   end-of-turn classifier in 2025. Different architecture (text-
   informed; needs partial STT output). Worth investigating if you
   move to a Livekit-based stack later.

4. **STT-triggered endpointing** — let Deepgram/Whisper decide when
   the user is done, from the STT side. This is the "old way" and is
   what the main gateway currently uses. Smart-Turn's whole value
   proposition is that it's audio-only and doesn't need STT running
   first. If you go back to STT-triggered, you lose the latency
   advantage of streaming.

5. **Train your own** — Smart-Turn is a Whisper-Tiny encoder + linear
   classifier. Fine-tuning your own on a few thousand labeled turn-end
   samples from your real users is feasible on a single consumer GPU.
   The pipecat-ai/smart-turn repo has training scripts.

### If **PyTorch ARM64 wheels** stop shipping

Unlikely in the short term — torch aarch64 has been a first-class citizen
since torch 2.1. If it regresses:

1. Switch Silero to `onnx=True` and drop torch entirely. See §1 Silero
   backend for details — this is a ~10-line change.
2. Build torch from source in a separate stage. Painful (takes hours on
   the Pi) but works.
3. Pin to an older torch version that still has wheels.

### If **onnxruntime** ARM64 wheels stop shipping

Also unlikely, but if it happens:

1. Build onnxruntime from source. The build process is well-documented
   and takes ~30 min on an RPi5.
2. Switch to `onnxruntime-silicon` or `onnxruntime-openvino` (for Intel)
   if you're moving off ARM.
3. Manual Wav2Vec2 inference in raw PyTorch. Possible but loses the 3-4×
   speedup ONNX gives you.

---

## 8. Python dependencies — version sensitivity map

From `service/requirements.txt`:

| Package          | Pin                  | Why                                                |
| ---------------- | -------------------- | -------------------------------------------------- |
| `silero-vad`     | `>=5.1,<7`           | v5+ has the 512-sample chunk requirement. v7 is a hypothetical breaking change guard. |
| `onnxruntime`    | `>=1.18`             | Needed for the Whisper-Tiny encoder ops Smart-Turn v3 uses. Lower versions work but miss some ops. |
| `transformers`   | `>=4.48,<5`          | WhisperFeatureExtractor API stable since 4.44; 5.x will likely break it. |
| `websockets`     | `>=13,<14`           | 13.x has the new `websockets.asyncio.server` API we use. 14.x may remove legacy paths we don't use but pin for safety. |
| `numpy`          | `>=1.26,<2.2`        | numpy 2.0 dropped some APIs; we guard against ≥2.2 which may introduce further changes torch hasn't caught up to yet. |
| `soundfile`      | `>=0.12`             | Only used by librosa (dragged in by transformers). Stable. |
| `psutil`         | `>=7`                | 7.x has the Process API we use. Very stable package overall. |
| `huggingface_hub`| `>=0.24`             | Only used at build time by `download_model.py`. |

**Failure modes to expect:**

- **`numpy 2.x` ABI mismatch with torch.** Silent crashes on first tensor
  op. Fix: `pip install 'numpy<2.2'`. We already pin this.
- **`transformers 5.0` removing WhisperFeatureExtractor.** When this
  happens, either stay on 4.x forever or switch Smart-Turn's feature
  extraction to a hand-rolled numpy mel-spectrogram (the Whisper feature
  pipeline is ~100 lines of numpy; there are reference implementations
  on GitHub).
- **`silero-vad 7.x` changing the API.** Read the release notes, adjust
  the `VADIterator` usage in `turn_pipeline.get_silero_model`.

---

## TL;DR — the five knobs you're actually likely to touch

1. **`VAD_MIN_SILENCE_MS`** (default 200) — biggest lever on felt
   responsiveness. Try 100 if you want it snappier.
2. **`DECISION_THRESHOLD`** in `smart_turn.py` (default 0.5) — touch only
   if you see specific false-finalization or stuck-forever behavior.
3. **`intra_op_threads`** in `smart_turn.py` (default 4) — lower to 2
   when sharing the Pi with STT/LLM workloads.
4. **Silero backend** `onnx=False → True` — when you productionize,
   saves ~300 MB RAM for free.
5. **`MODEL_FILENAME`** — when Smart-Turn v3.3/v4 ships, flip this
   constant + rebuild.

Every other constant in the PoC is either fixed by a model contract, by a
library API, or by a design choice that has no practical reason to move.
