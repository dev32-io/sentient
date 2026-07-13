# Chatterbox-TTS Service

Local text-to-speech as a **native Apple-Silicon service** (Mac mini prod), sibling to
[`WhisperSTTService`](../WhisperSTTService/). Wraps Chatterbox-Turbo (MLX) into a
WebSocket service that accepts text and streams back synthesized audio. MLX runs on
the Metal GPU, so this service is **Apple-Silicon only** — it does not run on
Linux/x86.

The gateway dials this service over a WebSocket, sends text, and gets back streamed
audio frames. The gateway never needs to know about MLX, the model repo id, or
synthesis internals — this service is a black box governed by its wire contract
(landing in a later task, alongside the WebSocket server itself).

> **Status: scaffolding only.** This is the config + logging skeleton — package
> layout, the fail-loud YAML config loader, and the copied JSONL event/metrics
> logging convention. There is no WebSocket server, no MLX model loading, and no
> synthesis pipeline yet; those land in subsequent tasks of the
> `docs/superpowers/plans/2026-07-08-local-chatterbox-tts.md` plan. `python -m
> chatterbox_tts` currently only loads and validates config, prunes old logs, and
> exits — see `src/chatterbox_tts/__main__.py`.

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

# Run the config unit tests (uv manages the venv + dependencies automatically).
uv run pytest

# Load + validate the example config and exit (no server yet).
CHATTERBOX_TTS_CONFIG_PATH=./config/config.example.yaml \
CHATTERBOX_TTS_LOG_DIR=./logs \
uv run python -m chatterbox_tts
```

A plain `pip install -r requirements.txt` into a manually created venv also works
(mirrors the STT service's non-uv fallback) — see `requirements.txt`'s header for
why both `pyproject.toml` and `requirements.txt` exist and must stay in sync.

---

## Conventions shared with `WhisperSTTService`

- `config.py` — YAML → `@dataclass(frozen=True)` loader, fail-loud on any missing
  key via `_require`/`_require_section` helpers. See that module's docstring.
- `event_logger.py`, `metrics.py` — copied **verbatim** from
  `WhisperSTTService/src/whisper_stt/` (only the module docstrings' service name
  differs). This is an intentional cross-service convention, not something to
  abstract into a shared package — each service owns its own copy, dependency set,
  and deploy lifecycle.
- Structured JSONL logging: `<date>-service.jsonl`, `<date>-metrics.jsonl`,
  `conn_<id>.jsonl`, rotated daily, pruned by `logging.retention_days` /
  `retention_days`.
- `src/` layout (`src/chatterbox_tts/`), `python -m chatterbox_tts` entry point via
  `__main__.py`.

See `capabilityServices/WhisperSTTService/README.md` for a from-scratch Python
primer (packages, `@dataclass`, `async`/`await`, etc.) if any of the above is
unfamiliar — the same concepts apply here.
