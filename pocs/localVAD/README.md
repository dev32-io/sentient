# localVAD PoC — Silero VAD + Smart-Turn v3 on Raspberry Pi 5

A minimum end-to-end proof-of-concept for running a **local** endpointing stack
on the Pi:

```
  browser mic (16 kHz PCM16)
        │    WebSocket binary frames
        ▼
  ┌─────────────────────────────────────┐
  │  Docker container on RPi5           │
  │                                     │
  │   Silero VAD  ──► Smart-Turn v3     │
  │   (PyTorch JIT)    (ONNX CPU)       │
  │                                     │
  │   Per-turn audio ─► WAV ─► volume   │
  │        │                            │
  │        └──► WS text events + WAV ──┐│
  └────────────────────────────────────┼┘
                                       │
  browser downloads WAV ◄──────────────┘
```

When Silero reports end-of-speech (after ~200 ms of silence), the service runs
Smart-Turn v3 over the turn-so-far. If the model decides the user is done
(`probability > 0.5`), the full turn audio is packaged as a WAV, written to
`recordings/` on the Pi, and streamed back to the browser for playback and
download. If Smart-Turn decides the user is still talking, the turn buffer is
kept open and re-evaluated on the next pause.

Every stage emits structured JSONL logs to `logs/` with monotonic + wall-clock
timestamps so you can compute latency deltas end-to-end.

---

## What you need

On the **Raspberry Pi 5**:
- Raspberry Pi OS Bookworm (64-bit), any variant
- Docker installed (`curl -fsSL https://get.docker.com | sh` + `sudo usermod -aG docker $USER` + relog)
- ~3 GB free disk space (torch wheel is the biggest chunk)
- Network access to Hugging Face during the image build (to pull the
  Smart-Turn v3.2 CPU ONNX weights, ~9 MB)

On your **laptop** (whichever machine holds the mic):
- Python 3 (for `python3 -m http.server`, used to serve the client page over
  localhost so `getUserMedia` is happy with the secure-context requirement)
- A modern Chromium-based browser (Chrome or Edge — Firefox also works but
  its 16 kHz `AudioContext` handling has historically been less consistent)
- A working mic
- Pi reachable over the LAN (mDNS `raspberrypi.local` or a static IP)

---

## Step 1 — One-time Pi setup (cgroup memory controller)

RPi5 Bookworm ships with the cgroup memory controller **disabled by default**,
which makes `docker stats` report blank memory columns. Enable it once:

```bash
sudo sed -i 's/$/ cgroup_enable=memory cgroup_memory=1 swapaccount=1/' /boot/firmware/cmdline.txt
sudo reboot
```

Verify after reboot (Raspberry Pi OS Bookworm uses **cgroup v2** — don't
use the old `/proc/cgroups` check, it's v1-only and will look empty even
when things work):

```bash
# 'memory' must appear in the list of v2 controllers available at the root
cat /sys/fs/cgroup/cgroup.controllers

# End-to-end proof: Docker can impose a memory limit on a container
docker run --rm --memory=512m alpine cat /sys/fs/cgroup/memory.max
# → should print 536870912 (= 512 MiB in bytes)

docker info | grep -i cgroup    # 'Cgroup Version: 2'
```

> **Note:** on recent Raspberry Pi OS kernels (6.x+) with cgroup v2, the
> memory controller is already enabled by default — the `cmdline.txt` edit
> above is effectively a no-op on a fresh Bookworm install. It's only
> needed on older kernels / older distro versions. Check
> `cat /sys/fs/cgroup/cgroup.controllers` first; if `memory` is already
> listed, you can skip the reboot entirely.

> This whole section only affects `docker stats` / cgroup-scoped metrics —
> the PoC's own `psutil` metrics work either way because they read
> `/proc/self/*` directly.

---

## Step 2 — Get the code onto the Pi

From your laptop or straight on the Pi:

```bash
# on the Pi
git clone <your-sentient-fork-url> sentient
cd sentient/pocs/localVAD
```

---

## Step 3 — Build the Docker image (on the Pi, natively)

Cross-building from an x86 host is slower than building on the Pi itself for
this stack (torch ARM64 wheels are large and buildx emulation is not kind to
pip). Just do it on the Pi:

```bash
cd ~/sentient/pocs/localVAD
docker build -t localvad-poc ./service
```

What this does:
1. Pulls `python:3.12-slim-bookworm` (linux/arm64).
2. Installs `libgomp1` + `libsndfile1` via apt.
3. `pip install -r requirements.txt` — torch, silero-vad, onnxruntime,
   transformers, websockets, psutil, numpy, soundfile.
4. Runs `scripts/download_model.py` which pulls
   `pipecat-ai/smart-turn-v3/smart-turn-v3.2-cpu.onnx` (~8.7 MB) into
   `/app/models` inside the image.
5. Copies the source tree.

First build takes roughly 5–10 min on a healthy RPi5 over gigabit (mostly
torch wheel download). Subsequent rebuilds are near-instant unless you touch
`requirements.txt`.

---

## Step 4 — Run the container

```bash
cd ~/sentient/pocs/localVAD
mkdir -p logs recordings
docker run --rm -it \
  --name localvad-poc \
  -p 8765:8765 \
  -v "$PWD/logs:/app/logs" \
  -v "$PWD/recordings:/app/recordings" \
  localvad-poc
```

You should see, in order:

```
localvad INFO loading Silero VAD (torch JIT)…
localvad INFO Silero VAD ready
localvad INFO loading Smart-Turn v3 ONNX from /app/models
localvad INFO Smart-Turn ready: /app/models/smart-turn-v3.2-cpu.onnx
localvad INFO listening on ws://0.0.0.0:8765
```

Leave this terminal running. `Ctrl-C` shuts it down cleanly.

> **Optional:** to run detached, swap `--rm -it` for `-d --restart unless-stopped`.

---

## Step 5 — Run the browser client (on your laptop)

`getUserMedia` requires a secure context, so the page must load from HTTPS
*or* `localhost`. The easiest way is to serve the static files from a local
HTTP server on your laptop:

```bash
# on your laptop
cd /path/to/sentient/pocs/localVAD/client
python3 -m http.server 8080
```

Then open **http://localhost:8080** in Chrome or Edge.

---

## Step 6 — Talk to it

1. In the "Service URL" field, paste the WebSocket URL for your Pi — e.g.
   `ws://raspberrypi.local:8765` or `ws://192.168.1.42:8765`.
2. Click **Connect**. The status pill should flip to "connected" and the
   event log should print `server ready`.
3. Click **Start mic**. The browser will prompt for microphone access the
   first time. Accept it.
4. Speak a normal sentence, then pause.
5. Watch the event log:
   - `VAD start (turn 1)` when Silero detects voice onset.
   - `VAD end (turn 1)` after ~200 ms of silence.
   - `smart-turn eval: p=0.87 pred=1 in 42ms (audio 2.3s)` — Smart-Turn's
     verdict and its inference time.
   - `TURN COMPLETE (turn 1): 2310ms, p=0.87` — your turn was finalized.
6. A playable audio player + "download" link will appear under **Turn
   recordings**. Play it back to verify the service captured the whole
   sentence.

If Smart-Turn decides you weren't done (`probability <= 0.5`), you'll see
`turn continuing: p=0.23 < 0.5, accumulating more audio` instead. Keep talking
— the turn will extend across the pause.

Recordings are also written to `pocs/localVAD/recordings/` **on the Pi** as
`turn_<connid>_<turnIdx>.wav`, independent of the browser download.

---

## Step 7 — Inspect logs

Everything lives under `pocs/localVAD/logs/` on the Pi (mounted volume):

| File                     | What it contains                                             |
| ------------------------ | ------------------------------------------------------------ |
| `service.jsonl`          | Startup, shutdown, per-connection open/close events.        |
| `conn_<id>.jsonl`        | Every VAD transition, Smart-Turn eval, frame delivery, etc. |
| `metrics.jsonl`          | 1 Hz samples: RSS, CPU %, thread count, host load, host mem |

Each line is a JSON object with `ts` (ISO UTC), `t_mono_ns` (monotonic
nanoseconds — subtract two to get a real latency), and `event`.

Quick tail during a live run:

```bash
tail -f pocs/localVAD/logs/service.jsonl
tail -f pocs/localVAD/logs/metrics.jsonl
tail -f pocs/localVAD/logs/conn_*.jsonl
```

Pretty-print one line:

```bash
tail -1 pocs/localVAD/logs/metrics.jsonl | python3 -m json.tool
```

### Latency math

Each turn touches four interesting timestamps:

| Event                 | Captured as                        |
| --------------------- | ---------------------------------- |
| Speech actually ends  | (user-observed, unlogged)          |
| Silero fires `end`    | `vad.end.t_mono_ns`                |
| Smart-Turn finishes   | `smart_turn.eval.t_mono_ns`        |
| Turn result emitted   | `turn.complete.t_mono_ns`          |

The single most interesting number — **Silero-end → Smart-Turn verdict** — is
also logged pre-computed as `smart_turn.eval.vad_end_to_smart_turn_ms`.

Example one-liner to get all Smart-Turn inference times from a run:

```bash
grep '"event":"smart_turn.eval"' logs/conn_*.jsonl \
  | python3 -c 'import sys,json; [print(json.loads(l.split(":",1)[1])["eval_ms"]) for l in sys.stdin]'
```

### CPU / memory during inference

`metrics.jsonl` has 1 Hz samples. To see how the service behaves under load:

```bash
# process-level RSS and CPU %
jq -c 'select(.event=="metrics.sample") | {ts, rss_mb, cpu_percent, threads:.num_threads}' \
   logs/metrics.jsonl | tail -30
```

A typical idle service sits around 400–600 MB RSS and single-digit CPU %;
during a Smart-Turn inference the process should spike to ~100–200 % (one
core saturated, possibly two briefly).

---

## Tuning knobs

All defined in `service/src/turn_pipeline.py` — top of file:

| Constant              | Default | Effect if increased                                                     |
| --------------------- | ------- | ----------------------------------------------------------------------- |
| `VAD_THRESHOLD`       | 0.5     | Stricter speech detection (fewer false starts, more missed fragments). |
| `VAD_MIN_SILENCE_MS`  | 200     | Longer pause required before Smart-Turn is consulted.                  |
| `VAD_SPEECH_PAD_MS`   | 30      | More pre-/post-roll around detected speech.                            |
| `DECISION_THRESHOLD`  | 0.5     | In `smart_turn.py`. Higher = requires more confident "turn complete".  |

To change these, edit the file on the Pi and rebuild the image (a single
layer is affected; rebuild is seconds). You can also iterate without
rebuilding by bind-mounting the source directory on top of the container:

```bash
docker run --rm -it \
  -p 8765:8765 \
  -v "$PWD/logs:/app/logs" \
  -v "$PWD/recordings:/app/recordings" \
  -v "$PWD/service/src:/app/src" \
  localvad-poc
```

---

## Troubleshooting

**`AudioContext sampleRate = 48000 (worklet will downsample to 16000)`
in the event log.**  
That's the expected, happy-path message. The browser picked the native mic
rate and the worklet resamples to 16 kHz with linear interpolation before
sending frames to the server. You should also see
`worklet resampling 48000 Hz → 16000 Hz (stride=3.0000)` as the one-shot
diagnostic from the worklet on mic start.

**`mic start failed: ... Connecting AudioNodes from AudioContexts with
different sample-rate is currently not supported`.**  
Firefox-specific symptom of an old version of this PoC that tried to run
the AudioContext at 16 kHz while the MediaStream was at the native 48 kHz.
The current `client/capture-worklet.js` and `client/app.js` fix this by
running the AudioContext at native rate and resampling in the worklet. If
you still see this, you're running a stale copy of those two files — pull
the latest and hard-refresh the browser tab (`Cmd-Shift-R` / `Ctrl-Shift-R`).

**`Received unexpected binary (N bytes)` in the browser log.**  
Means a binary WAV arrived without a preceding `turn_complete` JSON — should
not happen under the current protocol. File an issue if you see it.

**Build fails at the `hf_hub_download` step.**  
The Pi needs outbound HTTPS to `huggingface.co` during the build. If your
network blocks it, download `smart-turn-v3.2-cpu.onnx` manually from
<https://huggingface.co/pipecat-ai/smart-turn-v3>, copy it into
`service/models/`, and swap `download_model.py` for a simple `COPY models/`
in the Dockerfile.

**Torch install is slow.**  
It's a ~420 MB ARM64 wheel fetched from PyPI. First build only. Subsequent
edits to `src/` use the cached layer.

**`docker stats` shows blank memory.**  
You forgot Step 1 (cgroup memory enable). The PoC's own `metrics.jsonl` will
still work — it uses `psutil.Process()` which bypasses the cgroup
restriction.

**`VADIterator` raises "Invalid audio chunk".**  
The pipeline rechunks to exactly 512 samples server-side; this error should
only fire if the client somehow sends truncated bytes. Check that the
worklet batch size is a multiple of 512.

---

## File map

```
pocs/localVAD/
├── README.md                      ← you are here
├── .gitignore
├── service/
│   ├── Dockerfile                 ← python:3.12-slim-bookworm + deps
│   ├── requirements.txt
│   ├── .dockerignore
│   ├── scripts/
│   │   └── download_model.py      ← pulls Smart-Turn v3.2 CPU ONNX at build
│   └── src/
│       ├── __init__.py
│       ├── server.py              ← WebSocket entry + connection lifecycle
│       ├── turn_pipeline.py       ← Silero + Smart-Turn state machine
│       ├── pipeline_events.py     ← Event dataclasses emitted by the pipeline
│       ├── wire_protocol.py       ← Event → JSON/binary wire-format translator
│       ├── smart_turn.py          ← ONNX inference wrapper
│       ├── wav_codec.py           ← PCM16 → WAV helper
│       ├── metrics.py             ← 1 Hz psutil sampler
│       └── event_logger.py        ← JSONL writer (service + per-conn + metrics)
├── client/
│   ├── index.html                 ← minimal UI
│   ├── app.js                     ← WS + getUserMedia + playback
│   └── capture-worklet.js         ← mic → Int16 PCM batcher
├── logs/                          ← mounted volume, gitignored
└── recordings/                    ← mounted volume, gitignored
```

---

## What this PoC is NOT

- A production replacement for the current Deepgram-based pipeline.
- A measurement of end-to-end user-perceived latency (browser network RTT is
  not captured; only server-side deltas are).
- A test of Smart-Turn accuracy at scale — you'll need a fixed test corpus
  for that.

What it **is**: a clean, logs-everything harness you can build in 10 minutes,
point a mic at, and watch the numbers roll in to decide whether Silero +
Smart-Turn v3 on-device is worth the architectural bet.
