# Chatterbox-TTS Service

Local text-to-speech as a **native Apple-Silicon service** (Mac mini prod), sibling to
[`WhisperSTTService`](../WhisperSTTService/). Wraps Chatterbox-Turbo (MLX) into a
WebSocket service that accepts text and streams back synthesized audio. MLX runs on
the Metal GPU, so this service is **Apple-Silicon only** — it does not run on
Linux/x86.

The gateway dials this service over a WebSocket, sends text, and gets back streamed
audio frames. The gateway never needs to know about MLX, the model repo id, or
synthesis internals — this service is a black box governed by its wire contract,
[CONTRACT.md](./CONTRACT.md).

> **Status: complete.** `python -m chatterbox_tts` loads + validates config,
> loads the MLX Chatterbox-Turbo model, warms it with one real end-to-end
> synthesis pass (fail-closed — a warm-up failure aborts startup before any
> connection is accepted), then serves the WebSocket protocol below until
> SIGINT/SIGTERM — see `src/chatterbox_tts/__main__.py`. In short: text in,
> streamed synthesized audio out, over a WebSocket, plus per-user voice
> cloning. See [CONTRACT.md](./CONTRACT.md) for the full wire protocol.

The service exposes two ports:

- **`8770`** — the WebSocket server. Clients send `text` deltas, `flush`/`end`
  to trigger synthesis; the server streams back `started` → one or more binary
  audio frames → `done`. Output is 24 kHz MLX synthesis, resampled and encoded
  to either OGG-Opus (default, 48 kHz) or raw PCM16-LE via the format/rate
  negotiated on the connect URL (`?format=&sample_rate=&voice=`).
- **`8771`** — a plain-HTTP `/health` endpoint for `launchd`/operator checks.

Per-user voice cloning is a side channel on the same connection: send
`voice.create` (name + a >5s reference WAV as a follow-up binary frame) to
mint a persisted voice pack, then pass its `voiceId` on future connects (or
`voice.list`/`voice.delete` to manage packs). See CONTRACT.md §4 for the
exact messages.

---

## Configuration — `config.yaml`

Every tunable constant lives in `~/.sentient/chatterbox-tts/config/config.yaml`
(pointed at by the `CHATTERBOX_TTS_CONFIG_PATH` env var). There are zero hardcoded
magic numbers in the source code. The file is read once at startup — **every key is
required**; the service fails loud (raises `ConfigError`) if anything is missing or
the wrong type. There are no silent defaults, unlike the STT service's two
backward-compat exceptions — this is a brand-new service with no legacy config.yaml
to support.

See [config/config.example.yaml](./config/config.example.yaml) for the full file
with inline documentation on every value.

### Environment variables (host paths)

Host paths are **not** in `config.yaml` — they come from `CHATTERBOX_TTS_*`
environment variables, set by the launchd plist (or exported by hand for local dev):

| Env var | Purpose | Default when unset |
|---------|---------|---------------------|
| `CHATTERBOX_TTS_CONFIG_PATH` | Path to `config.yaml` | `~/.sentient/chatterbox-tts/config/config.yaml` |
| `CHATTERBOX_TTS_LOG_DIR` | JSONL log output dir | `~/.sentient/chatterbox-tts/logs` (or `config.yaml`'s `log_dir` if set) |
| `CHATTERBOX_TTS_VOICE_DIR` | Reference voice-clip dir | `~/.sentient/chatterbox-tts/voices` (or `config.yaml`'s `voice_dir` if set) |

`config.yaml`'s `voice_dir` / `log_dir` keys take precedence over the env var when
non-empty — see the comments in `config.example.yaml`.

### Ports

| Port | Purpose |
|------|---------|
| `8770` | WebSocket server (synthesis requests) |
| `8771` | Plain-HTTP health endpoint |

---

## Local development

```bash
cd capabilityServices/ChatterboxTTSService

# Non-live unit tests: server/encoders/config/voice-store against a stubbed
# engine — no MLX model load, no network. uv manages the venv + deps.
uv run pytest -q

# Live tests exercise the real MLX model (first run downloads the weights,
# cached under ~/.cache/huggingface) — excluded from the default run above.
uv run pytest -q -m live

# Run the real service against the example config: loads + warms the model,
# then serves ws://127.0.0.1:8770 (health on :8771) until Ctrl-C.
CHATTERBOX_TTS_CONFIG_PATH=./config/config.example.yaml \
CHATTERBOX_TTS_LOG_DIR=./logs \
uv run python -m chatterbox_tts
```

For the full wire protocol (connect negotiation, message types, concurrency
model), see [CONTRACT.md](./CONTRACT.md). For a persistent macOS deploy
(launchd LaunchAgent, model pre-fetch, Homebrew preflight for libopus/ffmpeg),
see `deploy/mac-prod/native/chatterbox-tts.sh` (`install` / `start` / `stop` /
`status` / `logs`).

A plain `pip install -r requirements.txt` into a manually created venv also works
(mirrors the STT service's non-uv fallback) — see `requirements.txt`'s header for
why both `pyproject.toml` and `requirements.txt` exist and must stay in sync.

---

## Conventions shared with `WhisperSTTService`

- `config.py` — YAML → `@dataclass(frozen=True)` loader, fail-loud on any missing
  key via `_require`/`_require_section` helpers. See that module's docstring.
- `event_logger.py`, `metrics.py` — logic copied **verbatim** from
  `WhisperSTTService/src/whisper_stt/` (docstrings reworded to this service's own
  terms — TTS synthesis events, not STT/VAD). This is an intentional cross-service
  convention, not something to abstract into a shared package — each service owns
  its own copy, dependency set, and deploy lifecycle.
- Structured JSONL logging: `<date>-service.jsonl`, `<date>-metrics.jsonl`,
  `conn_<id>.jsonl`, rotated daily, pruned by `logging.retention_days` /
  `retention_days`.
- `src/` layout (`src/chatterbox_tts/`), `python -m chatterbox_tts` entry point via
  `__main__.py`.

See `capabilityServices/WhisperSTTService/README.md` for a from-scratch Python
primer (packages, `@dataclass`, `async`/`await`, etc.) if any of the above is
unfamiliar — the same concepts apply here.
