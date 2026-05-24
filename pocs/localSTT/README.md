# localSTT PoC — Silero VAD + Smart-Turn v3 + SenseVoice-Small on Raspberry Pi 5

The second minimum end-to-end proof-of-concept for running a **fully local**
voice endpointing + transcription stack on the Pi. Everything `localVAD`
did, plus a batch STT pass at turn boundaries:

```
  browser mic (16 kHz PCM16)
        │    WebSocket binary frames
        ▼
  ┌──────────────────────────────────────────────┐
  │  Docker container on RPi5                    │
  │                                              │
  │   Silero VAD  ──► Smart-Turn v3 ──► SenseVoice-Small
  │   (PyTorch)       (ONNX int8)       (ONNX int8)
  │                                              │
  │   full turn audio ─► WAV ─► volume           │
  │   transcript text ─► log ─► WS event ──┐     │
  └────────────────────────────────────────┼─────┘
                                           │
     browser renders text + plays audio ◄──┘
```

Smart-Turn fires `turn_complete` exactly as it does in `localVAD`. The
finalized turn's float32 audio buffer is handed *synchronously* to a
sherpa-onnx `OfflineRecognizer` running SenseVoice-Small int8. A
non-autoregressive forward pass produces the full transcript in a single
shot, and the service emits a `transcript_ready` event with text,
detected language, SenseVoice emotion tag, and audio-event tag (e.g.
laughter, BGM).

Every stage is timestamped in structured JSONL so you can answer:
*"how much latency does STT add on top of the VAD + Smart-Turn path?"*

---

## What's different from localVAD

| Aspect                          | localVAD         | localSTT                               |
| ------------------------------- | ---------------- | -------------------------------------- |
| Service name                    | `localvad-poc`   | `localstt-poc`                         |
| WebSocket port                  | `8765`           | `8766` (so both can run side-by-side)  |
| Environment prefix              | `LOCALVAD_*`     | `LOCALSTT_*`                           |
| Model dir layout                | one file in `/app/models/` | `/app/models/smart-turn/` + `/app/models/sense-voice/` |
| Extra dependency                | —                | `sherpa-onnx` (with aarch64 wheels)    |
| Extra runtime RAM               | —                | +~450 MB for SenseVoice-Small int8     |
| New event type                  | —                | `transcript_ready` (JSON only, no binary) |
| New log event                   | —                | `sensevoice.decode`                    |

Everything else — Silero, Smart-Turn v3.2 CPU ONNX, the state machine,
the metrics sampler, the JSONL log layout, the browser capture worklet —
is the same. The PoC intentionally mirrors `localVAD` so side-by-side
benchmarks are fair.

---

## What you need

Same as `localVAD`. If you already ran that PoC:

- Docker on the Pi ✓
- Python 3 + modern browser on your laptop ✓
- Pi reachable via mDNS or static IP ✓

New dependency at build time: the image pulls **SenseVoice-Small int8**
(~229 MB) from `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
on Hugging Face in addition to the Smart-Turn weights.

---

## Step 1 — Build the Docker image (on the Pi, natively)

```bash
cd ~/vad-stt   # or wherever you cloned this PoC
cd pocs/localSTT
docker build -t localstt-poc ./service
```

Build steps:
1. `python:3.12-slim-bookworm` base.
2. `apt-get install libgomp1 libsndfile1 ca-certificates`.
3. `pip install -r requirements.txt` — torch + silero-vad + onnxruntime +
   transformers + **sherpa-onnx** + websockets + psutil + numpy + soundfile +
   huggingface_hub.
4. `download_model.py` fetches both model bundles into `/app/models/`.
5. Source tree copy + volume mount dirs.

Expected build time on RPi5 over gigabit: ~8–12 min fresh, near-instant on
code edits. sherpa-onnx wheels are small (~20 MB) so they add only a few
seconds vs the `localVAD` build.

---

## Step 2 — Run the container

```bash
cd ~/vad-stt/pocs/localSTT
mkdir -p logs recordings
docker run --rm -it \
  --name localstt-poc \
  -p 8766:8766 \
  -v "$PWD/logs:/app/logs" \
  -v "$PWD/recordings:/app/recordings" \
  localstt-poc
```

You should see, in order:

```
localstt INFO loading Silero VAD (torch JIT)…
localstt INFO Silero VAD ready
localstt INFO loading Smart-Turn v3 ONNX from /app/models/smart-turn
localstt INFO Smart-Turn ready: /app/models/smart-turn/smart-turn-v3.2-cpu.onnx
localstt INFO loading SenseVoice-Small int8 ONNX from /app/models/sense-voice
localstt INFO SenseVoice ready: /app/models/sense-voice/model.int8.onnx
localstt INFO listening on ws://0.0.0.0:8766
```

First-time model load adds ~3–5 s for SenseVoice on top of Smart-Turn.
Container steady-state RSS lands around **1.0–1.1 GB** (vs ~600 MB for
`localVAD`), well within the 8 GB Pi budget.

> **Running both PoCs at once?** Different ports (`8765` vs `8766`), different
> container names (`localvad-poc` vs `localstt-poc`), different log dirs.
> They do not contend for anything except CPU cores.

---

## Step 3 — Run the browser client (on your laptop)

```bash
cd /path/to/pocs/localSTT/client
python3 -m http.server 8080
```

Then open **http://localhost:8080** in Chrome or Edge.

Paste your Pi URL — **port 8766 this time**, e.g.
`ws://raspberrypi.local:8766` — click **Connect**, then **Start mic**.

---

## Step 4 — Speak

Say something. A few hundred ms later you should see:

1. A "Turn N" card appear with a playable WAV (from `turn_complete`).
2. The card's transcript area briefly says "transcribing…".
3. That text is replaced by the actual transcription (from
   `transcript_ready`), with badges showing detected language, emotion
   (if not NEUTRAL), audio event (if not plain Speech), and the STT
   inference time in ms.

The event log below shows the full sequence:

```
… VAD start (turn 1)
… VAD end (turn 1)
… smart-turn: p=0.92 pred=1 in 107ms (audio 1.8s)
… TURN COMPLETE (turn 1): 1820ms, p=0.92
… saved turn 1: 57.0 KiB WAV
… TRANSCRIPT (turn 1) in 142ms: Hello, what's the weather today?
```

Switch to Chinese mid-session. SenseVoice's built-in language detection
should pick it up and the badges will flip from `en` to `zh`.

---

## Step 5 — Inspect logs

Everything is under `pocs/localSTT/logs/`:

| File                     | Contents                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| `service.jsonl`          | Startup, shutdown, per-connection open/close events.                |
| `conn_<id>.jsonl`        | Every VAD / Smart-Turn / SenseVoice event for one connection.       |
| `metrics.jsonl`          | 1 Hz process RSS / CPU%, thread count, host load, host mem.        |

The new-in-this-PoC event type is **`sensevoice.decode`**. It carries:

```json
{
  "event": "sensevoice.decode",
  "turn_idx": 5,
  "text": "How about this. [pause.0] If I pause [pause.1] with a lot of [pause.2] how's that going work.",
  "language": "<|en|>",
  "emotion": "<|NEUTRAL|>",
  "audio_event": "<|Speech|>",
  "decode_ms": 720.4,
  "audio_seconds": 7.8,
  "segment_count": 4,
  "pause_count": 3,
  "pause_durations_ms": [1240, 870, 1530],
  "vad_end_to_transcript_ms": 1023.8,
  "turn_complete_to_transcript_ms": 885.2
}
```

> **Note:** SenseVoice calls its audio-scene tag "event" — but the log
> wrapper's top-level ``event`` key is already used for the record type
> (``"sensevoice.decode"``), so we rename it to ``audio_event`` inside log
> records. The WebSocket wire format and the `TranscriptReady` dataclass
> still expose it as ``event``.

Per-segment decode details (one record per speech segment in the turn):

```json
{
  "event": "sensevoice.segment_decode",
  "turn_idx": 5,
  "segment_idx": 0,
  "text": "How about this.",
  "language": "<|en|>",
  "emotion": "<|NEUTRAL|>",
  "audio_event": "<|Speech|>",
  "decode_ms": 180.3,
  "audio_seconds": 1.8
}
```

If the language-allowlist filter relabeled the segment's detected
language (because SenseVoice guessed a language outside
``{zh, yue, en}`` on a short utterance), the log record adds one extra
field:

```json
{
  ...
  "language": "<|zh|>",
  "language_raw": "<|ja|>"
}
```

The ``language_raw`` field is absent when the filter didn't change
anything (the common case), so it's an easy grep target for audits —
``grep language_raw conn_*.jsonl`` shows you every short-utterance
misdetection the filter caught. The transcript ``text`` is never
modified by the filter; only the metadata label is corrected. To change
the allowlist or fallback language, edit ``ALLOWED_LANGUAGES`` and
``LANGUAGE_FALLBACK`` at the top of
``service/src/sense_voice.py``.

### Pause markers for the LLM

The PoC surfaces pauses in **two parallel places** in every
`transcript_ready` event:

1. **As `[pause.N]` placeholder tokens inline in the `text` field**, so
   the positional information (which words the pauses came between) is
   preserved.
2. **As an `int[]` array in the `pauses` field**, where `pauses[N]` is
   the duration in milliseconds of the pause referenced by `[pause.N]`.

```json
{
  "type": "transcript_ready",
  "turnIdx": 5,
  "text": "How about this. [pause.0] If I pause [pause.1] with a lot of [pause.2] how's that going work.",
  "language": "<|en|>",
  "pauses": [1240, 870, 1530],
  ...
}
```

Invariant: `text` contains exactly `len(pauses)` occurrences of
`[pause.N]`, and the indices `0..len(pauses)-1` each appear exactly
once, in order. You can rely on this.

#### Why placeholders, not inline-rendered markers

Hardcoding something like `[pause: 1.2s]` directly into the transcript
would bake an English convention into Chinese, Japanese, and Korean
output, which confuses LLMs — they either quote the foreign token
verbatim, treat it as a code fragment, or miss the intent entirely.

Keeping the positional marker as a neutral `[pause.N]` token means the
gateway can do a tiny language-aware string replace at the last moment,
using the `language` field from the same event to pick a rendering that
reads naturally in the target language. The placeholder is content-free
— it carries only a position and an index — so no language's reader
mistakes it for real text.

#### Recommended gateway substitution

```python
import re

PAUSE_PLACEHOLDER = re.compile(r"\[pause\.(\d+)\]")

def render_for_llm(event: dict) -> str:
    text = event["text"]
    pauses_ms = event.get("pauses", [])
    if not pauses_ms:
        return text
    language = normalize_lang(event.get("language", ""))
    formatter = _FORMATTERS.get(language, _format_en)
    return PAUSE_PLACEHOLDER.sub(
        lambda m: formatter(pauses_ms[int(m.group(1))]),
        text,
    )

def _format_en(ms: int) -> str:
    return f"(pause {ms / 1000:.1f}s)"

def _format_zh(ms: int) -> str:
    return f"（停顿{ms}毫秒）"

def _format_ja(ms: int) -> str:
    return f"（{ms}ミリ秒の間）"

def _format_ko(ms: int) -> str:
    return f"({ms}밀리초 멈춤)"

_FORMATTERS = {
    "zh": _format_zh, "yue": _format_zh,
    "ja": _format_ja,
    "ko": _format_ko,
    "en": _format_en,
}
```

For the Turn 5 example above, this produces:

- **English:** `"How about this. (pause 1.2s) If I pause (pause 0.9s) with a lot of (pause 1.5s) how's that going work."`
- **Chinese:** `"How about this. （停顿1240毫秒） If I pause ..."` (swap `"How about this."` for the Chinese equivalent in reality — the text is whatever SenseVoice produced)

The LLM reads each marker as natural parenthetical-aside metadata in its
own language, not a foreign code token.

#### Alternative renderings you might want

- **Scaled ellipsis (language-neutral):** map each pause to a number of
  ellipsis characters — `...` for 500–1500 ms, `......` for >1500 ms —
  and substitute. Reads as prose in every language. Loses precise duration.
- **Pause-density tag:** replace placeholders with a single
  `[hesitant]` / `[deliberate]` marker based on count and total duration.
  Cheapest prompt, lowest signal.
- **No rendering at all:** strip the placeholders entirely and pass the
  clean transcript plus a structured `pauses_ms: [1240, 870, 1530]`
  field to the LLM via a tool-call argument. Works great with models
  that reliably read structured metadata; overkill for simple chat.

Pick whatever matches your LLM's tolerance. The PoC intentionally
doesn't impose a choice — it gives you placeholders, durations, and a
detected language, and the gateway picks the rendering.

#### Why decode per segment, not the whole turn?

SenseVoice is non-autoregressive and does not expose word-level
timestamps, so there's no way to ask it "which word was at this
moment?" after the fact. The only way to know the transcript position
of each mid-turn pause is to control the concatenation ourselves: run
SenseVoice separately on each contiguous speech segment and join the
per-segment transcripts with `[pause.N]` tokens. That's what
`segment_decoder.decode_segments_and_stitch` does.

**Cost:** a turn with N speech segments runs N SenseVoice decodes
instead of 1. Empirically this is ~1.5-2× the wall time of a single
whole-turn decode, because SenseVoice's inference time scales with
input length and the per-segment durations sum to less than the whole
turn (silence is excluded). For a turn with no mid-turn pauses (the
common case), N=1 and there is no overhead vs. the original approach.

**Side benefit:** per-segment logging in `sensevoice.segment_decode`
gives you per-segment emotion, language, and audio-event tags, which
is richer than the single whole-turn label we used to emit. You could
use this to track, e.g., "user laughed during segment 2 but not
segments 1 or 3". The `TranscriptReady` wire event only exposes a
single representative tag (the first segment's), but the fine-grained
data is always in the connection log if you need it.

**`turn_complete_to_transcript_ms`** is the headline STT-only latency — how
much extra wall time SenseVoice adds on top of Smart-Turn. Expected range
on RPi5: 100–200 ms for utterances ≤ 5 s.

**`vad_end_to_transcript_ms`** is the full tail latency of the entire
pipeline — from the moment Silero declares end-of-speech to the moment the
transcript is ready. This is the "felt" conversational latency (minus
whatever your downstream LLM + TTS add).

### Quick log recipes

```bash
# All STT inference times
grep '"event":"sensevoice.decode"' logs/conn_*.jsonl \
  | python3 -c 'import sys, json
for l in sys.stdin:
    e = json.loads(l.split(":", 1)[1])
    print(f"turn {e[\"turn_idx\"]}: {e[\"decode_ms\"]:.1f}ms / {e[\"audio_seconds\"]:.2f}s audio → \"{e[\"text\"][:60]}\"")'

# RTF (real-time factor) per turn — should be way above 1
python3 -c '
import json
for fn in __import__("glob").glob("logs/conn_*.jsonl"):
    for line in open(fn):
        e = json.loads(line)
        if e.get("event") == "sensevoice.decode" and e["audio_seconds"] > 0:
            rtf = e["audio_seconds"] * 1000 / e["decode_ms"]
            print(f"  turn {e[\"turn_idx\"]}: {rtf:.1f}x realtime")
'

# Total tail latency (VAD end → transcript) for every turn
jq -c 'select(.event=="sensevoice.decode") | {turn: .turn_idx, tail_ms: .vad_end_to_transcript_ms}' \
  logs/conn_*.jsonl
```

### CPU / RAM correlation

Same analysis pattern as `localVAD`. The key new question: **does STT
add a second spike right after Smart-Turn's spike?**

```bash
cd /tmp && mkdir -p localstt-logs && \
  scp -r kevinye@raspberrypi.local:vad-stt/pocs/localSTT/logs/. localstt-logs/

python3 << 'PY'
import json, glob
m = [json.loads(l) for l in open("/tmp/localstt-logs/metrics.jsonl")]
m = [x for x in m if x.get("event") == "metrics.sample"]
stt = []
for fn in glob.glob("/tmp/localstt-logs/conn_*.jsonl"):
    for line in open(fn):
        e = json.loads(line)
        if e.get("event") == "sensevoice.decode":
            stt.append(e)

print(f"{len(m)} metric samples, {len(stt)} STT decodes")
for e in stt:
    near = [x for x in m if abs(x["t_mono_ns"] - e["t_mono_ns"]) < 1.5e9]
    if near:
        cpu = max(x["cpu_percent"] for x in near)
        rss = max(x["rss_mb"] for x in near)
        print(f"turn {e['turn_idx']}: decode={e['decode_ms']:.0f}ms, "
              f"peak CPU={cpu:.0f}%, peak RSS={rss:.0f}MB, text=\"{e['text'][:50]}\"")
PY
```

---

## What good output looks like

On a fresh Pi 5, short English utterance ("Hello, what's the weather?"):

```
turn 1: decode=140ms / 1.82s audio → 13.0x realtime
  vad_end_to_transcript_ms = 265ms   (200 ms Silero silence + 107 ms smart-turn + 140 ms STT ≈ fits)
  smart_turn: p=0.92, pred=1
  language: zh (if Chinese) / en (if English), auto-detected
```

On a short Chinese utterance ("今天天气怎么样"):

```
turn 2: decode=130ms / 1.55s audio → 11.9x realtime
  language: zh
  text: "今天天气怎么样？" (ITN enabled — question mark added)
```

On an 8-second monologue:

```
turn 3: decode=180ms / 8.00s audio → 44.4x realtime
  (SenseVoice is non-autoregressive so the RTF *improves* with longer audio —
  the forward pass is roughly constant cost, not per-token.)
```

---

## Troubleshooting

**Build fails at the SenseVoice download step.**  
Either the HF repo ID changed, or your Pi is behind a firewall blocking
`huggingface.co`. Options:
1. Download `model.int8.onnx` + `tokens.txt` manually from
   <https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17>
   and copy them into `service/models/sense-voice/` before building, then
   change the `RUN python scripts/download_model.py` line in the Dockerfile
   to `COPY models /app/models`.
2. Update the repo ID in `service/scripts/download_model.py` if a newer
   sherpa-onnx SenseVoice bundle has been published.

**`sherpa-onnx` wheel install fails.**  
Make sure you're building on the Pi natively (sherpa-onnx has aarch64
wheels on PyPI — `pip install sherpa-onnx` works directly). If you're
cross-building from x86 via QEMU, the install may fall back to a source
build which is very slow.

**Transcript is empty.**  
SenseVoice outputs nothing when the audio has no detectable speech. Check
`audio_seconds` in the log — if the VAD fired an `end` event on a very
short buffer (< 0.3 s), Smart-Turn may still have decided to finalize but
there's not enough speech for SenseVoice to decode. Usually a sign that
`VAD_MIN_SILENCE_MS` is too aggressive or the mic is too quiet.

**Chinese comes out as garbled romanization.**  
The `language` parameter in `sense_voice.py` is `"auto"` by default, so
SenseVoice's language detector should pick Chinese automatically. If
you're consistently getting pinyin/romanization, pin the language
explicitly by passing `language="zh"` to `SenseVoice(...)` in
`server.py`. Same for `language="en"` if English is misdetected.

**The service binds to port 8766 but my client talks to 8765.**  
Correct. `localVAD` is 8765, `localSTT` is 8766, so they can run
simultaneously. Update the "Service URL" field in the client page to
`ws://…:8766`.

---

## File map

```
pocs/localSTT/
├── README.md                      ← you are here
├── .gitignore
├── service/
│   ├── Dockerfile                 ← python:3.12-slim-bookworm + deps
│   ├── requirements.txt           ← adds sherpa-onnx>=1.10
│   ├── .dockerignore
│   ├── scripts/
│   │   └── download_model.py      ← fetches Smart-Turn + SenseVoice models
│   └── src/
│       ├── __init__.py
│       ├── server.py              ← WebSocket entry; loads all 3 models
│       ├── turn_pipeline.py       ← VAD + Smart-Turn + SenseVoice state machine
│       ├── pipeline_events.py     ← event dataclasses (adds TranscriptReady)
│       ├── wire_protocol.py       ← event → JSON/binary translator
│       ├── smart_turn.py          ← unchanged vs localVAD
│       ├── sense_voice.py         ← sherpa-onnx SenseVoice-Small wrapper
│       ├── wav_codec.py           ← unchanged vs localVAD
│       ├── metrics.py             ← unchanged vs localVAD
│       └── event_logger.py        ← unchanged vs localVAD
├── client/
│   ├── index.html                 ← adds transcript display card layout
│   ├── app.js                     ← WS + mic logic
│   ├── ui.js                      ← safe DOM helpers + turn cards
│   └── capture-worklet.js         ← same 16 kHz downsampler as localVAD
├── logs/                          ← mounted volume, gitignored
└── recordings/                    ← mounted volume, gitignored
```

---

## What this PoC answers

- **STT latency budget on RPi5:** how much wall-clock time does
  SenseVoice add after Smart-Turn, for typical utterance lengths?
- **RTF at different utterance durations:** does SenseVoice stay
  comfortably above realtime for 1 s, 5 s, 10 s inputs?
- **RAM delta:** does pushing the service past 1 GB resident affect
  anything else running on the Pi?
- **Multilingual correctness:** does `language="auto"` reliably
  pick the right language between English and Chinese mid-session?
- **ITN quality:** does inverse text normalization produce usable
  punctuation and number formatting, or do we need a post-processor?

## What this PoC does NOT answer

- End-to-end user-perceived latency (browser RTT is not captured).
- STT accuracy at scale — you need a labeled test corpus for that.
- How this stack behaves alongside a local LLM *running at the same
  time*. That's the next experiment: run `localSTT` + a local LLM and
  measure contention at turn boundaries.
