# STT Service

Local speech-to-text on Raspberry Pi 5. Wraps Silero VAD + Smart-Turn v3 + SenseVoice-Small into a WebSocket service that consumes streamed PCM16 audio and emits structured turn events.

The gateway connects to this service over a WebSocket, sends raw mic audio, and gets back `transcript_ready` events with the user's speech as text. The gateway never needs to know about VAD, turn detection, or STT internals — this service is a black box governed entirely by [CONTRACT.md](./CONTRACT.md).

```
  gateway (Bun/TS)                    STT service (Python)
       │                                     │
       ├─── binary PCM16 frames ────────────►│ Silero VAD
       │                                     │   ↓
       │                                     │ Smart-Turn v3
       │                                     │   ↓
       │◄── {"type":"transcript_ready"} ─────┤ SenseVoice-Small
       │                                     │
```

---

## Quick start — deploying to the Pi

### 1. First-boot setup (one time only)

```bash
# On the Pi, create the host directories the container mounts into.
# CHANGE ~/.sentient/stt-service/ if you prefer a different location —
# then update the volume paths in deploy/pi/docker-compose.yml to match.
mkdir -p ~/.sentient/stt-service/config
mkdir -p ~/.sentient/stt-service/logs
mkdir -p ~/.sentient/stt-service/recordings

# Copy the example config. This is the ONE file you'll edit to tune behavior.
cp capabilityServices/STTService/config/config.example.yaml \
   ~/.sentient/stt-service/config/config.yaml
```

### 2. Start the stack

```bash
cd deploy/pi
docker compose up -d
```

The STT service image is pulled from the private GitLab registry. Watchtower auto-updates it every 5 minutes alongside the gateway.

### 3. Verify

```bash
docker logs stt-service
```

You should see:
```
INFO stt-service loading Silero VAD (torch JIT)...
INFO stt-service Silero VAD ready
INFO stt-service loading Smart-Turn v3 ONNX from /app/models/smart-turn
INFO stt-service Smart-Turn ready: /app/models/smart-turn/smart-turn-v3.2-cpu.onnx
INFO stt-service loading SenseVoice-Small int8 ONNX from /app/models/sense-voice
INFO stt-service SenseVoice ready: /app/models/sense-voice/model.int8.onnx
INFO stt-service listening on ws://0.0.0.0:8766
```

### 4. Test with the PoC browser client

The browser client at `pocs/localSTT/client/` works against a prod
instance. Paste the Pi URL (`ws://raspberrypi.local:8766`) and an
inbound bearer token from the Pi's `~/.sentient/auth/tokens.yaml` into
the two input fields, then click Connect. Under the hood the token
rides on `Sec-WebSocket-Protocol: bearer, <token>` because browser
`WebSocket` cannot set custom headers — see
[CONTRACT.md §1.1](./CONTRACT.md#11-authentication--two-channels-for-one-token).
The URL + token persist in `localStorage` so reloading the tab doesn't
wipe them.

---

## Wire contract

See [CONTRACT.md](./CONTRACT.md) for the complete WebSocket protocol spec. The two-sentence summary:

- **Gateway sends**: raw PCM16 LE mono @ 16 kHz as binary WebSocket frames.
- **Service sends back**: JSON events (`ready`, `transcript_ready`, `turn_complete`, etc.) and binary WAV payloads.

A minimal gateway only needs to handle `ready` (gate audio sending) and `transcript_ready` (the actual transcript text).

---

## Configuration — `config.yaml`

Every tunable constant lives in `~/.sentient/stt-service/config/config.yaml`. There are zero hardcoded magic numbers in the source code. The file is read once at startup; edit and `docker compose restart stt-service` to apply changes.

See [config/config.example.yaml](./config/config.example.yaml) for the full file with inline documentation on every value.

### Tuning cheatsheet

| Symptom | Knob to turn | Direction |
|---------|-------------|-----------|
| VAD triggers on background noise | `vad.threshold` | Raise to 0.6 |
| VAD misses soft speech | `vad.threshold` | Lower to 0.4 |
| Turns end mid-sentence | `smart_turn.decision_threshold` | Raise to 0.6 |
| Service waits too long after user finishes | `smart_turn.decision_threshold` | Lower to 0.4 |
| Response feels sluggish | `vad.min_silence_ms` | Lower to 150 |
| Pi is overheating under load | `smart_turn.intra_op_threads` / `sense_voice.num_threads` | Drop to 2 |
| Disk filling up with WAVs | `recordings.enabled` | Set to `false` |

---

## Local development (without Docker)

```bash
cd capabilityServices/STTService

# Create a virtual environment (Python's project-level dependency isolation —
# like Gradle's per-project classpath but for the entire Python runtime).
python3 -m venv .venv
source .venv/bin/activate    # Activates the venv — your shell now uses its Python

# Install dependencies into the venv.
pip install -r requirements.txt

# Download models to a local directory.
python scripts/download_models.py ./models

# Run with environment variables pointing at local paths.
STT_CONFIG_PATH=./config/config.example.yaml \
STT_MODEL_DIR=./models \
STT_LOG_DIR=./logs \
STT_RECORDING_DIR=./recordings \
python -m stt_service
```

---

## Debugging a live service

### Log files

```
~/.sentient/stt-service/logs/
├── <YYYY-MM-DD>-service.jsonl   # Startup, shutdown, connection open/close
├── <YYYY-MM-DD>-metrics.jsonl  # 1 line/sec: RSS MB, CPU%, thread count
└── conn_<id>.jsonl     # Per-connection: every chunk, VAD event, decode
```

All files are JSONL (one JSON object per line). Use `jq` to filter:

```bash
# Watch all events for a specific turn
tail -f conn_abc123.jsonl | jq 'select(.turn_idx == 5)'

# See Smart-Turn decisions only
cat conn_abc123.jsonl | jq 'select(.event == "smart_turn.eval")'

# Check memory usage over time
cat *-metrics.jsonl | jq '{ts: .ts, rss_mb: .rss_mb, cpu: .cpu_percent}'
```

### Tracing a single turn end-to-end

1. Find the connection ID: `grep conn.open *-service.jsonl | jq .conn_id`
2. Open that connection's log: `cat conn_<id>.jsonl`
3. Filter by turn: `jq 'select(.turn_idx == 3)'`
4. You'll see the full lifecycle: `vad.start` → `vad.end` → `smart_turn.eval` → `turn.complete` → `sensevoice.decode`

---

## Updating the service

Models are baked into the Docker image. To update:

1. Edit `scripts/download_models.py` to point at a new model revision.
2. Commit, push to `develop`, merge to `main`.
3. CI builds a new image and pushes to the GitLab registry.
4. Watchtower on the Pi pulls the new image within 5 minutes and restarts the container automatically.

No Pi-side maintenance required.

---

# Part II — Learning Python from this codebase

If you're a senior developer coming from Kotlin/Java/Android, this section maps every Python concept used in the source to something you already know. Read this once, then the source files will make sense top to bottom.

## Project structure

### Why `src/stt_service/` and not just `stt_service/`

Modern Python convention puts the importable package inside a `src/` directory. This prevents a subtle bug: without `src/`, running `python` from the project root would let you `import stt_service` from the local directory even when testing against the *installed* version. The `src/` layer forces you to install the package (or set `PYTHONPATH`) before you can import it.

Android equivalent: it's like the `src/main/kotlin/` directory — you wouldn't put Kotlin files at the project root.

### `__init__.py` — "I am a package"

Every directory that should be importable as a Python package needs an `__init__.py` file. It can be empty (just a marker) or export public symbols. In Kotlin, a directory under the source root is automatically a package — Python makes it explicit.

### `__main__.py` — "I am the entry point"

When you run `python -m stt_service`, Python looks for `stt_service/__main__.py` and executes it. It's the equivalent of declaring `fun main()` in Kotlin, except the filename is what matters, not a function annotation.

### `pyproject.toml` — "I am build.gradle.kts"

Declares project metadata, dependencies, and tool configuration. The modern replacement for the older `setup.py` (which was imperative Python code, like `build.gradle` before Kotlin DSL).

## The Python language, for Kotlin thinkers

### Type hints are optional annotations, not enforced types

```python
name: str = "kevin"     # Python: hint only, interpreter ignores it
```
```kotlin
val name: String = "kevin"  // Kotlin: compiler enforces it
```

Python's type hints are documentation that tools (mypy, pyright, IDE autocomplete) can check. The runtime ignores them completely. We write them everywhere in this codebase because they're the best documentation you get — and they make IDE navigation work.

### `@dataclass` = Kotlin `data class`

```python
@dataclass
class SmartTurnResult:
    prediction: int
    probability: float
    eval_ms: float
```
```kotlin
data class SmartTurnResult(
    val prediction: Int,
    val probability: Float,
    val evalMs: Float
)
```

Both auto-generate `__init__`/constructor, `__repr__`/`toString()`, `__eq__`/`equals()`. Python's `@dataclass(frozen=True)` makes all fields immutable — equivalent to Kotlin using `val` for everything.

Key difference: Python dataclass fields with mutable defaults (lists, dicts) must use `field(default_factory=list)` instead of `= []`. See `pipeline_events.py` for an example with a comment explaining why.

### `from __future__ import annotations`

You'll see this as the first line of every `.py` file. It tells Python to evaluate type hints lazily (as strings), which lets you reference classes defined later in the same file. Without it, Python evaluates top-to-bottom and would crash on forward references.

Kotlin doesn't have this problem — the compiler resolves all types regardless of declaration order. This line becomes the default in Python 3.14, so consider it boilerplate.

### `async def` and `await` — same concept as Kotlin coroutines

```python
async def fetch_data() -> str:
    response = await http_client.get(url)
    return response.text
```
```kotlin
suspend fun fetchData(): String {
    val response = httpClient.get(url)
    return response.bodyAsText()
}
```

Both are cooperative concurrency on a single-threaded event loop. Key differences:

- **Starting the loop**: Python requires an explicit `asyncio.run()` at the top. Kotlin has `runBlocking {}`.
- **Structured concurrency**: Kotlin has it built in (`coroutineScope`, `supervisorScope`). Python doesn't — `asyncio.gather()` is the closest equivalent.
- **Calling convention**: In Python, calling an `async def` without `await` gives you a coroutine *object*, not the result. It's like calling a `suspend` function without being in a coroutine scope — except Python won't catch it at compile time.

### `with` statement = Kotlin `use {}`

```python
with open("file.txt") as f:
    data = f.read()
# f is automatically closed here, even if an exception occurred
```
```kotlin
File("file.txt").bufferedReader().use { f ->
    val data = f.readText()
}
// f is automatically closed here
```

Python uses `with` for anything that needs cleanup: files, locks, database transactions, network connections. The object must implement `__enter__` and `__exit__` (Python's version of `Closeable`/`AutoCloseable`).

### `global` keyword — there is no `companion object`

Python modules are objects. A variable defined at module level is like a Kotlin top-level `var`. But inside a function, assigning to a variable creates a *local* by default. The `global` keyword says "I mean the module-level one, not a new local."

```python
_CACHED_MODEL = None

def get_model():
    global _CACHED_MODEL          # Without this, _CACHED_MODEL = ... would create a local
    if _CACHED_MODEL is None:
        _CACHED_MODEL = load_model()
    return _CACHED_MODEL
```

In Kotlin you'd put this in a `companion object` or use a top-level `lazy { }`.

### `**kwargs` — keyword variadic arguments

```python
def log(event: str, **fields) -> None:
    # fields is a dict: {"turn_idx": 5, "duration_ms": 720.4}
    ...

log("vad.start", turn_idx=5, duration_ms=720.4)
```

There's no direct Kotlin equivalent. The closest is passing a `Map<String, Any>`, but Python's syntax makes it read like named parameters at the call site. You'll see this pattern in `event_logger.py`.

### `isinstance()` dispatch — poor man's sealed class `when`

```python
if isinstance(event, VadStart):
    ...
elif isinstance(event, TurnComplete):
    ...
```
```kotlin
when (event) {
    is VadStart -> ...
    is TurnComplete -> ...
}
```

Python 3.10+ has `match`/`case` that's closer to Kotlin's `when`, but `isinstance` chains are more universally understood. See `wire_protocol.py`.

### `@property` — computed getters

```python
@property
def model_path(self) -> Path:
    return self._model_path
```
```kotlin
val modelPath: Path get() = _modelPath
```

`@property` turns a method into something that reads like a field: `obj.model_path` instead of `obj.model_path()`. The underscore prefix `_model_path` is Python's convention for "private" — there's no `private` keyword, just the honor system.

## File-by-file tour

Each file teaches one or two Python concepts. Read them in this order for the smoothest learning path:

| Order | File | What it does | Python concept to learn |
|-------|------|-------------|------------------------|
| 1 | `__init__.py` | Package marker | How Python packages work |
| 2 | `pipeline_events.py` | Event dataclasses | `@dataclass`, `Union` types, `field(default_factory=...)` |
| 3 | `config.py` | YAML → typed config | `@dataclass(frozen=True)`, validation, `*` keyword-only args |
| 4 | `pause_tracker.py` | Pure utility class | `__len__` dunder, `None` as "no value" |
| 5 | `wav_codec.py` | Audio encoding | `io.BytesIO`, numpy dtype casting |
| 6 | `event_logger.py` | JSONL writer | `threading.Lock`, `with`, `@property`, `**kwargs` |
| 7 | `wire_protocol.py` | Event serialization | `isinstance()` dispatch |
| 8 | `segment_decoder.py` | Multi-segment STT | `TYPE_CHECKING` guard, f-strings |
| 9 | `sense_voice.py` | SenseVoice wrapper | `getattr()` defensive access |
| 10 | `smart_turn.py` | Smart-Turn wrapper | ONNX session management |
| 11 | `turn_finalizer.py` | Turn content gating | `unicodedata`, regex, `re.compile` |
| 12 | `turn_pipeline.py` | Core state machine | `global`, `deque(maxlen=N)`, `bytearray` |
| 13 | `metrics.py` | Background sampler | `asyncio.create_task`, `asyncio.Event` |
| 14 | `server.py` | WebSocket server | `async for`, signal handlers, `asyncio.run` |
| 15 | `__main__.py` | Entry point | `if __name__ == "__main__"`, env vars |

## Dependency management — `pip` vs Gradle

| Concept | Python | Kotlin/Android |
|---------|--------|----------------|
| Dependency declaration | `pyproject.toml` / `requirements.txt` | `build.gradle.kts` |
| Lock file | `pip freeze > requirements.txt` | `gradle.lockfile` |
| Local isolation | `python -m venv .venv` | Gradle does this automatically |
| Install deps | `pip install -r requirements.txt` | `./gradlew build` |
| Run | `python -m stt_service` | `./gradlew run` |
| Package format | `.whl` (wheel) | `.aar` / `.jar` |
| Registry | PyPI (pypi.org) | Maven Central / Google Maven |

The biggest cultural difference: Python's ecosystem assumes you manage a virtual environment yourself. There's no Gradle-like tool that does it automatically. Always activate your venv before running any `pip` or `python` command.

---

## Operational reference

### Resource usage (Raspberry Pi 5, 8 GB)

| Metric | Value |
|--------|-------|
| Steady-state RAM | ~1.15 GB |
| Peak RAM (during decode) | ~1.3 GB |
| CPU during active turn | 1-2 cores briefly |
| CPU idle | <1% |
| Disk (image) | ~600 MB |
| Disk (logs, 24h active use) | ~50-100 MB |

### Container-internal paths

These are set in the Dockerfile and should NOT be changed:

| Path | Purpose | Mounted from host |
|------|---------|-------------------|
| `/app/config/config.yaml` | Runtime config | `~/.sentient/stt-service/config/config.yaml` |
| `/app/logs/` | JSONL log files | `~/.sentient/stt-service/logs/` |
| `/app/recordings/` | Turn WAV files | `~/.sentient/stt-service/recordings/` |
| `/app/models/` | ML model weights | Baked into image (not mounted) |

To change the **host** paths, edit `deploy/pi/docker-compose.yml`. The container-side paths are fixed.

### Clearing disk space

```bash
# Delete all recordings (service doesn't care — stateless on this dir)
rm -rf ~/.sentient/stt-service/recordings/*

# As of the logging-rotation-retention branch, the service auto-prunes conn_*.jsonl
# files via logging.retention_days (default 7). The manual find below is only needed
# for emergency cleanup or if auto-pruning is disabled.
# (Dated service/metrics logs — <YYYY-MM-DD>-service.jsonl, <YYYY-MM-DD>-metrics.jsonl
#  — are also auto-pruned by the same retention policy.)
find ~/.sentient/stt-service/logs -name 'conn_*.jsonl' -mtime +7 -delete
```
