# Local Chatterbox-Turbo TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cloud Fish Audio with a local, private native MLX Chatterbox-Turbo TTS service on the Mac mini — streaming, per-user web voice cloning, and complete Fish removal.

**Architecture:** A native launchd Python service (`capabilityServices/ChatterboxTTSService/`, WS `:8770` + health `:8771`) runs Chatterbox-Turbo-8bit via mlx-audio, streams text→audio, and encodes to a negotiable codec (default 48 kHz OGG-Opus, matching Fish byte-for-byte so all clients are unchanged). The gateway gets a thin `local-tts` `TTSProvider` (WS client) driven by a provider-neutral streaming synthesizer (the former Fish synthesizer, generalized). All Fish code — provider, protocol, catalog, secrets, wizard step, config, and the entire emotion-tagging decorator unit plus its now-dead gateway LLM provider — is removed. Per-user cloning: webui Voices panel → gateway REST → service WS `voice.*` control.

**Tech Stack:** Python 3.12 + mlx-audio (Chatterbox-Turbo-8bit) + `websockets` + `opuslib` + `soxr`; TypeScript/Bun gateway; Preact webui; launchd native deploy.

## Global Constraints

- **Model:** `mlx-community/Chatterbox-Turbo-TTS-8bit` (config-swappable). Output native rate 24000 Hz.
- **Wire (live client path):** 48 kHz **OGG-Opus**, streamed. Never PCM on the gateway path. Byte-format-identical to Fish (web + Android + iOS decoders unchanged).
- **Ports:** WS `8770`, health `8771` (STT owns 8766–8769).
- **transformers pin:** `transformers>=5.5,<5.13` (mlx-lm 0.31 breaks on 5.13).
- **Service conventions (copy WhisperSTTService):** src-layout + `__main__.py`; `config.py` YAML→`@dataclass(frozen=True)`, fail-loud, `schema_version`; `event_logger.py` + `metrics.py` reused verbatim; host paths in `CHATTERBOX_TTS_*` env, tunables in YAML; bind `127.0.0.1`; graceful SIGTERM.
- **Clean-code (TS gateway):** files <300 lines, functions <40, no magic numbers (YAML config), tagged logger (no bare console), Result/typed errors at boundaries, AbortSignal honored (return, never throw).
- **Git:** branch `feature/local-tts-chatterbox`. `type(scope): desc` commits; end each with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commit after every task.
- **No dangling refs:** every deletion is followed by `bun run typecheck` + a grep proving zero remaining consumers before commit.
- **Prod is observational-only.** All validation on the local `deploy/macos` stack. No prod deploy without explicit per-action approval.

**Reference the spec** `docs/superpowers/specs/2026-07-08-local-chatterbox-tts-design.md` for rationale; §8 has the Fish-removal inventory, §14 the E2E matrix.

---

## File Structure

**New service** `capabilityServices/ChatterboxTTSService/`:
- `pyproject.toml`, `requirements.txt`, `CONTRACT.md`, `README.md`
- `config/config.example.yaml`
- `scripts/download_models.py`
- `src/chatterbox_tts/`: `__main__.py`, `config.py`, `server.py`, `wire_protocol.py`, `chatterbox_mlx.py`, `voice_store.py`, `pipeline_events.py`, `encoders/__init__.py`, `encoders/base.py`, `encoders/opus_encoder.py`, `encoders/pcm_encoder.py`, `event_logger.py` (copied), `metrics.py` (copied)
- `tests/`: one per module

**New gateway** `gateway/src/providers/tts/`: `local-tts-protocol.ts`, `local-tts-provider.ts` (+ tests); `gateway/src/tts/streaming-tts-synthesizer.ts` (renamed from `fish-audio-synthesizer.ts`); `gateway/src/api/handlers/voices.ts` (+ test).

**New webui** `gateway/webui/src/components/voices/`: `VoicesPanel.tsx`, `VoiceRecorder.tsx`, `VoiceList.tsx` + hook `use-voices.ts`.

**New deploy** `deploy/mac-prod/native/chatterbox-tts.sh`, `deploy/mac-prod/native/tts-backend.py`.

**Deletions:** see Tasks 12–14 (Fish + emotion-tagger + dead LLM provider).

---

## Phase 1 — Foundation service (streaming, one voice)

### Task 1: Service scaffold + config + copied logging/metrics

**Files:**
- Create: `capabilityServices/ChatterboxTTSService/{pyproject.toml,requirements.txt,README.md}`
- Create: `.../config/config.example.yaml`, `.../src/chatterbox_tts/{__init__.py,__main__.py,config.py}`
- Copy verbatim: `.../src/chatterbox_tts/event_logger.py`, `metrics.py` (from `capabilityServices/WhisperSTTService/src/whisper_stt/`)
- Test: `.../tests/test_config.py`

**Interfaces:**
- Produces: `load_config(path: str) -> Config` (frozen dataclass) with `.model`, `.server.host/port`, `.health.port`, `.default_format`, `.default_sample_rate`, `.streaming_interval`, `.exaggeration`, `.cfg_weight`, `.voice_dir`, `.log_dir`, `.retention_days`, `.metrics_interval_ms`, `.schema_version`. Fail-loud on any missing key.

- [ ] **Step 1: Read the template** `capabilityServices/WhisperSTTService/src/whisper_stt/config.py` and `config/config.example.yaml` to mirror the frozen-dataclass + fail-loud pattern exactly.

- [ ] **Step 2: Write the failing test** `tests/test_config.py`:
```python
import pytest
from chatterbox_tts.config import load_config

def test_loads_example_config(tmp_path):
    cfg = load_config("config/config.example.yaml")
    assert cfg.model == "mlx-community/Chatterbox-TTS-8bit" or "Chatterbox" in cfg.model
    assert cfg.server.port == 8770
    assert cfg.health.port == 8771
    assert cfg.default_format == "opus"
    assert cfg.default_sample_rate == 48000

def test_missing_key_fails_loud(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("schema_version: 1\n")
    with pytest.raises(Exception):
        load_config(str(p))
```

- [ ] **Step 3: Run — expect fail** `cd capabilityServices/ChatterboxTTSService && uv run pytest tests/test_config.py -v` → FAIL (module missing).

- [ ] **Step 4: Write** `pyproject.toml` (package `chatterbox_tts`, src-layout), `requirements.txt`:
```
mlx-audio
transformers>=5.5,<5.13
mlx
websockets>=13,<14
soundfile
soxr
opuslib
numpy
psutil
pyyaml
huggingface_hub
```
Copy `event_logger.py` + `metrics.py` from WhisperSTTService unchanged (only the module docstring service name differs). Write `config.py` mirroring WhisperSTTService: `@dataclass(frozen=True)` nested (`ServerCfg`, `HealthCfg`), `load_config` parses YAML, raises on missing key, no silent defaults. Write `config/config.example.yaml`:
```yaml
schema_version: 1
model: mlx-community/Chatterbox-TTS-8bit   # Turbo variant chosen at deploy via env override
server: { host: 127.0.0.1, port: 8770, max_message_bytes: 16777216 }
health: { port: 8771 }
default_format: opus          # opus | pcm
default_sample_rate: 48000
streaming_interval: 0.5       # seconds of audio per streamed chunk target
exaggeration: 0.5
cfg_weight: 0.5
voice_dir: ""                 # from CHATTERBOX_TTS_VOICE_DIR env if empty
log_dir: ""
retention_days: 7
metrics_interval_ms: 1000
```
(Model note: `chatterbox-turbo` repo id is `mlx-community/Chatterbox-Turbo-TTS-8bit`; set as the deployed default in the launchd env — Task 6. The example keeps a valid loadable id.)

- [ ] **Step 5: Run — expect pass.** Fix until green.

- [ ] **Step 6: Commit** `git add capabilityServices/ChatterboxTTSService && git commit -m "feat(tts-service): scaffold ChatterboxTTSService config + logging"`

---

### Task 2: `chatterbox_mlx.py` — model holder + streaming synth

**Files:**
- Create: `.../src/chatterbox_tts/chatterbox_mlx.py`
- Test: `.../tests/test_chatterbox_mlx.py` (marked `@pytest.mark.live` — loads the model)

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:
  - `class ChatterboxEngine`: `__init__(model_id: str, exaggeration: float, cfg_weight: float)`, `warm() -> None`, `synthesize(text: str, conds, streaming_interval: float, cancel: threading.Event) -> Iterator[np.ndarray]` yielding **24 kHz float32 PCM** chunks. `conds` is a mlx-audio `Conditionals` or `None` (built-in default voice).
  - `default_conditionals() -> object | None` — returns the model's built-in conds (loaded at model load).

- [ ] **Step 1: Read** the installed `mlx_audio/tts/models/chatterbox_turbo/chatterbox_turbo.py` (`generate(stream=True, streaming_interval, conds=…)` → `stream_generate` yielding `GenerationResult{audio, is_final_chunk}`). Mirror its streaming call.

- [ ] **Step 2: Write the failing `@live` test** `tests/test_chatterbox_mlx.py`:
```python
import numpy as np, threading, pytest
from chatterbox_tts.chatterbox_mlx import ChatterboxEngine

@pytest.mark.live
def test_streams_pcm_chunks():
    eng = ChatterboxEngine("mlx-community/Chatterbox-TTS-8bit", 0.5, 0.5)
    eng.warm()
    chunks = list(eng.synthesize("Hello there, this is a test.",
                                 eng.default_conditionals(), 0.5, threading.Event()))
    assert len(chunks) >= 1
    audio = np.concatenate(chunks)
    assert audio.dtype == np.float32
    assert len(audio) / 24000 > 0.5   # produced real audio
```

- [ ] **Step 3: Run — expect fail** `uv run pytest tests/test_chatterbox_mlx.py -v -m live`.

- [ ] **Step 4: Implement** `ChatterboxEngine`: `@lru_cache`-style module-level model holder via `mlx_audio.tts.utils.load_model(model_id)`; `warm()` runs one short synth of silence/short text to force weight load; `synthesize` calls `model.generate(text, conds=conds, exaggeration=…, cfg_weight=…, stream=True, streaming_interval=…)`, and for each `GenerationResult` does `mx.eval(r.audio)`, converts to `np.asarray(...).reshape(-1)` (float32), checks `cancel.is_set()` between chunks and returns early if set. `default_conditionals()` reads the model's built-in conds (the attribute the model sets from its `conds.safetensors` at load — confirm the exact attribute when reading the source in Step 1).

- [ ] **Step 5: Run — expect pass** (`-m live`).

- [ ] **Step 6: Commit** `feat(tts-service): Chatterbox MLX streaming engine`

---

### Task 3: Pluggable audio encoders (Opus default, PCM)

**Files:**
- Create: `.../src/chatterbox_tts/encoders/{__init__.py,base.py,opus_encoder.py,pcm_encoder.py}`
- Test: `.../tests/test_encoders.py`

**Interfaces:**
- Produces:
  - `base.py`: `class AudioEncoder(Protocol): def encode(self, pcm24k_chunks: Iterable[np.ndarray]) -> Iterator[bytes]`; `def make_encoder(format: str, target_rate: int) -> AudioEncoder` (raises `ValueError` on unknown format).
  - `OpusEncoder(target_rate)` → OGG-Opus pages (bytes). `PcmEncoder(target_rate)` → PCM16-LE bytes.
- Consumes: 24 kHz float32 chunks (Task 2).

- [ ] **Step 1: Write the failing test** `tests/test_encoders.py`:
```python
import numpy as np, soundfile as sf, io
from chatterbox_tts.encoders import make_encoder

def _tone(sec, sr=24000):
    t = np.linspace(0, sec, int(sec*sr), endpoint=False)
    return (0.2*np.sin(2*np.pi*220*t)).astype(np.float32)

def test_pcm_encoder_resamples_and_frames():
    enc = make_encoder("pcm", 48000)
    out = b"".join(enc.encode([_tone(0.5)]))
    # 0.5s @48k, 16-bit mono = 48000*0.5*2 bytes (± resampler edge)
    assert abs(len(out) - 48000*0.5*2) < 2000

def test_opus_encoder_produces_ogg_opus():
    enc = make_encoder("opus", 48000)
    out = b"".join(enc.encode([_tone(0.5)]))
    assert out[:4] == b"OggS"        # OGG container magic
    # decodes back to ~48k mono
    data, sr = sf.read(io.BytesIO(out))
    assert sr == 48000

def test_unknown_format_raises():
    import pytest
    with pytest.raises(ValueError):
        make_encoder("mp3", 48000)
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement.** `base.py` defines the Protocol + `make_encoder`. `PcmEncoder`: `soxr.resample(chunk, 24000, target_rate)` per chunk, `np.clip`→int16→`.tobytes()`. `OpusEncoder`: resample 24k→48k (Opus wants a valid rate; force 48000 for the live path), feed 20 ms frames (960 samples @48k) to `opuslib` encoder, wrap packets into an OGG-Opus stream (use `pyogg`/`ogg` paging or a minimal OGG page writer — confirm `soundfile`'s `libsndfile` OGG-Opus write support first: `sf.write(io.BytesIO, data, 48000, format="OGG", subtype="OPUS")` may be the simplest correct path; if libsndfile has Opus, prefer streaming via `sf.SoundFile` blocks). Pick whichever produces `OggS`-framed output the test decodes.

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit** `feat(tts-service): pluggable Opus/PCM audio encoders`

> **Verify item (spec §3):** OGG-Opus framing must match the webui `ogg-opus-decoder`. Task 18 smoke covers real client decode; if a page/granulepos mismatch appears there, fix in `opus_encoder.py`.

---

### Task 4: `voice_store.py` — voice-pack create/list/get/delete

**Files:**
- Create: `.../src/chatterbox_tts/voice_store.py`
- Test: `.../tests/test_voice_store.py` (`@live` for create — needs the model to build conds)

**Interfaces:**
- Consumes: `ChatterboxEngine`/model (for `prepare_conditionals`), `Config.voice_dir`.
- Produces:
  - `class VoiceStore(model, voice_dir: Path)`:
    - `get(voice_id: str | None) -> conds` — `None`/unknown → built-in default; else load `<voice_dir>/<voice_id>/conds.safetensors` (LRU-cached).
    - `create(ref_wav: np.ndarray, sr: int, name: str) -> dict` — runs `prepare_conditionals`, `Conditionals.save` atomically (temp→rename), writes `meta.json`, returns `{voiceId, name, createdAt}`.
    - `list() -> list[dict]`; `delete(voice_id: str) -> bool`.
  - `voice_id` = a generated slug (uuid4 hex).

- [ ] **Step 1: Read** `chatterbox_turbo.py` `Conditionals.save/load` + `prepare_conditionals` signatures (confirmed present in spec §3).

- [ ] **Step 2: Write failing tests** `tests/test_voice_store.py`: `test_list_empty`, `test_delete_missing_returns_false`, `test_get_default_when_none` (no model needed — pass a stub); plus `@live` `test_create_then_get_roundtrip` that builds a pack from a short tone wav, asserts `conds.safetensors` + `meta.json` exist and `list()` returns it.

- [ ] **Step 3: Run — expect fail.**

- [ ] **Step 4: Implement** with `uuid.uuid4().hex` ids, atomic save (`.tmp`→`os.replace`), `functools.lru_cache`-style dict for loaded conds, `meta.json` = `{name, createdAt, refDurationMs}`. `createdAt` via `time.time()` (allowed in the service; not a workflow script).

- [ ] **Step 5: Run — expect pass** (unit green; `-m live` for roundtrip).

- [ ] **Step 6: Commit** `feat(tts-service): voice-pack store (create/list/get/delete)`

---

### Task 5: `wire_protocol.py` + `server.py` — WS synth + health + `voice.*`

**Files:**
- Create: `.../src/chatterbox_tts/{wire_protocol.py,pipeline_events.py,server.py,__main__.py}`
- Create/Update: `CONTRACT.md`
- Test: `.../tests/test_wire_protocol.py`, `.../tests/test_server_ws.py` (uses `websockets` client against an in-process server; `@live` for real synth)

**Interfaces:**
- Consumes: `ChatterboxEngine` (T2), `make_encoder` (T3), `VoiceStore` (T4), `Config` (T1).
- Produces: WS server on `:8770`; sibling HTTP `/health` on `:8771` (copy WhisperSTTService `_run_health_server`). Message contract (spec §6): connect `?format=&sample_rate=&voice=`; C→S `{type:text|flush|end|cancel|ping}`, `{type:voice.create,name}`+binary wav, `{type:voice.list}`, `{type:voice.delete,voiceId}`; S→C `ready`, `{type:started,requestId}`, binary audio, `{type:done,requestId,ttfa_ms,rtf,audio_seconds}`, `{type:voice.created|voice.list|voice.deleted|error}`.

- [ ] **Step 1: Read** `WhisperSTTService/src/whisper_stt/server.py` (WS serve + query-param negotiation + sibling `/health` + `flush`/`cancel` handling) to mirror framing + graceful shutdown.

- [ ] **Step 2: Write failing `test_wire_protocol.py`** — pure (de)serialization: `parse_client_message(json_str)` → typed event; `encode_server_event(evt)` → json/binary. Assert round-trips for `text`, `voice.create`, `ready`, `done`.

- [ ] **Step 3: Write failing `test_server_ws.py`**: start server on an ephemeral port; a `websockets` client connects `?format=pcm&sample_rate=24000`, receives `ready` echoing those; sends `{type:"text","text":"hi"}`+`{type:"end"}`; `@live` asserts it receives `started` → ≥1 binary frame → `done` with `ttfa_ms>0`. A non-live test asserts `ready` negotiation + `ping`→`pong` + `voice.list` empty.

- [ ] **Step 4: Run — expect fail.**

- [ ] **Step 5: Implement** `wire_protocol.py` (dataclasses + parse/encode), `pipeline_events.py` (event types), `server.py`: `websockets.asyncio.serve`; per-connection: parse query, send `ready`; a background text buffer aggregated to sentences, fed to `ChatterboxEngine.synthesize`, piped through `make_encoder(format,rate)`, each encoded byte-chunk sent as a **binary** frame; emit `started`/`done` with metrics; `cancel`/WS-close sets the `threading.Event` and stops. Route `voice.*` messages to `VoiceStore` (binary wav frame buffered then `create`). Add sibling `/health` server (copy). `__main__.py` loads config from `CHATTERBOX_TTS_CONFIG_PATH`, builds engine+store, `warm()`, runs both servers, handles SIGINT/SIGTERM. Emit `chatterbox.synthesize` JSONL records (`ttfa_ms,rtf,audio_seconds,decode_ms,voice_id,format,sample_rate`). Write `CONTRACT.md` (fork STT's, document every message).

- [ ] **Step 6: Run — expect pass** (unit; `-m live` for synth).

- [ ] **Step 7: Commit** `feat(tts-service): WS synth server + health + voice.* control`

---

### Task 6: Deploy — `download_models.py`, launchd script, config rewriter

**Files:**
- Create: `.../scripts/download_models.py`
- Create: `deploy/mac-prod/native/chatterbox-tts.sh`
- Create: `deploy/mac-prod/native/tts-backend.py`
- Modify: `deploy/mac-prod/deploy.conf` (document TTS is native-only; no selector needed)

**Interfaces:**
- `tts-backend.py` rewrites `gateway/config.yaml`: `tts.url → ws://host.docker.internal:8770`, `companions.tts_health_url → http://host.docker.internal:8771/health` (comment-preserving via ruamel, mirror `stt-backend.py`).

- [ ] **Step 1: Read** `deploy/mac-prod/native/whisper-stt.sh` + `stt-backend.py` to clone structure exactly.

- [ ] **Step 2: Write** `chatterbox-tts.sh {install|start|stop|status|logs}`: LaunchAgent `io.dev32.sentient.chatterbox-tts`, `RunAtLoad`+`KeepAlive`; `brew install opus ffmpeg` preflight; `.venv` + `pip install -r requirements.txt`; seed `~/.sentient/chatterbox-tts/config/config.yaml` from example with `model: mlx-community/Chatterbox-Turbo-TTS-8bit`; plist env `CHATTERBOX_TTS_{CONFIG_PATH,MODEL_DIR,LOG_DIR,VOICE_DIR}`, `StandardOut/ErrPath`; `status` curls `:8771/health`. `download_models.py` warms the model (weights fetched by mlx-audio at runtime; built-in default voice ships with the repo — no extra pack).

- [ ] **Step 3: Write** `tts-backend.py` cloning `stt-backend.py`'s ruamel rewrite for the TTS keys above.

- [ ] **Step 4: Verify (no unit test — deploy scripts):** `bash -n chatterbox-tts.sh` and `python -c "import ast; ast.parse(open('tts-backend.py').read())"` both clean. `DRY_RUN`-style: `./chatterbox-tts.sh status` prints usage without side effects.

- [ ] **Step 5: Commit** `feat(deploy): native launchd ChatterboxTTS + config rewriter`

---

## Phase 2 — Gateway integration + complete Fish removal

### Task 7: `local-tts-protocol.ts` — message builders/parsers

**Files:**
- Create: `gateway/src/providers/tts/local-tts-protocol.ts`
- Test: `gateway/src/providers/tts/local-tts-protocol.test.ts`

**Interfaces:**
- Produces: `buildConnectUrl(base, {format,sampleRate,voice})`, `textMsg(text)`, `flushMsg()`, `endMsg()`, `cancelMsg()`, `parseServerFrame(data: string | ArrayBuffer): LocalTtsFrame` where `LocalTtsFrame = {kind:"ready"|"started"|"done"|"error", …} | {kind:"audio", data:Uint8Array}`.

- [ ] **Step 1: Read** `gateway/src/providers/tts/tts-types.ts` (`TTSAudioChunk`, lifecycle) + `fish-audio-protocol.ts` for the shape to mirror (minus MessagePack — ours is JSON text + raw binary).

- [ ] **Step 2: Write failing test** `local-tts-protocol.test.ts`: assert `buildConnectUrl("ws://h:8770",{format:"opus",sampleRate:48000,voice:"v1"})` → `ws://h:8770/?format=opus&sample_rate=48000&voice=v1`; `parseServerFrame` of a JSON `ready` → `{kind:"ready",…}` and of an `ArrayBuffer` → `{kind:"audio",data}`.

- [ ] **Step 3: Run — expect fail** `source scripts/env.sh && bun run test -- local-tts-protocol`.

- [ ] **Step 4: Implement** (pure functions, tagged logger not needed here).

- [ ] **Step 5: Run — expect pass. Step 6: Commit** `feat(gateway): local-tts WS protocol codec`

---

### Task 8: `local-tts-provider.ts` — `TTSProvider` WS client

**Files:**
- Create: `gateway/src/providers/tts/local-tts-provider.ts`
- Test: `gateway/src/providers/tts/local-tts-provider.test.ts` (mock WS)
- Reuse: `gateway/src/providers/tts/audio-chunk-queue.ts` (buffer pattern)

**Interfaces:**
- Consumes: T7 protocol; `TTSProvider`/`TTSAudioChunk` from `tts-types.ts`; `TTSConfig` (new local shape from T10).
- Produces: `createLocalTtsProvider(cfg, overrides?) : TTSProvider` — `warmup/ready/pushText/audioFrames/endInput/dispose`, yielding `TTSAudioChunk{encoding:"opus", sampleRate:48000, isFinal}`.

- [ ] **Step 1: Read** `fish-audio-provider.ts` in full — mirror its warmup→ready→pushText→audioFrames(drain queue)→endInput→dispose lifecycle and its `AudioChunkQueue` usage; swap MessagePack/Fish frames for T7 JSON+binary.

- [ ] **Step 2: Write failing test** using a fake WS (inject a socket factory): assert `warmup` opens the URL from `buildConnectUrl`; after a fake `ready`, `pushText("hi")` sends `textMsg`; feeding two binary frames then `done` makes `audioFrames()` yield two `TTSAudioChunk` then return; `dispose()` sends `cancelMsg` + closes. Assert **abort**: `audioFrames(abortedSignal)` returns without throwing.

- [ ] **Step 3: Run — expect fail.**

- [ ] **Step 4: Implement** mirroring Fish; inject the WS constructor for testability; honor `AbortSignal` (return, release buffers). One WS per run; `sampleRate` const 48000, `encoding "opus"` const.

- [ ] **Step 5: Run — expect pass. Step 6: Commit** `feat(gateway): local-tts TTSProvider (WS client)`

---

### Task 9: Generalize the Fish synthesizer → `streaming-tts-synthesizer.ts`

**Files:**
- Rename: `gateway/src/providers/tts/fish-audio-synthesizer.ts` → `gateway/src/tts/streaming-tts-synthesizer.ts`
- Modify: its imports/consumers; test rename accordingly.

**Interfaces:**
- Produces: `createStreamingTtsSynthesizer(provider: TTSProvider, opts): TextStreamSynthesizer` — keeps utterance aggregation + `FLUSH_SIGNAL` + background-producer/foreground-drain + abort. **Removes** the `emotionTags`/`tagIfEnabled` path entirely (that dies in Task 12).

- [ ] **Step 1: Read** `fish-audio-synthesizer.ts` + `text-stream-synthesizer.ts`. Identify the Fish-agnostic core (aggregation/drain/abort) vs the emotion-tag calls.

- [ ] **Step 2:** Move the file, rename the factory `createFishAudioSynthesizer`→`createStreamingTtsSynthesizer`, drop the `EmotionTaggerOptions`/`tagIfEnabled` import + call (leave a direct `provider.pushText(block)`), keep everything else. Update the test file (`utterance-aggregator.test.ts` stays; add/rename the synthesizer test).

- [ ] **Step 3: Run** `bun run typecheck` — expect breakage only at old import sites (fixed in T11). Run the synthesizer's own unit test → PASS.

- [ ] **Step 4: Commit** `refactor(gateway): generalize Fish synthesizer → streaming-tts-synthesizer`

---

### Task 10: TTS config schema — replace Fish keys with local keys

**Files:**
- Modify: `shared/config/src/schema.ts` (`ttsConfigSchema`), `shared/config/src/schema.test.ts`
- Modify: `gateway/config.yaml` `tts:` block + `companions.tts_health_url`
- Modify: `gateway/src/config/startup-config.ts` (`TTSYaml` alias)

**Interfaces:**
- Produces: new `TTSConfig` = `{url, default_voice, format:"opus"|"pcm", sample_rate, exaggeration, cfg_weight, connect_timeout_ms, idle_timeout_ms}`. No `provider`, `model_id`, `bitrate`, `latency`, `chunk_length_ms`, `emotion_tags`, `api_key`.

- [ ] **Step 1: Write the failing schema test** in `schema.test.ts`: parse a YAML with the new keys → ok; a YAML with old `provider: fish-audio` → **rejected** (unknown key, strict).

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement** the new `ttsConfigSchema` (drop Fish keys, add local keys per spec §12). Update `gateway/config.yaml tts:` to the §12 block + `companions.tts_health_url`. Update `startup-config.ts` alias/usages.

- [ ] **Step 4: Run schema test — pass.** `bun run typecheck` will still fail at Fish consumers (fixed T11/T14).

- [ ] **Step 5: Commit** `feat(config): local-tts config schema (drop Fish keys)`

---

### Task 11: Bootstrap factories → build `local-tts`

**Files:**
- Modify: `gateway/src/bootstrap/tts-factory.ts`, `gateway/src/bootstrap/content-tts-factory.ts`
- Modify tests: `gateway/src/config/gateway-config.test.ts` and any factory tests.

**Interfaces:**
- Produces: `createTtsService` builds `createLocalTtsProvider(cfg.tts)`; `createTextStreamSynthesizer` builds `createStreamingTtsSynthesizer(provider, …)`. Single provider (no branch). `resolveFishKey` removed; no secret needed (local has none).

- [ ] **Step 1: Read** both factories. Replace `createFishAudioProvider` → `createLocalTtsProvider`, `createFishAudioSynthesizer` → `createStreamingTtsSynthesizer`; delete `resolveFishKey` + the emotion-tag loading block in `content-tts-factory.ts` (the `fish-audio-emotion-tags-*.md` load + `EmotionTaggerOptions`).

- [ ] **Step 2: Update** factory/config tests to the local shape (no api-key gating; provider always constructed).

- [ ] **Step 3: Run** `bun run typecheck` + `bun run test -- tts-factory content-tts` → green for these.

- [ ] **Step 4: Commit** `feat(gateway): wire bootstrap factories to local-tts`

---

### Task 12: Remove the ENTIRE emotion-tagging decorator unit

**Files:**
- Delete: `gateway/src/tts/stages/emotion-tagger.ts`, `gateway/src/tts/stages/emotion-tagger-llm-types.ts`, the runtime prompt(s) `gateway/**/prompts/fish-audio-emotion-tags-*.md`
- Modify: any remaining importer (should be none after T9/T11); `gateway/src/tts/pipeline.ts` + `pipeline.test.ts` (drop emotion stage if referenced); `shared/config` emotion_tags already gone (T10).

- [ ] **Step 1: Grep** `grep -rn "emotion-tagger\|EmotionTagger\|tagIfEnabled\|tagBlocks\|emotion_tags\|fish-audio-emotion-tags" gateway shared` — enumerate every reference.

- [ ] **Step 2: Delete** the unit files + prompt files. Remove any remaining import/usage in `pipeline.ts`/tests (leave `markdown-stripper`, `emoji-stripper`, `utterance-aggregator`, `gateByChannel` untouched).

- [ ] **Step 3: Verify no dangling refs** `grep -rn "emotion" gateway/src | grep -iv "stt\|sensevoice\|paralingu" ` returns nothing TTS-related; `bun run typecheck` clean.

- [ ] **Step 4: Commit** `refactor(gateway): remove emotion-tagging decorator unit`

---

### Task 13: Remove the now-dead gateway LLM provider (verify-then-delete)

**Files:**
- Investigate then delete: `gateway/src/bootstrap/llm-factory.ts`, `gateway/src/providers/llm-types.ts`, the OpenRouter LLM provider file(s) it constructs, related config keys + tests.

- [ ] **Step 1: Prove it's dead.** `grep -rn "llm-factory\|createLlm\|LlmProvider\|llm-types\|openrouter" gateway/src | grep -v "\.test\."` — confirm the ONLY consumers were the emotion-tagger (now gone). If ANY live consumer remains (e.g. a tool, wizard, or MCP path), **STOP** — keep the provider and note it in the task's commit message. Hermes owns chat, so expect zero.

- [ ] **Step 2:** If dead: delete the files + their config keys (`shared/config`) + tests. If not dead: skip deletion, leave a comment documenting the remaining consumer.

- [ ] **Step 3: Verify** `bun run typecheck` clean; grep shows no dangling `llm-factory`/`llm-types` refs.

- [ ] **Step 4: Commit** `refactor(gateway): remove dead gateway LLM provider (emotion-tagger only consumer)` (or `chore: keep gateway LLM provider — still used by X`).

---

### Task 14: Remove Fish provider/protocol/catalog + secrets + wizard + deps

**Files (delete):** `gateway/src/providers/tts/fish-audio-provider.ts` (+`.test`), `fish-audio-protocol.ts` (+`.test`), `providers/catalogs/fish-fetcher.ts` (+`.test`).
**Files (modify):** `admin/secrets-store-schema.ts`, `admin/secrets-store.ts`, `api/handlers/secrets.ts` (+tests), `api/wizard/steps/voice.ts` (+test), `providers/catalogs/types.ts`, `profile-store/profile-types.ts` (keep `voice.id`, repurpose comment), `mcp-host/tools/update-user-settings.ts`, `person-session.ts`, `logging/format.ts`, `providers/tts/tts-types.ts` (drop Fish-only fields if any), `package.json` (drop `@msgpack/msgpack` if Fish-only), `gateway/config.yaml`.

- [ ] **Step 1: Full grep inventory** `grep -rniE "fish|msgpack|reference_id" gateway/src shared package.json` — list every hit; classify delete vs edit.

- [ ] **Step 2: Delete** the Fish provider/protocol/fetcher files + tests.

- [ ] **Step 3: Secrets/wizard:** remove `fish_audio` from `secrets-store-schema.ts` + `has/get/setFishAudioKey`, their impls in `secrets-store.ts`, the Fish branch in `api/handlers/secrets.ts`, and rework `wizard/steps/voice.ts` (drop Fish key entry + Fish voice fetch; voice selection now defaults to local `default` — cloning lives in the webui Voices panel, Task 16). Update each touched test.

- [ ] **Step 4: Misc consumers:** fix `catalogs/types.ts` (remove Fish voice catalog type), `update-user-settings.ts` / `person-session.ts` / `profile-types.ts` (keep `profile.voice.id`, drop Fish `reference_id` semantics), `logging/format.ts` (drop the Fish-key redaction pattern only if the key type is gone — keep generic redaction). Remove `@msgpack/msgpack` from `package.json` if grep shows only Fish used it; `bun install` to update lockfile.

- [ ] **Step 5: Verify** `grep -rniE "fish|reference_id" gateway/src shared` → **zero** (except historical comments you intentionally keep). `bun run typecheck` + `bun run lint` clean. `bun run test:unit` green (delete Fish-only tests that no longer pin a live contract).

- [ ] **Step 6: Commit** `refactor(gateway): remove Fish Audio provider, catalog, secrets, wizard step`

---

### Task 15: Gateway Voices REST API ↔ service `voice.*` proxy

**Files:**
- Create: `gateway/src/api/handlers/voices.ts` (+ `voices.test.ts`)
- Modify: the API router to mount it; `profile-store` write of `voice.id`.

**Interfaces:**
- Produces (auth'd, per-user): `POST /api/.../voices` (multipart audio + name) → opens a mgmt WS to `cfg.tts.url`, sends `voice.create`+binary, awaits `voice.created`, writes `profile.voice.id`, returns `{voiceId,name}`. `GET /api/.../voices` → `voice.list`. `DELETE /api/.../voices/:id` → `voice.delete` (+ clear `profile.voice.id` if it matched).

- [ ] **Step 1: Read** an existing gateway API handler (e.g. `api/handlers/profile.ts`) for the auth + router + Result-error pattern, and `local-tts-protocol.ts` (T7) for the mgmt messages.

- [ ] **Step 2: Write failing test** `voices.test.ts` with a mock service WS: POST multipart → asserts a `voice.create` frame + binary sent, and on `voice.created` the handler writes `profile.voice.id` and returns 200 `{voiceId}`. DELETE clears profile when it matches.

- [ ] **Step 3: Run — expect fail.**

- [ ] **Step 4: Implement** the handler (short-lived mgmt WS per request; timeout-bounded; typed errors; tagged logger; never log audio bytes). Mount in the router.

- [ ] **Step 5: Run — expect pass. Step 6: Commit** `feat(gateway): voices REST API proxying service voice.* control`

---

## Phase 3 — Web cloning UX

### Task 16: webui Voices panel (record/upload/list/select/delete)

**Files:**
- Create: `gateway/webui/src/components/voices/{VoicesPanel.tsx,VoiceRecorder.tsx,VoiceList.tsx}`, `gateway/webui/src/hooks/use-voices.ts`
- Modify: settings route to mount `VoicesPanel`.
- Test: component tests via existing webui test setup (vitest + jsdom + RTL); use `bun run test` (vitest), not `bun test`.

**Interfaces:**
- Consumes: gateway Voices REST (T15). Uses `createLogger(["sentient","webui","voices"])` from `@sentient/web-sdk`.
- Produces: record (MediaRecorder, 10–15 s guided) or file upload → `POST /voices` → list refresh → set-active (writes profile) → delete (confirm).

- [ ] **Step 1: Read** an existing webui settings component + a hook that calls the gateway API, to match state-binding + logger conventions (no bare console; all UX binds to gateway/SDK state).

- [ ] **Step 2: Write failing component test** (`use-voices.ts` hook): mock fetch; `createVoice(blob,name)` posts multipart and refreshes list; `deleteVoice(id)` removes it. One component test: empty state renders "No voices", list renders names + active marker.

- [ ] **Step 3: Run — expect fail** `source scripts/env.sh && bun run test -- voices`.

- [ ] **Step 4: Implement** hook + components (one public component per file; co-locate previews/helpers; MediaRecorder capture → webm/wav blob → multipart). Guard mic-permission + short-clip errors with typed UI messages.

- [ ] **Step 5: Run — expect pass. Step 6: Commit** `feat(webui): voice cloning panel (record/upload/manage)`

---

## Phase 4 — Reuse hook, deploy verify, E2E

### Task 17: PCM negotiation path (reuse primitive)

**Files:** exercised via `capabilityServices/ChatterboxTTSService/tests/test_server_ws.py` (extend).

- [ ] **Step 1: Add `@live` test:** connect `?format=pcm&sample_rate=24000`, synth "hello", assert `ready` echoes pcm/24000, binary frames decode as PCM16, `done.sample_rate==24000`. Confirms the service is reusable (audiobook path) without touching the live gateway.

- [ ] **Step 2: Run — expect pass** (implementation already exists from T3/T5). **Step 3: Commit** `test(tts-service): PCM output negotiation`

---

### Task 18: E2E smoke against the local stack (spec §14 matrix)

**Files:** evidence under the Playwright/Maestro output dirs; extend `agents/docs/testing-knowledge.md` with new reusable TTS cases.

**Pre:** boot local stack (`deploy/macos`), run ChatterboxTTS natively (`chatterbox-tts.sh install && start`), point gateway config via `tts-backend.py`, rebuild/restart gateway.

- [ ] **Step 1 (web, Playwright MCP):** desktop 1280×900 + mobile 390×844 — speak happy path (audio streams, `connector.audio.start encoding=opus sampleRate=48000`→`.done`, `chatterbox.synthesize rtf<1`, no WARN/ERROR); barge-in (audio stops, service `cancel`, buffers freed); UI Stop; clone-a-voice → speak in it → delete → reverts to default; reject bad clip; **service-down → text-only** (stop the service, send a msg, assert reply renders as text, WARN `tts-unreachable`, no crash).
- [ ] **Step 2 (mobile parity, Maestro):** Android + iOS sims — assistant replies, **audio decodes/plays natively** (the top risk, spec §13); grep logcat/os_log for opus decode errors → none.
- [ ] **Step 3:** capture evidence (screenshots/console/network + log trail) at each decision point. A case is green only when user-visible behavior AND the log trail match.
- [ ] **Step 4:** record new reusable cases in `agents/docs/testing-knowledge.md`.
- [ ] **Step 5: Commit** `test(e2e): local Chatterbox TTS smoke (web + mobile)` + any knowledge-base update.

> If the mobile Opus decode diverges (framing mismatch), fix `encoders/opus_encoder.py` OGG paging (spec §3 verify item) and re-run — do not ship around it.

---

## Self-Review (author checklist — completed)

**Spec coverage:** §5 service internals → T1–T5; §6 wire → T5; §7 cloning → T4,T15,T16; §8 gateway+Fish removal → T7–T14; §9 web UI → T16; §10 error/abort → T2,T5,T8 (abort), T11/T18 (degrade); §11 deploy → T6; §12 config → T10; §13 risks → T18 (mobile parity), T3 (opus framing); §14 E2E → T18; §15 phasing → task order; reuse/PCM → T3,T17. No uncovered section.

**Placeholder scan:** no TBD/"handle edge cases"/"similar to Task N"; each task has real test + impl + verify commands. Two spots intentionally say "confirm the exact attribute/signature when reading the installed source" (T2 default conds, T5 framing) — these are *read-the-source* steps, not placeholders, because the attribute name lives in third-party code the implementer must open.

**Type consistency:** `ChatterboxEngine.synthesize`/`default_conditionals` (T2) consumed by T5; `make_encoder(format,target_rate)` (T3) consumed by T5; `VoiceStore.get/create/list/delete` (T4) consumed by T5/T15; `createLocalTtsProvider` (T8) consumed by T11; `createStreamingTtsSynthesizer` (T9) consumed by T11; `voice.*` frames (T7) consumed by T8/T15. Names consistent across tasks.
