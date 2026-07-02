# Whisper-STT — native MLX STT service (design)

**Date:** 2026-07-01
**Branch:** `feature/whisper-stt-native`
**Status:** approved design → implementation planning

## 1. Goal

Add a second STT service, **Whisper-STT**, that runs natively on the Mac mini
(Apple Silicon, Metal via MLX) and transcribes with `whisper-large-v3-turbo`
(8-bit). It reuses the existing robust turn pipeline — **Silero VAD → Smart-Turn
v3 → per-segment decode → `[pause.N]` stitch** — swapping only the STT box
(SenseVoice → Whisper). The current Docker `STTService/` (SenseVoice) stays
untouched so both can run side-by-side and the gateway can be pointed at either.

The gateway remains in Docker. STT becomes operator-selectable: keep the
containerized SenseVoice service, or run the native Whisper service and have the
gateway dial it over the host boundary.

## 2. Why these choices (settled, not to re-litigate)

- **Docker on macOS has no Metal/ANE/GPU passthrough.** A containerized Whisper
  would be CPU-only. To use the Mac mini's actual acceleration, the Whisper
  service **must run natively**, outside Docker.
- **Engine: MLX-whisper (Python).** Lets us reuse the entire existing Python
  pipeline (server, turn machinery, VAD, Smart-Turn, wire protocol). Model swap
  is a one-line repo-id change. Exposes `no_speech_prob`/`avg_logprob` for
  hallucination filtering.
- **Model: `mlx-community/whisper-large-v3-turbo-8bit`** (config-swappable).
  Research-settled — no benchmark matrix:
  - **turbo vs v3:** WER gap ≈ 0.4 points; turbo is 4–8× faster, 809M vs 1.54B
    params. Turbo can't *translate*, but we only transcribe en/zh. Not worth v3.
  - **fp16 vs q8:** q8 is statistically indistinguishable from fp16 at ~half the
    RAM. Not worth fp16.
  - **q4:** real quality loss, worse on noisy/short audio — and our per-segment
    short-clip decode is already hallucination-prone. Rejected as default.
  - **RAM budget (M4 16GB, future local TTS voice-clone reserved):** turbo-8bit
    ≈ **~1.3 GB** inference RAM leaves ≥ ~5 GB for TTS + Docker + OS. Full
    large-v3 fp16 (~4–10 GB working RAM) is disqualified once TTS co-resides.
- **Paralinguistics dropped.** Whisper is text-only. SenseVoice's emotion /
  audio-event tags (laughter/BGM) are **not** carried forward. `[pause.N]` **is**
  kept — pauses are derived from VAD timing (`PauseTracker`), engine-independent.
  Accepted loss of the emotion/event LLM signal.

**Sources:** [Whisper Notes turbo vs v3](https://whispernotes.app/blog/introducing-whisper-large-v3-turbo),
[JustVoice M4 benchmark](https://justvoice.ai/blog/whisper-benchmark-apple-silicon-m3-m4),
[Quantizing Whisper (arXiv 2511.08093)](https://arxiv.org/html/2511.08093),
[mlx-community turbo-8bit](https://huggingface.co/mlx-community/whisper-large-v3-turbo-8bit),
[turbo-q4 size](https://huggingface.co/mlx-community/whisper-large-v3-turbo-q4),
[XTTS/F5 RAM](https://www.spheron.network/blog/self-host-voice-cloning-gpu-cloud-xtts-f5-tts-openvoice-v2/).

## 3. Service shape

New sibling `capabilityServices/WhisperSTTService/`. `STTService/` unchanged.

**Dup, not shared lib.** Copy the pipeline verbatim; the two services evolve
independently and one is likely retired later. Accepted trade-off: ~1500 dup'd
lines that can drift until then.

Copied unchanged (same behavior, same WS CONTRACT):
`server.py`, `turn_pipeline.py`, `pause_tracker.py`, `wire_protocol.py`,
`event_logger.py`, `config.py` (with the model section swapped), `opus_decoder.py`,
`metrics.py`, `wav_codec.py`, `pipeline_events.py`, `__main__.py`, `__init__.py`,
Silero VAD + Smart-Turn v3 wrappers.

**Ports:** WS `8768`, health `8769` (SenseVoice keeps `8766`/`8767`) so both run
concurrently.

**Runtime:** Python **venv**, not Docker. Setup deps: `brew install opus ffmpeg`
(opuslib needs system libopus for the ESP32 cube uplink path; ffmpeg only for the
Phase-2 test harness, not the service runtime).

## 4. Backend swap (what differs from the dup)

| File | Change |
|------|--------|
| `sense_voice.py` → `whisper_mlx.py` | New backend. `transcribe(f32_16k) -> {text, decode_ms, audio_seconds}`. Calls `mlx_whisper.transcribe(np_f32, path_or_hf_repo=<model>, **decode_opts)`. No emotion/event. |
| `segment_decoder.py` | Keep per-segment decode + `[pause.N]` stitch. Drop emotion/event fields from results. |
| `turn_finalizer.py` | Content gate → **text-only** (`_has_content`). Remove the `_is_meaningful_event` branch. Add hallucination guard (below). |
| `wire_protocol.py` / `pipeline_events.py` | `transcript_ready` keeps `text` + `pauses`; `emotion`/`event`/`audioEvent` emitted as empty strings (wire-compatible — gateway never parses them). |
| `config.py` + `config.example.yaml` | Replace `sense_voice:` with a `whisper:` block (see §5). |
| `requirements.txt` | Drop `sherpa-onnx`. Add `mlx-whisper`, `mlx`. Keep `silero-vad`(torch), `onnxruntime`, `transformers`, `websockets`, `numpy`, `soundfile`, `psutil`, `pyyaml`, `huggingface_hub`, `opuslib`. |
| `Dockerfile` | Removed — this service is native-only. |

**Hallucination guards** (config-driven, applied in the Whisper backend + gate):
- `condition_on_previous_text=False` (each segment decoded independently).
- `no_speech_threshold`, `logprob_threshold`, `compression_ratio_threshold`
  passed to `mlx_whisper.transcribe`; segments failing them yield empty text.
- Min-segment-duration skip before decode (reuse the existing duration gate).
- Optional `initial_prompt` (config) to bias domain vocabulary.

**Input codec.** The gateway already sends PCM16 LE mono @ 16 kHz — Whisper's
native input. No runtime resampling in the service. (The Phase-2 test harness
resamples its 48 kHz mp3 down to 16 kHz with ffmpeg *before* sending — the
service still only ever sees 16 kHz.)

## 5. `whisper:` config block (new)

```yaml
whisper:
  # HuggingFace repo id for the MLX Whisper weights. Swap to benchmark or
  # downgrade (e.g. -q4) without a code change. Fetched + cached on first run.
  model: "mlx-community/whisper-large-v3-turbo-8bit"
  # Decode language hint: "auto" | "en" | "zh". Whisper auto-detects; pin for
  # higher accuracy on short utterances that confuse auto-detect.
  language: "auto"
  # Hallucination guards — see design §4. Segments failing these decode to "".
  no_speech_threshold: 0.6        # drop segment if P(no-speech) exceeds this
  logprob_threshold: -1.0         # drop if avg token logprob below this
  compression_ratio_threshold: 2.4 # drop if gzip ratio above this (repetition)
  # Optional domain-vocabulary bias prompt; empty = none.
  initial_prompt: ""
```

Every value has an inline comment + range, per the config rule. No magic numbers
in source.

## 6. Phases

### Phase 1 — build the service
Scaffold `WhisperSTTService/` (dup pipeline + `whisper_mlx.py` + `whisper:`
config + `requirements.txt` + README + venv setup notes). No deploy wiring yet.

### Phase 2 — early TEST gate (blocks everything downstream)
`scripts/ws_smoke.py`: ffmpeg-decode `~/Development/record-weather.mp3`
(48 kHz mono → 16 kHz PCM16 mono), stream the PCM frames over the WS to a
locally-running Whisper-STT, print + assert `transcript_ready.text` ≈
**"tell me what's the weather today"**. Proves VAD → Smart-Turn → Whisper →
transcript end-to-end in isolation, before any gateway/deploy work.
Also eyeball the short-burst/silence behavior in the same run (no phantom text).

### Phase 3 — hybrid deploy (gateway stays Docker, STT selectable)
- **Native launcher:** launchd `LaunchAgent`
  `deploy/mac-prod/native/whisper-stt.plist` + helper
  `deploy/mac-prod/native/whisper-stt.sh {install|start|stop|status|logs}`.
  venv-based, survives reboot, binds host `0.0.0.0:8768`, logs to
  `~/.sentient/whisper-stt/logs/`, reads the same bearer token store
  (`~/.sentient/auth/tokens.yaml`).
- **Operator switch:** `deploy/mac-prod/deploy.conf` →
  `STT_BACKEND=native-whisper | docker-sensevoice`. A deploy script reads it to
  render the right gateway config + start/skip the launchd service. General
  "native vs docker per local service" mechanism, but only STT uses it now
  (YAGNI — do not over-build).
  - `docker-sensevoice` (today): `managed_services.stt-service` container;
    gateway `stt.url=ws://sentient-stt-service:8766`,
    `companions.stt_health_url=http://sentient-stt-service:8767/health`.
  - `native-whisper`: `managed_services.stt-service` gains `external: true` →
    the system service orchestrator **skips create/start** for it; gateway
    `stt.url=ws://host.docker.internal:8768`,
    `companions.stt_health_url=http://host.docker.internal:8769/health`;
    gateway service gets `extra_hosts: host.docker.internal:host-gateway`.
- **Gateway touch-points** (locate exact module in planning): the orchestrator
  that consumes `managed_services` policy must honor `external: true` (skip
  lifecycle, still health-poll the URL). The `stt.url` / `companions.stt_health_url`
  are already config — only their values change per backend.

### Phase 4 — lean final verification + handoff
Boot the full stack (Docker gateway + native Whisper-STT via the launcher).
**Agent verifies clean startup only:** service logs (`whisper.decode`,
`listening on ws://0.0.0.0:8768`), `/health` on 8769, and the gateway↔STT WS
connection established — no unexpected WARN/ERROR. Then **hand off to the user**
to run the live voice test on the webui. No agent-driven Playwright voice run.

## 7. Test / verification matrix (inline, per e2e rule)

The primary early gate is the Phase-2 functional WS smoke, not a browser E2E.
The final agent step is a boot/log inspection; the live voice path is
user-driven.

| Case | Surface | Pre-state | Action | Expected result | Log trail |
|------|---------|-----------|--------|-----------------|-----------|
| P2-happy | WS smoke script | Whisper-STT up (8768) | Stream `record-weather.mp3` (→16k) | `transcript_ready.text` ≈ "tell me what's the weather today" | `vad.start`→`smart_turn.eval`→`whisper.decode`→`turn.complete` |
| P2-silence | WS smoke script | up | Stream trailing silence / short burst | No phantom transcript; turn rejected | `turn.rejected` (`short_burst`/`empty_transcript`), no hallucinated text |
| P4-boot | Full stack (agent) | Docker gateway + native Whisper-STT | `whisper-stt.sh start`, `docker compose up` | Service listening, `/health` 200, gateway↔STT WS connected | `listening on ws://0.0.0.0:8768`, gateway STT connect, no WARN/ERROR |
| P4-selector | Full stack (agent) | `deploy.conf`→`native-whisper` | Deploy | Orchestrator skips STT container; gateway dials `host.docker.internal:8768`; health green | orchestrator "external stt skipped", health-poll green |
| Live-voice | webui (**user-driven**) | Full stack on native Whisper | User speaks into webui | Correct transcript → reply | (user-observed) |

Cases unreachable by the agent (live voice, real-device mic, paid services) are
explicitly handed to the user — not skipped silently.

Pre-handover gate: Phase-2 smoke green, Phase-4 boot clean, lint/typecheck/unit
clean on any touched TS (gateway config/orchestrator), Python service imports +
starts. No partial green.

## 8. Risks / open items

- **Emotion/laughter signal lost** to the LLM (accepted).
- **Whisper hallucination** on short/near-silent segments — mitigated by guards;
  verified in the Phase-2 smoke's silence case.
- **`host.docker.internal` resolution** depends on the Mac mini's Docker runtime
  (Desktop / Colima / OrbStack). Verify during Phase 3; add `extra_hosts` mapping.
- **Dup'd pipeline drift** until one STT service is retired.
- **MLX = Apple-Silicon only** — no Linux fallback for this service (fine; prod
  is the Mac mini, and SenseVoice-in-Docker remains the portable fallback).
- **Prod safety:** all validation runs against the LOCAL stack. Deploying the
  native service to the prod Mac mini is a separate explicit approval.
