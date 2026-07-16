# Local Chatterbox-Turbo TTS — native MLX TTS service + gateway drop-in + web voice cloning (design)

**Date:** 2026-07-08
**Branch:** `feature/local-tts-chatterbox`
**Status:** approved design → implementation planning

## 1. Goal

Replace paid cloud **Fish Audio** with a **local, private** MLX text-to-speech
service on the Mac mini, built around **Chatterbox-Turbo (8-bit)** — the winner of
the `pocs/localTTS/` bake-off (fast enough to stream, top clone quality, zero
tuning). v1 delivers, in one spec:

1. A native launchd MLX service `capabilityServices/ChatterboxTTSService/`
   (WS `:8770` + health `:8771`), mirroring the existing native
   `WhisperSTTService` shape.
2. A gateway `local-tts` provider that is a **byte-format drop-in** for Fish
   (48 kHz OGG-Opus to every client), and **complete removal** of all Fish code.
3. **Per-user voice cloning managed in the web UI**: record/upload a reference
   clip → the service builds and persists a voice pack → select/list/delete.

The service's output codec + sample rate are **negotiable** (default opus@48k)
so the same service is reusable by future consumers (e.g. audiobook generation
that wants raw PCM).

## 2. Why these choices (settled, not to re-litigate)

- **Model: `mlx-community/Chatterbox-Turbo-TTS-8bit`** (config-swappable).
  Benchmark-settled in `pocs/localTTS/RESULTS.md` (M3 Pro; mini ≈ ×1.3):
  - Cloning RTF **0.28** (mini ≈ 0.36) → ~2.8× realtime headroom, streams smooth;
    per-sentence first-audio ≈ 0.72 s on the mini — within the ~1 s budget.
  - Turbo distills the diffusion decoder 10→1 step → ~3× faster than standard
    Chatterbox. **8-bit is faster than fp16** for Turbo (MLX quant is
    arch-dependent) and half the RAM (~1.4 GB).
  - Quality: Resemble's blind test preferred Turbo over ElevenLabs; expressive,
    zero tuning (Qwen3-TTS had a higher paper ceiling but needs seed-pinning /
    trimming / per-language tuning — rejected for a family assistant).
- **Native launchd, not Docker.** Docker on macOS has no Metal passthrough; a
  containerized Chatterbox would be CPU-only. The service runs natively on the
  host exactly like `WhisperSTTService`; the containerized gateway dials it at
  `host.docker.internal:8770` (already enabled by compose `extra_hosts`).
- **Opus encoding lives in the Python service.** Chatterbox emits 24 kHz PCM;
  the wire contract is **48 kHz OGG-Opus** (what Fish emitted, what every client
  decoder — web `ogg-opus-decoder`, Android, iOS — is validated against). The
  service resamples 24k→48k and Opus-encodes with `opuslib` (already in the STT
  native stack). Producing byte-format-identical 48k OGG-Opus means **zero
  client changes** and the gateway passes bytes through untouched.
- **Opus on the wire, never PCM (for the gateway path).** PCM@48k ≈ 768 kbps raw
  vs Opus ~32 kbps → ~24× the bytes = radio/battery cost on mobile. The negotiable
  PCM option (below) is for *other* consumers, never the live client path.
- **Remove Fish entirely — no selector, no fallback.** `local-tts` is the sole
  TTS. Keeping a paid cloud fallback was rejected: the user wants Fish gone, and a
  dead fallback is throwaway code. If the local service is down the gateway
  degrades to **text-only** (existing null-synthesizer path), not to Fish.
- **Output codec/rate is negotiable, default opus@48k.** Future-proofs the
  service as a reusable TTS primitive. The terminal encoder is a pluggable unit;
  the gateway always requests the default, so this costs the live path nothing.

## 3. Investigation findings (resolved)

Three parallel investigations (see this session) closed the open questions:

**Chatterbox Turbo (installed mlx-audio 0.4.4 source):**
- **Streams natively.** `generate(stream=True, streaming_interval=2.0)` delegates
  to `stream_generate`, yielding `GenerationResult{audio: mx.array, sample_rate,
  is_streaming_chunk, is_final_chunk}` incrementally (chunk ≈ `interval×25`
  tokens). So real TTFA is first-chunk, not whole-clip.
- **Voice packs are first-class.** `Conditionals.save(path)` / `.load(path)` →
  `conds.safetensors`; `conds` kwarg on `generate`; `prepare_conditionals`
  builds them from a reference clip. Compute once, persist, reuse.
- **Output = 24000 Hz** (`S3GEN_SR`); reference cloning wants `ref_audio` (array,
  `sample_rate`) — packs remove the per-utterance encode cost.

**Gateway TTS contract (`gateway/src/…`):**
- Drop-in seams: high-level `TextStreamSynthesizer.synthesize(AsyncIterable<
  TtsChunk>, AbortSignal) → AsyncIterable<AudioFrame>` and low-level `TTSProvider`
  (`warmup/ready/pushText/audioFrames/endInput/dispose`).
- `AudioFrame{data: Uint8Array, encoding, sampleRate}`; `TtsChunk = string |
  FLUSH_SIGNAL`.
- Fish = raw WS + MessagePack to cloud, emitting **OGG-Opus @ 48 kHz**; gateway
  passes bytes through byte-for-byte; webui decoder hardcodes OGG-Opus→48k.
- `tts.provider` is validation-only (nothing branches on it). Wiring is
  Fish-hardcoded in `bootstrap/tts-factory.ts` + `bootstrap/content-tts-factory.ts`.

**Native deploy convention (`WhisperSTTService` + `deploy/mac-prod/native/`):**
- src/ layout + `__main__.py`; `config.py` YAML→frozen-dataclass, fail-loud;
  `server.py` = `websockets.asyncio.serve` + sibling HTTP `/health`; per-connection
  negotiation via URL query params echoed on `ready`; `flush`/`cancel` controls.
- Deploy = `native/whisper-stt.sh {install|start|stop|status|logs}`, LaunchAgent
  `RunAtLoad`+`KeepAlive`, `brew` preflight, venv, data under `~/.sentient/<svc>/`.
- `deploy.conf` backend selector + `native/<svc>-backend.py` config-rewriter;
  weights pulled at runtime from HF, cached under `~/.cache/huggingface`.
- Reuse **verbatim**: `event_logger.py` (dual `ts`/`t_mono_ns`, JSONL, rotation,
  retention prune), `metrics.py` (psutil 1 Hz sampler).

**Ports:** STT owns 8766–8769. TTS takes **8770 (WS) + 8771 (health)**.

**Open verify items (carried into the plan, not assumed):**
- Confirm the **web + Android + iOS** Opus decoders cleanly play a service-produced
  48k OGG-Opus sample (byte-format parity with Fish). Smoke each surface.
- Confirm `opuslib` OGG-Opus framing matches `ogg-opus-decoder`'s expected
  container (pages/granulepos), not just raw Opus packets.

## 4. Architecture

```
  web / Android / iOS client
        ▲ 48k OGG-Opus (binary WS frames)  ▲ clone UI (web only)
        │                                  │
  ┌─────┴──────────────────────────────────┴───────────────┐
  │  Gateway (Docker)                                       │
  │   local-tts-provider ──► streaming-tts-synthesizer      │
  │   voices REST (webui) ──► WS voice.* proxy ──────┐      │
  └───────┬─────────────────────────────────────────┼──────┘
          │ ws://host.docker.internal:8770 (audio)   │ ws :8770 (voice.*)
          ▼ (text deltas → audio frames)             ▼
  ┌───────────────────────────────────────────────────────┐
  │  ChatterboxTTSService (native, host)                   │
  │   server.py (WS + /health)                             │
  │   chatterbox_mlx.py  ── Chatterbox-Turbo-8bit (MLX)    │
  │   voice_store.py     ── conds.safetensors per voiceId  │
  │   encoders/  ── OpusEncoder (default) | PcmEncoder      │
  │   ~/.sentient/chatterbox-tts/{voices,logs,models}      │
  └───────────────────────────────────────────────────────┘
```

Three isolated units; each testable alone; interfaces at every boundary.

## 5. Service internals (`capabilityServices/ChatterboxTTSService/`)

Directory mirrors `WhisperSTTService`: `src/chatterbox_tts/` (src-layout,
`__main__.py`), `config/config.example.yaml`, `scripts/download_models.py`,
`pyproject.toml` + `requirements.txt`, `CONTRACT.md`, `README.md`, `tests/`.

Modules:
- `server.py` — `websockets.asyncio.serve` on `:8770`; sibling asyncio HTTP
  `/health` on `:8771` (`{status, version}`); per-connection synth task; graceful
  SIGINT/SIGTERM; models loaded + `warm()`ed at boot, fail-closed.
- `config.py` — YAML→`@dataclass(frozen=True)`, `schema_version`, fail-loud on
  missing keys; host paths from env (`CHATTERBOX_TTS_*`), tunables from YAML.
- `chatterbox_mlx.py` — model-holder (`@lru_cache`) wrapping Chatterbox-Turbo-8bit;
  `warm()` decodes a short prompt at boot; `synthesize(text_stream, voice_conds,
  cancel) → yields 24k PCM chunks` via `stream_generate`.
- `voice_store.py` — LRU cache of loaded `Conditionals`; `get(voiceId)` loads
  `~/.sentient/chatterbox-tts/voices/<voiceId>/conds.safetensors`; `create(ref_wav,
  name) → voiceId` runs `prepare_conditionals` + `Conditionals.save` (atomic:
  temp→rename) + writes `meta.json`; `list()`, `delete(voiceId)`. The **default**
  voice is the model's own built-in `conds.safetensors` (shipped in the model
  repo, loaded at model load) — no separately-authored pack needed.
- `encoders/` — `AudioEncoder` protocol (`encode(pcm24k_stream, target_rate) →
  yields bytes`); `opus_encoder.py` (resample 24→target via soxr, `opuslib` →
  OGG-Opus pages) and `pcm_encoder.py` (resample → PCM16 LE). Terminal
  decorator-unit; respects cancel.
- `wire_protocol.py` — JSON control (de)serialization + binary framing.
- `event_logger.py`, `metrics.py` — copied verbatim from `WhisperSTTService`.
  Per-request record `chatterbox.synthesize` with `ttfa_ms, rtf, audio_seconds,
  decode_ms, voice_id, format, sample_rate`.

`requirements.txt`: `mlx-audio` (+ pinned `transformers>=5.5,<5.13` — mlx-lm 0.31
breaks on 5.13, see `pocs/localTTS`), `mlx`, `websockets>=13,<14`, `soundfile`,
`soxr`, `opuslib`, `numpy`, `psutil`, `pyyaml`, `huggingface_hub`.
`brew install opus ffmpeg` preflight (opuslib loads libopus via ctypes).

## 6. Wire protocol (`CONTRACT.md`)

WebSocket `ws://127.0.0.1:8770` (native bind localhost; gateway reaches via
`host.docker.internal`). Binary frames = audio; text frames = JSON keyed by
`type`. Mirrors the STT contract's "binary=payload, text=control" split.

**Connect (query params, echoed on `ready`):**
`?format=opus|pcm&sample_rate=48000&voice=<voiceId>` (all optional; defaults
opus / 48000 / configured default voice).

**Client → server:**
- `{type:"text", text}` — incremental delta (may be sent many times).
- `{type:"flush"}` — synthesize buffered text now (sentence boundary).
- `{type:"end"}` — no more text; finish + close after drain.
- `{type:"cancel"}` — abort current synthesis immediately.
- `{type:"ping"}` → `pong`.

**Server → client:**
- `ready` (first frame; echoes `format`, `sample_rate`, `voice`).
- `{type:"started", requestId}` on first synthesized utterance.
- **binary audio frames** (OGG-Opus pages or PCM16), streamed.
- `{type:"done", requestId, ttfa_ms, rtf, audio_seconds}`.
- `{type:"warning"|"error", reason}`.

**Voice management (WS control messages, dedicated non-synth connection):**
The service speaks WS+binary already, so avoid a hand-rolled multipart HTTP server
(the `:8771` HTTP responder stays health-only, like STT). On a management
connection:
- `{type:"voice.create", name}` + one binary wav frame (10–15 s) → `{type:
  "voice.created", voiceId, name}`.
- `{type:"voice.list"}` → `{type:"voice.list", voices:[{voiceId,name,createdAt}]}`.
- `{type:"voice.delete", voiceId}` → `{type:"voice.deleted", voiceId}`.
The **webui** talks REST to the **gateway** (which owns an HTTP framework); the
gateway translates each REST call into these WS messages to the service.

## 7. Voice-pack cloning flow

- **Storage: service-owned.** `~/.sentient/chatterbox-tts/voices/<voiceId>/`
  holds `conds.safetensors` + `meta.json` (`name`, `createdAt`, `refDurationMs`).
  The service is the single voice authority; packs never leave the host.
- **Identity:** `profile.json#voice.id` stores the `voiceId` string (per-user
  selection, same slot Fish used for `reference_id`). The gateway passes
  `voice=<voiceId>` on the synth WS; unknown/missing → configured default.
- **Create:** webui records/uploads a clip → **gateway** `POST /api/.../voices`
  (auth'd, multipart) → gateway opens a management WS to the service, sends
  `voice.create` + the binary wav → service builds + persists pack → `voice.created`
  → gateway writes `profile.voice.id` + returns `{voiceId}` to webui. Build is a
  one-time ~seconds `prepare_conditionals` pass.
- **Select / list / delete:** gateway REST proxies `voice.list`/`voice.delete`;
  delete also clears `profile.voice.id` if it pointed there (→ default).

## 8. Gateway integration + Fish removal surface

**Add:**
- `gateway/src/providers/tts/local-tts-provider.ts` — `TTSProvider` impl: WS
  client to `cfg.tts.url`, `warmup` (open WS + connect params), `ready`,
  `pushText`→`{type:"text"}`, `endInput`→`{type:"end"}`, `audioFrames` drains
  binary frames → `TTSAudioChunk{encoding:"opus", sampleRate:48000}`, `dispose`
  → `{type:"cancel"}`+close. Reuse the `AudioChunkQueue` buffer pattern.
- `gateway/src/providers/tts/local-tts-protocol.ts` — the small JSON message
  builders/parsers.
- Voices API proxy (list/create/delete) under the existing gateway API tree.

**Generalize (keep the logic, drop the Fish name/specifics):**
- `fish-audio-synthesizer.ts` → `streaming-tts-synthesizer.ts`: keep utterance
  aggregation / `FLUSH_SIGNAL` / abort / background-producer-foreground-drain;
  it only depends on the abstract `TTSProvider`, so it drives `local-tts`
  unchanged. Remove the Fish emotion-LLM tagging step.

**Delete (complete Fish removal):**
- `fish-audio-provider.ts`, `fish-audio-protocol.ts`, the old
  `fish-audio-synthesizer.ts` name, `FISH_AUDIO_URL`.
- `shared/config` `ttsConfigSchema` Fish keys (`provider` literal, `model_id`,
  `bitrate`, `latency`, `chunk_length_ms`, emotion-tags block) → replaced by
  local keys (§12). `gateway/config.yaml tts:` block rewritten.
- Fish secret handling: wizard voice-key step, `SecretsStore.getFishAudioKey*`,
  `FISH_AUDIO_API_KEY` env usage.
- `@msgpack/msgpack` dependency if Fish was its only user.
- Bootstrap factories updated to build `local-tts` (no branch — single provider).

**Fish-removal inventory (careful — no dangling refs; delete + fix every consumer):**
- **TTS core:** `providers/tts/fish-audio-{provider,protocol,synthesizer}.ts`
  (+ `.test.ts`); `providers/catalogs/fish-fetcher.ts` (+test) — Fish voice-catalog
  fetch, replaced by the local voices list.
- **Emotion-tagging = delete the ENTIRE decorator unit** (per user): `tts/stages/
  emotion-tagger.ts`, `tts/stages/emotion-tagger-llm-types.ts`, the runtime prompt
  `prompts/fish-audio-emotion-tags-<lang>.md`, the `emotion_tags` config block, and
  every call site (`bootstrap/content-tts-factory.ts` wiring, `fish-audio-
  synthesizer`'s `tagIfEnabled`). Leave the rest of the text-stage chain
  (`markdown-stripper`, `emoji-stripper`, `utterance-aggregator`, `gateByChannel`)
  **untouched**.
- **Gateway LLM-provider cascade:** the emotion-tagger is (per `llm-factory.ts`
  comment "Hermes owns chat") the sole consumer of the gateway-side LLM provider.
  After the unit is gone, **verify no other consumer** of `bootstrap/llm-factory.ts`
  / `providers/llm-types.ts` / the OpenRouter LLM provider + its config, then remove
  them too. This is a verify-then-delete task, not a blind delete.
- **Secrets / wizard:** `admin/secrets-store-schema.ts` (`fish_audio`,
  `has/get/setFishAudioKey`), `admin/secrets-store.ts` impls, `api/handlers/
  secrets.ts` Fish branch, `api/wizard/steps/voice.ts` (Fish key + voice pick →
  reworked to local default/clone entry).
- **Config / profile / misc:** `shared/config/src/schema.ts` `ttsConfigSchema` Fish
  keys, `gateway/config.yaml tts:` block; review `profile-store/profile-types.ts`
  (keep `voice.id`, repurpose to local voiceId), `mcp-host/tools/update-user-
  settings.ts`, `person-session.ts`, `providers/catalogs/types.ts`, `logging/
  format.ts` (Fish-key redaction pattern), and drop `@msgpack/msgpack` if Fish was
  its only user.
- **Tests:** update/remove every `*.test.ts` that references Fish (the grep lists
  them); keep only tests that still pin a live contract post-removal.

**Expressiveness after removal:** Chatterbox is native-expressive via
`exaggeration` + `cfg_weight` (exposed as config, tuned once) — so dropping the
emotion-tagger loses no capability, it swaps an LLM-text-markup hack for real model
params.

**Client parity:** all three clients receive byte-identical 48k OGG-Opus → no
webui / Android / iOS code changes (subject to the §3 verify items).

## 9. Web UI (webui only)

Settings → **Voices** panel:
- Record (mic, 10–15 s guided) **or** upload a clip; name it; "Create voice" →
  progress → appears in list; set active.
- List existing voices (name, created); set-active; delete (with confirm).
- Uses `createLogger` from `@sentient/web-sdk`; all state binds to gateway/SDK
  responses (no ad-hoc local truth). One component per file; previews co-located.

## 10. Error handling / abort / degraded path

- **Barge-in / interrupt:** gateway `bargeInController`/`interruptController` abort
  → provider `dispose()` closes WS → service detects close (or `{type:"cancel"}`)
  → stops consuming `stream_generate`, drops buffers, **returns without throwing**
  (decorator-unit abort rule).
- **Service down / transient:** provider `start()`/`warmup` resolves without
  throwing on connection refused; the synth path yields nothing → gateway uses the
  existing **text-only** degrade (null synthesizer). No Fish fallback.
- **Cloning failures** (bad/short audio, encode error): service returns
  `{type:"error", reason}` / HTTP 4xx; gateway surfaces a typed error to webui;
  no partial pack persisted (write conds atomically: temp → rename).
- Fail-loud config; every external call timeout-bounded; log sanitizer on all
  output (never log raw audio — `_json_default` already bytes-elides).

## 11. Deploy

- `deploy/mac-prod/native/chatterbox-tts.sh {install|start|stop|status|logs}`
  (clone `whisper-stt.sh`): LaunchAgent `io.dev32.sentient.chatterbox-tts`,
  `RunAtLoad`+`KeepAlive`; `brew install opus ffmpeg` preflight; `.venv` +
  `pip install -r requirements.txt`; seed config; warm model weights (built-in default voice ships with the model repo);
  plist with `CHATTERBOX_TTS_{CONFIG_PATH,MODEL_DIR,LOG_DIR,VOICE_DIR}`,
  `StandardOut/ErrPath` under the data dir. Data root `~/.sentient/chatterbox-tts/`.
- `deploy.conf`: no docker fallback (native-only). `native/tts-backend.py`
  rewrites gateway config: `tts.url → ws://host.docker.internal:8770`,
  `companions.tts_health_url → http://host.docker.internal:8771/health`.
- **RAM budget (M4 16 GB):** Chatterbox-Turbo-8bit ≈ 1.4 GB + warm voice-pack LRU;
  coexists with native Whisper (~1.3 GB) + Docker stack. Watch peak under
  concurrent STT+LLM+TTS (a Phase-2 on-mini load test, per `pocs/localTTS`).
- Migration: install service + default pack, flip `tts-backend.py`, restart
  gateway, remove Fish key from wizard/secrets. **Prod deploy is a separate
  explicit approval** (observational-only rule); all validation on the local stack
  first.

## 12. Config keys (`gateway/config.yaml tts:` — post-Fish)

```yaml
tts:
  url: ws://host.docker.internal:8770   # native ChatterboxTTS WS
  default_voice: default                 # voiceId when profile has none
  format: opus                           # opus | pcm  (live path = opus)
  sample_rate: 48000                     # Hz
  exaggeration: 0.5                      # Chatterbox expressiveness (0–1)
  cfg_weight: 0.5                        # reference adherence
  connect_timeout_ms: 3000
  idle_timeout_ms: 30000
companions:
  tts_health_url: http://host.docker.internal:8771/health
```

Service `config.yaml`: `model`, `default_format`, `default_sample_rate`, ports,
`streaming_interval`, `voice_dir`, `retention_days`, `metrics_interval_ms`.

## 13. Risks / open items

- **Mobile Opus parity** — the top risk. Verify Android + iOS SDK decoders play a
  service sample identically to Fish before declaring drop-in (§3). If a
  container-framing mismatch appears, align `opuslib` OGG paging to
  `ogg-opus-decoder`.
- **On-mini RTF under load** — bench was idle M3 Pro ×1.3. Real mini runs TTS
  while STT+LLM compete for GPU; confirm RTF stays <1 with headroom.
- **No fallback** — accepted; degraded = text-only. Monitor service health.
- **Emotion regression** — moving from Fish emotion-markup to Chatterbox params;
  tune `exaggeration`/`cfg_weight` once and A/B by ear.

## 14. E2E test matrix (inline)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Speak happy path | desktop 1280×900 | service up, default voice | send a chat msg, assistant replies | audio plays, streamed, no gaps | `chatterbox.synthesize` rtf<1; gateway `connector.audio.start encoding=opus sampleRate=48000`→`.done`; no WARN/ERROR |
| Speak happy path | mobile 390×844 | service up | same | audio plays on mobile viewport | same |
| Barge-in mid-speech | desktop | assistant speaking | user starts talking (mic onset) | audio stops promptly, cycle aborts | provider `dispose`; service `cancel`→stream stopped, buffers freed; no `.done` |
| UI Stop | desktop | assistant speaking | click Stop | audio stops, task cancel routed | interrupt abort; no throw |
| Clone a voice | desktop | Voices panel, mic allowed | record 12 s, name, Create | voice appears, set active | gateway `POST /voices`→service `prepare_conditionals`; `conds.safetensors` written; meta.json |
| Speak with cloned voice | desktop | cloned voice active | send chat msg | reply in cloned voice | synth `voice_id=<new>`; pack loaded from cache |
| Delete active voice | desktop | cloned voice active | delete it, confirm | reverts to default voice | `DELETE /voices`; `profile.voice.id` cleared→default |
| Reject bad clip | desktop | Voices panel | upload 1 s / silent clip | typed error, no voice created | service 4xx `reason`; no partial pack |
| Service down | desktop | TTS service stopped | send chat msg | reply as **text only**, no crash | provider warmup non-throw; null-synth degrade; WARN reason=tts-unreachable |
| Mobile decode parity | Android + iOS (Maestro) | service up | assistant replies | audio plays natively | mobile SDK opus decode ok; no decode error in logcat/os_log |
| PCM output (reuse) | n/a (curl) | service up | connect `?format=pcm&sample_rate=24000`, synth | valid PCM16 stream | `chatterbox.synthesize format=pcm sample_rate=24000` |

Reusable case names (barge-in, reconnect, empty-state) reference
`agents/docs/testing-knowledge.md`; new TTS cases get indexed there. Mobile
cases via Maestro (native), web via Playwright MCP; all against the **local**
`deploy/macos` stack, never prod.

## 15. Build phasing (one spec, sequenced execution)

Though a single spec, implement + verify in this order to de-risk:
1. **Foundation** — service (streaming, opus encoder, default voice) + gateway
   `local-tts` provider + Fish removal + deploy/launchd. Green: speak/barge-in/
   service-down + mobile parity.
2. **Cloning backend** — `voice_store`, `POST/GET/DELETE /voices`, gateway proxy,
   `profile.voice.id` wiring. Green: clone/select/delete/reject cases.
3. **Cloning UX** — webui Voices panel. Green: full web clone flow.
4. **Reuse hook** — PCM encoder path + negotiation test.

Each phase ends lint+typecheck+unit clean, its smoke cases green, deployable
artifact built (pre-handover gate).
