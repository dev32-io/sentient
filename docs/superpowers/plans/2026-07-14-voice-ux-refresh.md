# Voice Picking & Cloning UX Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin record/upload Voices panel with a unified, filterable Voice Packs catalog (built-in pre-cloned packs + user packs), live-synth Play preview, and name/description/tags metadata.

**Architecture:** Three tiers extend PR #19. The **TTS service** (Python) gains description/tags on packs and a read-only built-in library. The **gateway** (Bun/TS) gains a preview synth endpoint (one-shot PCM→WAV), create-with-metadata, and a widened delete-id guard. The **web UI** (Preact) gets a new component tree: one grid, one filter row, an add-voice modal.

**Tech Stack:** Python 3.11 + websockets + mlx-audio (service, `uv`/pytest); Bun + TypeScript + zod + Vitest (gateway); Preact + Vite + Signals + Vitest/RTL (webui). Spec: `docs/superpowers/specs/2026-07-14-voice-ux-refresh-design.md`.

## Global Constraints

- **Branch:** `feature/local-tts-chatterbox` (stacked onto PR #19). Never push to `develop`/`main`.
- **Shell:** `source scripts/env.sh` before any `bun run` command. Service tests run from `capabilityServices/ChatterboxTTSService/` via `uv run pytest` (default excludes `-m live`; model tests are `@pytest.mark.live`).
- **File caps:** ≤300 lines/file (split at 250), ≤40 lines/function, ≤3 nesting levels.
- **No magic numbers/strings:** tunables → YAML config; protocol/status literals → named code constants.
- **Logging:** every new file uses a tagged logger (gateway `getLog([...])`, service `logging.getLogger("chatterbox_tts.*")`, webui `createLogger([...])`). NEVER log user/chat content — voiceId, lengths, byte counts, elapsed only. No bare `console.*` in shipped webui code.
- **Test-lean doctrine (binding, overrides the skill's default TDD-per-task):** write unit tests ONLY for wire/protocol contracts, FSM/invariants, and security boundaries. Presentational Preact components and pure UI utilities get NO unit test — they are verified by `bun run typecheck` + the Task 14 E2E sweep. Where a task below has no unit test, its verification step is typecheck (+ lint) and the commit.
- **Preview audio:** PCM16-LE mono @ 24000 Hz wrapped in WAV. The gateway config `tts.format` enum stays `["opus"]`; the preview path passes `format:"pcm"` directly to `buildConnectUrl` (untyped string), never through config.
- **Built-in ids:** readable slug `^[a-z0-9-]{1,32}$`; user ids stay `uuid4().hex`. `get()`/`delete()` disambiguate by **known-built-in-set membership first**, then hex. Built-in slugs derive from `builtin_dir` subdir names at init — never from caller input.
- **DELETE id guard:** widen gateway `VOICE_ID_SHAPE_RE` to `^[a-z0-9-]{1,32}$` (covers hex + slug; blocks traversal shapes). The **service** is the sole authority that refuses built-in deletion (raises `ValueError("builtin-voice")`); the gateway maps reason `"builtin-voice"` → HTTP 409.
- **Voice library is shared-household** (no per-user scoping) — existing model, unchanged. See the authorization block in `gateway/src/api/handlers/voices.ts`.
- **Commit format:** `type(scope): description` (feat/fix/refactor/test/chore/docs). One logical change per commit.

## File Structure

**Service (`capabilityServices/ChatterboxTTSService/`)**
- Modify `src/chatterbox_tts/voice_store.py` — desc/tags on create+meta; built-in library (dir, list-merge+source, slug get, delete-refuse).
- Modify `src/chatterbox_tts/wire_protocol.py` — `voice.create` parses optional `description`+`tags`.
- Modify `src/chatterbox_tts/connection_session.py` — stash+forward desc/tags; builtin-delete error already flows through `_handle_voice_delete`.
- Modify `src/chatterbox_tts/config.py` — `builtin_voice_dir`, `voice_description_max_len`, `voice_tag_max_len`, `voice_max_tags`.
- Modify `src/chatterbox_tts/__main__.py` — resolve builtin dir, pass to `VoiceStore`.
- Create `scripts/build_builtin_voices.py` — offline generator (live/MLX).
- Create `src/chatterbox_tts/voices_library/<slug>/{conds.safetensors,meta.json}` — shipped packs.
- Create `src/chatterbox_tts/voices_library/LICENSES.md` — source/license/model-version.
- Modify `config/config.example.yaml` + host `~/.sentient/chatterbox-tts/config/config.yaml` — new caps.
- Tests: `tests/test_voice_store.py`, `tests/test_wire_protocol.py`.

**Gateway (`gateway/`)**
- Modify `shared/config/src/schema.ts` — `tts.preview_greetings`, `preview_timeout_ms`, `voice_description_max_len`, `voice_tag_max_len`, `voice_max_tags`.
- Modify `src/providers/tts/local-tts-protocol.ts` — `LocalTtsVoiceInfo` +desc/tags/source; `voiceCreateMsg(name,description,tags)`.
- Modify `src/providers/tts/voice-mgmt-client.ts` — `createVoice` +desc/tags; `listVoices` passthrough.
- Create `src/providers/tts/preview-synth-client.ts` — one-shot PCM synth.
- Create `src/providers/tts/pcm-to-wav.ts` — PCM16→WAV bytes.
- Modify `src/api/handlers/voices.ts` — create-with-meta; preview route+handler; guard widen; `builtin-voice`→409.
- Modify `src/bootstrap/create-gateway-services.ts` + `src/server.ts` — thread preview config + caps.
- Tests: `voice-mgmt-client.test.ts` (or new), `preview-synth-client.test.ts`, `pcm-to-wav.test.ts`, `voices.test.ts`, `shared/config/*.test.ts`.

**Web UI (`gateway/webui/`)**
- Modify `src/services/_helpers.ts` — `handleBlobFetch`.
- Modify `src/services/voices-api.ts` — `VoiceSummary` +desc/tags/source; `createVoice` +desc/tags; `previewVoice`.
- Modify `src/hooks/use-voices.ts` — `createVoice(audio,name,description,tags)`.
- Create `src/components/voices/voice-filter.ts` — pure filter/derive.
- Create `src/components/voices/VoiceFilterBar.tsx`, `VoicePackGrid.tsx`, `VoicePackTile.tsx`, `AddVoiceModal.tsx`, `VoiceCapture.tsx`.
- Create `src/hooks/use-voice-preview.ts`.
- Rewrite `src/components/voices/VoicesPanel.tsx`; **delete** `VoiceList.tsx`, `VoiceRecorder.tsx` (+ their `.test.tsx`).
- Modify `src/app.tsx` + `src/components/settings/settings-view.tsx` — plumb `assistantSpeaking` signal.
- Modify the active wizard `step-voice.tsx` — pick-only grid reuse.

---

## Task 1: Service — description + tags on voice packs

**Files:**
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voice_store.py`
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/wire_protocol.py`
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/connection_session.py`
- Test: `capabilityServices/ChatterboxTTSService/tests/test_voice_store.py`, `tests/test_wire_protocol.py`

**Interfaces:**
- Consumes: existing `VoiceStore.create(ref_wav, sr, name)`, `VoiceCreateMessage(name)`, `parse_client_message`.
- Produces: `VoiceStore.create(ref_wav, sr, name, description="", tags=None)` → dict incl. `name`; `list()` items gain `description: str`, `tags: list[str]`; `VoiceCreateMessage(name, description, tags)`; parser reads optional `description` (str→"") + `tags` (list[str]→[]).

- [ ] **Step 1: Failing wire test** — add to `tests/test_wire_protocol.py`:

```python
def test_parse_voice_create_with_description_and_tags() -> None:
    msg = parse_client_message(
        json.dumps({"type": "voice.create", "name": "Nova", "description": "Warm", "tags": ["warm", "calm"]})
    )
    assert isinstance(msg, VoiceCreateMessage)
    assert msg.name == "Nova"
    assert msg.description == "Warm"
    assert msg.tags == ["warm", "calm"]


def test_parse_voice_create_defaults_description_and_tags() -> None:
    msg = parse_client_message(json.dumps({"type": "voice.create", "name": "Nova"}))
    assert isinstance(msg, VoiceCreateMessage)
    assert msg.description == ""
    assert msg.tags == []


def test_parse_voice_create_rejects_non_string_tags() -> None:
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps({"type": "voice.create", "name": "Nova", "tags": [1, 2]}))
```

- [ ] **Step 2: Run — verify fail**

Run: `cd capabilityServices/ChatterboxTTSService && uv run pytest tests/test_wire_protocol.py -q`
Expected: FAIL (`VoiceCreateMessage` has no `description`/`tags`).

- [ ] **Step 3: Extend `VoiceCreateMessage` + parser** in `wire_protocol.py`:

```python
@dataclass
class VoiceCreateMessage:
    """Start a voice-pack upload; the next binary frame is the reference wav."""

    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
```

Add `from dataclasses import dataclass, field` (import `field`). In `parse_client_message`, replace the `voice.create` branch:

```python
    if kind == _TYPE_VOICE_CREATE:
        return VoiceCreateMessage(
            name=_require_str(parsed, "name", kind),
            description=_optional_str(parsed, "description"),
            tags=_optional_str_list(parsed, "tags", kind),
        )
```

Add helpers below `_require_str`:

```python
def _optional_str(parsed: dict[str, Any], field_name: str) -> str:
    """Pull an optional string field; missing/empty/non-string -> ''."""
    value = parsed.get(field_name)
    return value if isinstance(value, str) else ""


def _optional_str_list(parsed: dict[str, Any], field_name: str, kind: str) -> list[str]:
    """Pull an optional list-of-strings field; missing -> []. Non-string items reject."""
    value = parsed.get(field_name)
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise WireProtocolError(f"'{kind}' message field '{field_name}' must be a list of strings")
    return value
```

- [ ] **Step 4: Run — verify pass**

Run: `cd capabilityServices/ChatterboxTTSService && uv run pytest tests/test_wire_protocol.py -q`
Expected: PASS.

- [ ] **Step 5: Failing store test** — add to `tests/test_voice_store.py` (uses the existing `@pytest.mark.live` create pattern; a non-live test asserts meta round-trips through a hand-written pack). Add non-live meta test:

```python
def test_list_returns_description_and_tags(tmp_path: Path) -> None:
    import json
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    pack = (tmp_path / "voices" / ("a" * 32))
    pack.mkdir(parents=True)
    (pack / "conds.safetensors").write_bytes(b"stub")
    (pack / "meta.json").write_text(
        json.dumps({"name": "Nova", "description": "Warm", "tags": ["warm"], "createdAt": 1.0, "refDurationMs": 6000})
    )
    [entry] = store.list()
    assert entry["description"] == "Warm"
    assert entry["tags"] == ["warm"]


def test_list_defaults_missing_description_and_tags(tmp_path: Path) -> None:
    import json
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    pack = (tmp_path / "voices" / ("a" * 32))
    pack.mkdir(parents=True)
    (pack / "conds.safetensors").write_bytes(b"stub")
    (pack / "meta.json").write_text(json.dumps({"name": "Old", "createdAt": 1.0, "refDurationMs": 6000}))
    [entry] = store.list()
    assert entry["description"] == ""
    assert entry["tags"] == []
```

- [ ] **Step 6: Run — verify fail**

Run: `uv run pytest tests/test_voice_store.py -q`
Expected: FAIL (`description`/`tags` absent).

- [ ] **Step 7: Extend `create` + meta write + `_read_pack_meta`** in `voice_store.py`:

Change `create` signature + meta build:

```python
    def create(
        self, ref_wav: np.ndarray, sr: int, name: str, description: str = "", tags: list[str] | None = None
    ) -> dict:
```

Thread `description`/`tags` into `_build_pack` (add the two params to its signature), and in the meta dict:

```python
            meta = {
                "name": name,
                "description": description,
                "tags": list(tags or []),
                "createdAt": created_at,
                "refDurationMs": ref_duration_ms,
            }
```

In `_read_pack_meta`, normalize legacy packs so every returned dict has the fields:

```python
        return {
            "voiceId": entry.name,
            "name": meta.get("name", ""),
            "description": meta.get("description", ""),
            "tags": meta.get("tags", []),
            "createdAt": meta.get("createdAt", 0.0),
            "refDurationMs": meta.get("refDurationMs", 0),
        }
```

- [ ] **Step 8: Forward desc/tags in `connection_session.py`** — replace the pending-name field with the message, and pass through on create:

In `__init__`: `self._pending_voice_create: VoiceCreateMessage | None = None` (remove `_pending_voice_create_name`).
In `_route`, the `VoiceCreateMessage` branch: `self._pending_voice_create = msg`.
In `_handle_binary`:

```python
    async def _handle_binary(self, data: bytes) -> None:
        pending = self._pending_voice_create
        if pending is None:
            self._conn_log.log("binary.unexpected", bytes=len(data))
            await send_server_event(self._ws, WarningEvent(reason="unexpected_binary_frame"), self._conn_log)
            return
        self._pending_voice_create = None
        await self._create_voice(pending, data)
```

Change `_create_voice(self, pending: VoiceCreateMessage, wav_bytes: bytes)` and the store call:

```python
                result = await asyncio.to_thread(
                    self._voice_store.create, array, sr, pending.name, pending.description, pending.tags
                )
```

- [ ] **Step 9: Run — verify pass + full suite**

Run: `uv run pytest -q`
Expected: PASS (all non-live).

- [ ] **Step 10: Commit**

```bash
git add capabilityServices/ChatterboxTTSService/src/chatterbox_tts/wire_protocol.py \
        capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voice_store.py \
        capabilityServices/ChatterboxTTSService/src/chatterbox_tts/connection_session.py \
        capabilityServices/ChatterboxTTSService/tests/test_wire_protocol.py \
        capabilityServices/ChatterboxTTSService/tests/test_voice_store.py
git commit -m "feat(tts): description + tags on voice packs"
```

---

## Task 2: Service — built-in voice library (read-only, source-tagged)

**Files:**
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voice_store.py`
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/config.py`
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/__main__.py`
- Modify: `capabilityServices/ChatterboxTTSService/config/config.example.yaml`
- Modify (host, in place — do NOT clobber): `~/.sentient/chatterbox-tts/config/config.yaml`
- Test: `tests/test_voice_store.py`

**Interfaces:**
- Consumes: `VoiceStore(model, voice_dir)`, `list()`, `get(voice_id)`, `delete(voice_id)`.
- Produces: `VoiceStore(model, voice_dir, builtin_dir=None)`; `list()` items gain `source: "builtin"|"user"` (built-ins first); `get(slug)` resolves a built-in pack; `delete(builtin_slug)` raises `ValueError("builtin-voice")`. Config gains `builtin_voice_dir: str`, `voice_description_max_len: int`, `voice_tag_max_len: int`, `voice_max_tags: int`.

- [ ] **Step 1: Failing tests** — add to `tests/test_voice_store.py`:

```python
def _write_builtin(builtin_dir: Path, slug: str, name: str, tags: list[str]) -> None:
    import json
    pack = builtin_dir / slug
    pack.mkdir(parents=True)
    (pack / "conds.safetensors").write_bytes(b"stub")
    (pack / "meta.json").write_text(json.dumps({"name": name, "description": "", "tags": tags}))


def test_list_merges_builtins_first_with_source(tmp_path: Path) -> None:
    builtin = tmp_path / "library"
    _write_builtin(builtin, "nova", "Nova", ["warm"])
    store = VoiceStore(_StubEngine(), tmp_path / "voices", builtin_dir=builtin)
    packs = store.list()
    assert packs[0]["voiceId"] == "nova"
    assert packs[0]["source"] == "builtin"


def test_delete_builtin_refused(tmp_path: Path) -> None:
    builtin = tmp_path / "library"
    _write_builtin(builtin, "nova", "Nova", [])
    store = VoiceStore(_StubEngine(), tmp_path / "voices", builtin_dir=builtin)
    with pytest.raises(ValueError, match="builtin-voice"):
        store.delete("nova")


def test_get_resolves_builtin_slug(tmp_path: Path) -> None:
    builtin = tmp_path / "library"
    _write_builtin(builtin, "nova", "Nova", [])
    # Overwrite conds with a real-ish sentinel the stub can 'load'; use load monkeypatch.
    store = VoiceStore(_StubEngine(), tmp_path / "voices", builtin_dir=builtin)
    assert "nova" in store.list()[0]["voiceId"]  # membership proven via list; get() load is @live
```

- [ ] **Step 2: Run — verify fail**

Run: `uv run pytest tests/test_voice_store.py -q`
Expected: FAIL (`builtin_dir` kwarg unknown).

- [ ] **Step 3: Implement built-in support** in `voice_store.py`. Add constant + init:

```python
_BUILTIN_SLUG_RE = re.compile(r"^[a-z0-9-]{1,32}$")
```

`__init__` gains `builtin_dir: Path | None = None`:

```python
    def __init__(self, model: "ChatterboxEngine", voice_dir: Path, builtin_dir: Path | None = None) -> None:
        self._model = model
        self._voice_dir = Path(voice_dir)
        self._builtin_dir = Path(builtin_dir) if builtin_dir is not None else None
        self._cache: dict[str, Any] = {}
        os.makedirs(self._voice_dir, mode=_DIR_MODE, exist_ok=True)
        os.chmod(self._voice_dir, _DIR_MODE)
        self._builtin_slugs = self._scan_builtin_slugs()
```

Add helpers:

```python
    def _scan_builtin_slugs(self) -> set[str]:
        """Slug set = subdirs of builtin_dir that match the slug shape and hold a conds file."""
        if self._builtin_dir is None or not self._builtin_dir.is_dir():
            return set()
        slugs: set[str] = set()
        for entry in self._builtin_dir.iterdir():
            if entry.is_dir() and _BUILTIN_SLUG_RE.match(entry.name) and (entry / _CONDS_FILENAME).is_file():
                slugs.add(entry.name)
        return slugs

    def _builtin_pack_dir(self, slug: str) -> Path:
        assert self._builtin_dir is not None  # only called for known-member slugs
        pack_dir = self._builtin_dir / slug
        if not pack_dir.resolve().is_relative_to(self._builtin_dir.resolve()):
            raise ValueError("invalid voice_id")
        return pack_dir
```

`get` — resolve built-ins first:

```python
    def get(self, voice_id: str | None) -> Any:
        if voice_id is None:
            log.debug("voice_store.get default reason=voice_id_none")
            return self._model.default_conditionals()
        if voice_id in self._builtin_slugs:
            return self._get_from_dir(voice_id, self._builtin_pack_dir(voice_id))
        pack_dir = self._validated_pack_dir(voice_id)
        return self._get_from_dir(voice_id, pack_dir)
```

Extract the cache/load body into `_get_from_dir(self, voice_id, pack_dir)` (the current lines from the cache check through `Conditionals.load` + cache set + return; unknown/missing conds → `self._model.default_conditionals()`).

`delete` — refuse built-ins:

```python
    def delete(self, voice_id: str) -> bool:
        if voice_id in self._builtin_slugs:
            log.warning("voice_store.delete refused reason=builtin voice_id=%s", voice_id)
            raise ValueError("builtin-voice")
        pack_dir = self._validated_pack_dir(voice_id)
        ...
```

`list` — merge built-ins first, tag source:

```python
    def list(self) -> list[dict]:
        packs: list[dict] = []
        for slug in sorted(self._builtin_slugs):
            meta = self._read_pack_meta(self._builtin_pack_dir(slug))
            if meta is not None:
                packs.append({**meta, "source": "builtin"})
        if self._voice_dir.is_dir():
            for entry in sorted(self._voice_dir.iterdir()):
                if not entry.is_dir():
                    continue
                meta = self._read_pack_meta(entry)
                if meta is not None:
                    packs.append({**meta, "source": "user"})
        log.debug("voice_store.list count=%d builtin=%d", len(packs), len(self._builtin_slugs))
        return packs
```

- [ ] **Step 4: Add config fields** in `config.py`. Add to `Config` dataclass: `builtin_voice_dir: str`, `voice_description_max_len: int`, `voice_tag_max_len: int`, `voice_max_tags: int`. Add matching `_require` lines in `_parse`:

```python
        builtin_voice_dir=_require(raw, "builtin_voice_dir", str),
        voice_description_max_len=_require(raw, "voice_description_max_len", int),
        voice_tag_max_len=_require(raw, "voice_tag_max_len", int),
        voice_max_tags=_require(raw, "voice_max_tags", int),
```

- [ ] **Step 5: Resolve builtin dir + pass to store** in `__main__.py`. Add a package-relative default and resolve like `voice_dir`:

```python
_PACKAGED_BUILTIN_DIR = Path(__file__).parent / "voices_library"
```

In `_resolve_and_freshen_config` (or `main`), resolve: empty config value → `CHATTERBOX_TTS_BUILTIN_VOICE_DIR` env → `_PACKAGED_BUILTIN_DIR`. Then:

```python
    builtin_dir = _resolve_dir(config.builtin_voice_dir, "CHATTERBOX_TTS_BUILTIN_VOICE_DIR", _PACKAGED_BUILTIN_DIR)
    voice_store = VoiceStore(engine, Path(config.voice_dir), builtin_dir=builtin_dir)
```

- [ ] **Step 6: Update config YAMLs.** Add to `config/config.example.yaml` (with inline comments):

```yaml
builtin_voice_dir: ""            # empty -> packaged voices_library/ (or CHATTERBOX_TTS_BUILTIN_VOICE_DIR)
voice_description_max_len: 240   # max chars for a voice pack description
voice_tag_max_len: 24            # max chars per tag
voice_max_tags: 8                # max tags per voice pack
```

Add the same 4 keys to the host `~/.sentient/chatterbox-tts/config/config.yaml` **in place** (edit, do not overwrite from template — it holds tuned values).

- [ ] **Step 7: Run — verify pass**

Run: `uv run pytest -q`
Expected: PASS. Also `uv run python -c "from chatterbox_tts.config import load_config"` sanity (no syntax error).

- [ ] **Step 8: Commit**

```bash
git add capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voice_store.py \
        capabilityServices/ChatterboxTTSService/src/chatterbox_tts/config.py \
        capabilityServices/ChatterboxTTSService/src/chatterbox_tts/__main__.py \
        capabilityServices/ChatterboxTTSService/config/config.example.yaml \
        capabilityServices/ChatterboxTTSService/tests/test_voice_store.py
git commit -m "feat(tts): read-only built-in voice library with source tagging"
```

> Note: `~/.sentient/...config.yaml` is host state, not committed.

---

## Task 3: Built-in pack assets (offline generator + CC0 clips)

**Files:**
- Create: `capabilityServices/ChatterboxTTSService/scripts/build_builtin_voices.py`
- Create: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voices_library/<slug>/{conds.safetensors,meta.json}` (~4–6 slugs)
- Create: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voices_library/LICENSES.md`

**Interfaces:**
- Consumes: `ChatterboxEngine(model_id, exaggeration, cfg_weight)`, `engine.prepare_conditionals(ref_wav, sr)`, `Conditionals` (from `mlx_audio.tts.models.chatterbox_turbo`), `soundfile.read`.
- Produces: shipped built-in packs whose slugs `VoiceStore._scan_builtin_slugs` will discover.

This is an **on-host, live/MLX** asset task (needs Metal). It produces committed binaries; no unit test.

- [ ] **Step 1: Write the generator** `scripts/build_builtin_voices.py`:

```python
"""Offline built-in voice-pack generator (run on-host; needs Metal/MLX).

For each (slug, wav, name, description, tags) entry: decode the clip to mono
float32, run ChatterboxEngine.prepare_conditionals, and persist
voices_library/<slug>/{conds.safetensors, meta.json}. Idempotent: re-running
overwrites. NEVER commit the source wavs — only the derived conds + meta.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from chatterbox_tts.chatterbox_mlx import ChatterboxEngine

_MODEL = "mlx-community/chatterbox-turbo-8bit"  # match config.yaml `model`
_EXAGGERATION = 0.5
_CFG_WEIGHT = 0.5
_LIBRARY = Path(__file__).resolve().parents[1] / "src" / "chatterbox_tts" / "voices_library"

# (slug, source_wav_path, name, description, tags)
_ENTRIES = [
    ("nova", "clips/nova.wav", "Nova", "Warm, calm narrator", ["warm", "calm"]),
    # ... 3–5 more, curated CC0/public-domain clips
]


def _decode(path: Path) -> tuple[np.ndarray, int]:
    array, sr = sf.read(str(path), dtype="float32")
    if array.ndim > 1:
        array = array.mean(axis=1).astype(np.float32)
    return array, sr


def main() -> None:
    engine = ChatterboxEngine(_MODEL, _EXAGGERATION, _CFG_WEIGHT)
    engine.warm()
    for slug, wav, name, description, tags in _ENTRIES:
        ref, sr = _decode(Path(__file__).resolve().parent / wav)
        conds = engine.prepare_conditionals(ref, sr)
        pack = _LIBRARY / slug
        pack.mkdir(parents=True, exist_ok=True)
        conds.save(pack / "conds.safetensors")
        (pack / "meta.json").write_text(
            json.dumps({"name": name, "description": description, "tags": tags}), encoding="utf-8"
        )
        print(f"built {slug}: {ref.size / sr:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Source ~4–6 CC0/public-domain clips** (LibriVox public-domain or CC0 voice datasets), ≥6s clean each, into `scripts/clips/` (git-ignored — do NOT commit the raw wavs). Fill `_ENTRIES` with a diverse set (warm/calm, deep/news, bright, soft, etc.), tagging from the suggested vocab (`warm calm deep bright family kids news soft`).

- [ ] **Step 3: Generate the packs**

Run: `cd capabilityServices/ChatterboxTTSService && uv run python scripts/build_builtin_voices.py`
Expected: `built nova: 8.x s` lines; `src/chatterbox_tts/voices_library/<slug>/{conds.safetensors,meta.json}` created for each.

- [ ] **Step 4: Write `voices_library/LICENSES.md`** recording per-slug: source URL, license (CC0/public-domain), attribution, and the **model version** that produced the conds (`mlx-community/chatterbox-turbo-8bit`, note conds are model-version-tied per `voice_store.py` docstring).

- [ ] **Step 5: Smoke the library loads** — restart the host TTS service, then:

Run: `curl -s http://127.0.0.1:8771/health` (service up) and confirm the gateway `voice.list` returns the built-ins once Task 4 lands. For now verify the dir shape: `find src/chatterbox_tts/voices_library -maxdepth 2 -type f`.
Expected: each slug has `conds.safetensors` + `meta.json`.

- [ ] **Step 6: Add `scripts/clips/` to the service `.gitignore`** (create if absent) so raw wavs never commit. Commit only conds + meta + LICENSES + the generator.

```bash
git add capabilityServices/ChatterboxTTSService/scripts/build_builtin_voices.py \
        capabilityServices/ChatterboxTTSService/src/chatterbox_tts/voices_library \
        capabilityServices/ChatterboxTTSService/.gitignore
git commit -m "feat(tts): ship curated built-in voice packs + generator"
```

---

## Task 4: Gateway config schema — preview + caps

**Files:**
- Modify: `shared/config/src/schema.ts` (lines 68–83, `ttsConfigSchema`)
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`, `gateway/src/server.ts`
- Modify: `gateway/config.yaml` + host `~/.sentient/gateway/config/config.yaml` (in place)
- Test: `shared/config/` schema test (mirror existing tts test if present) — else assert defaults inline in an existing config test.

**Interfaces:**
- Produces: `TTSConfig` gains `preview_greetings: string[]`, `preview_timeout_ms: number`, `voice_description_max_len: number`, `voice_tag_max_len: number`, `voice_max_tags: number`. `VoicesHandlerDeps` (Task 7) will read these via `services.ttsConfig`.

- [ ] **Step 1: Extend `ttsConfigSchema`** in `shared/config/src/schema.ts` (append fields before `utterance_aggregator`):

```ts
  // Preview greetings — one is chosen at random per Play preview and synthesized
  // live in the target voice. Kept short (~2s of speech).
  preview_greetings: z
    .array(z.string())
    .default([
      "Hi, I'm your family's Sentient assistant. How can I help?",
      "Hello there — Sentient here, ready when you are.",
      "Hey! I'm Sentient. Ask me anything.",
      "Good to see you. I'm your family assistant.",
      "Hi! What can I do for the family today?",
    ]),
  preview_timeout_ms: z.number().int().min(1).default(8000), // max wait for a preview synth
  voice_description_max_len: z.number().int().min(1).default(240), // create/edit description cap
  voice_tag_max_len: z.number().int().min(1).default(24), // per-tag char cap
  voice_max_tags: z.number().int().min(0).default(8), // max tags per voice
```

- [ ] **Step 2: Typecheck the config workspace**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS (new fields are `.default()`ed, no consumer breakage yet).

- [ ] **Step 3: Add a schema default test** — in the existing `shared/config` test file that covers `ttsConfigSchema` (search for `preview` / `voice_op_timeout_ms`), add:

```ts
it("defaults preview greetings and voice caps", () => {
  const cfg = ttsConfigSchema.parse({});
  expect(cfg.preview_greetings.length).toBeGreaterThan(0);
  expect(cfg.preview_timeout_ms).toBe(8000);
  expect(cfg.voice_description_max_len).toBe(240);
  expect(cfg.voice_max_tags).toBe(8);
});
```

- [ ] **Step 4: Run the config test**

Run: `bun run test --filter @sentient/config` (or `cd shared/config && bun run test`)
Expected: PASS.

- [ ] **Step 5: Document the keys in `gateway/config.yaml`** under the `tts:` block (add the 5 keys with inline comments), and mirror into the host `~/.sentient/gateway/config/config.yaml` **in place**.

- [ ] **Step 6: Commit**

```bash
git add shared/config/src/schema.ts shared/config/**/*.test.ts gateway/config.yaml
git commit -m "feat(config): tts preview greetings + voice metadata caps"
```

---

## Task 5: Gateway protocol + voice-mgmt client — desc/tags/source

**Files:**
- Modify: `gateway/src/providers/tts/local-tts-protocol.ts`
- Modify: `gateway/src/providers/tts/voice-mgmt-client.ts`
- Test: `gateway/src/providers/tts/voice-mgmt-client.test.ts` (create if absent, else extend), and any `local-tts-protocol.test.ts`.

**Interfaces:**
- Consumes: `buildConnectUrl`, `parseServerFrame`, `voiceListMsg`, existing `LocalTtsVoiceInfo`, `createVoice(cfg, name, audio, signal)`.
- Produces: `LocalTtsVoiceInfo` gains `description: string`, `tags: readonly string[]`, `source: "builtin" | "user"`; `voiceCreateMsg(name, description, tags)`; `createVoice(cfg, name, audio, signal, description, tags)`.

- [ ] **Step 1: Failing protocol test** — assert `voiceCreateMsg` carries desc/tags and the `voiceList` parser passes through source/desc/tags. In `local-tts-protocol.test.ts`:

```ts
it("voiceCreateMsg includes description and tags", () => {
  const parsed = JSON.parse(voiceCreateMsg("Nova", "Warm", ["warm", "calm"]));
  expect(parsed).toEqual({ type: "voice.create", name: "Nova", description: "Warm", tags: ["warm", "calm"] });
});

it("parses a voiceList frame with source/description/tags", () => {
  const frame = parseServerFrame(
    JSON.stringify({ type: "voice.list", voices: [{ voiceId: "nova", name: "Nova", description: "Warm", tags: ["warm"], source: "builtin", createdAt: 0, refDurationMs: 0 }] }),
  );
  expect(frame.kind).toBe("voiceList");
  if (frame.kind === "voiceList") {
    expect(frame.voices[0]?.source).toBe("builtin");
    expect(frame.voices[0]?.tags).toEqual(["warm"]);
  }
});
```

- [ ] **Step 2: Run — verify fail**

Run: `source scripts/env.sh && cd gateway && bun run test src/providers/tts/local-tts-protocol.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the protocol.** In `local-tts-protocol.ts`:

```ts
export interface LocalTtsVoiceInfo {
  readonly voiceId: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly source: "builtin" | "user";
  readonly createdAt: number;
  readonly refDurationMs: number;
}
```

```ts
export function voiceCreateMsg(name: string, description: string, tags: readonly string[]): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.VOICE_CREATE, name, description, tags });
}
```

In the `voice.list` frame parser (`FRAME_PARSERS`), map each raw voice with the new fields (defensive defaults for legacy shapes):

```ts
// inside the voiceList parser — normalize each entry
const voices = (record.voices as unknown[]).map((v) => {
  const o = v as Record<string, unknown>;
  return {
    voiceId: String(o.voiceId ?? ""),
    name: String(o.name ?? ""),
    description: typeof o.description === "string" ? o.description : "",
    tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : [],
    source: o.source === "builtin" ? "builtin" : "user",
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    refDurationMs: typeof o.refDurationMs === "number" ? o.refDurationMs : 0,
  } satisfies LocalTtsVoiceInfo;
});
```

- [ ] **Step 4: Thread desc/tags through `createVoice`** in `voice-mgmt-client.ts`:

```ts
export async function createVoice(
  cfg: VoiceMgmtConfig,
  name: string,
  audio: ArrayBuffer,
  signal: AbortSignal,
  description: string,
  tags: readonly string[],
): Promise<Result<VoiceCreated, VoiceOpError>> {
  log.info("create.request", { nameLength: name.length, byteLength: audio.byteLength, tagCount: tags.length });
  const started = Date.now();
  const result = await requestReply<VoiceCreated>(
    cfg,
    (socket) => {
      socket.send(voiceCreateMsg(name, description, tags));
      socket.send(audio);
    },
    (frame) => (frame.kind === "voiceCreated" ? { voiceId: frame.voiceId, name: frame.name } : null),
    signal,
  );
  logOutcome("create", result, started);
  return result;
}
```

(`VoiceListResult.voices` is already `readonly LocalTtsVoiceInfo[]` — no change; the richer fields flow automatically.)

- [ ] **Step 5: Run — verify pass**

Run: `bun run test src/providers/tts/`
Expected: PASS. (Callers of `createVoice` update in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/providers/tts/local-tts-protocol.ts \
        gateway/src/providers/tts/voice-mgmt-client.ts \
        gateway/src/providers/tts/*.test.ts
git commit -m "feat(gateway): voice desc/tags/source through local-tts protocol + client"
```

---

## Task 6: Gateway — one-shot PCM preview synth + WAV wrap

**Files:**
- Create: `gateway/src/providers/tts/preview-synth-client.ts`
- Create: `gateway/src/providers/tts/pcm-to-wav.ts`
- Test: `gateway/src/providers/tts/preview-synth-client.test.ts`, `pcm-to-wav.test.ts`

**Interfaces:**
- Consumes: `buildConnectUrl`, `textMsg`, `endMsg`, `cancelMsg`, `parseServerFrame`, `LocalTtsFrame`, `VoiceMgmtSocketFactory`, `VoiceOpError`.
- Produces: `pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array`; `synthesizePreview(cfg: PreviewSynthConfig, voiceId: string, text: string, signal: AbortSignal): Promise<Result<{ pcm: Uint8Array; sampleRate: number }, VoiceOpError>>` where `PreviewSynthConfig = { url; sampleRate; connectTimeoutMs; opTimeoutMs; socketFactory? }`.

- [ ] **Step 1: Failing WAV test** `pcm-to-wav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pcmToWav } from "./pcm-to-wav.ts";

describe("pcmToWav", () => {
  it("prepends a 44-byte mono/16-bit RIFF header with correct rate + sizes", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]); // 2 samples
    const wav = pcmToWav(pcm, 24000);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(dv.getUint16(22, true)).toBe(1); // channels
    expect(dv.getUint32(24, true)).toBe(24000); // sample rate
    expect(dv.getUint16(34, true)).toBe(16); // bits/sample
    expect(dv.getUint32(40, true)).toBe(4); // data bytes
    expect(wav.length).toBe(44 + 4);
  });
});
```

- [ ] **Step 2: Run — verify fail**; then implement `pcm-to-wav.ts`:

```ts
const HEADER_BYTES = 44;
const PCM_FORMAT_CODE = 1;
const MONO = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = 2;
const FMT_CHUNK_SIZE = 16;
const RIFF_TAIL_BYTES = 36;

/** Wrap raw PCM16-LE mono bytes in a WAV container (44-byte header). */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length);
  const dv = new DataView(out.buffer);
  writeAscii(out, 0, "RIFF");
  dv.setUint32(4, RIFF_TAIL_BYTES + pcm.length, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  dv.setUint32(16, FMT_CHUNK_SIZE, true);
  dv.setUint16(20, PCM_FORMAT_CODE, true);
  dv.setUint16(22, MONO, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * MONO * BYTES_PER_SAMPLE, true);
  dv.setUint16(32, MONO * BYTES_PER_SAMPLE, true);
  dv.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(out, 36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i);
}
```

Run: `bun run test src/providers/tts/pcm-to-wav.test.ts` → PASS.

- [ ] **Step 3: Failing preview-synth test** `preview-synth-client.test.ts` — inject a fake socket that emits `ready`, then two `audio` binary frames, then `done`; assert concatenated PCM + sampleRate. Mirror the fake-socket harness used in `voice-mgmt-client.test.ts` (open on next tick, `send` records, push frames via `onmessage`). Assert:

```ts
it("accumulates audio frames until done and returns PCM + sampleRate", async () => {
  const { cfg, emit } = makeFakeSynth(); // helper builds cfg with a socketFactory
  const p = synthesizePreview(cfg, "nova", "hello", new AbortController().signal);
  emit.open();
  emit.ready();
  emit.audio(new Uint8Array([1, 2]));
  emit.audio(new Uint8Array([3, 4]));
  emit.done();
  const r = await p;
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(Array.from(r.value.pcm)).toEqual([1, 2, 3, 4]);
    expect(r.value.sampleRate).toBe(24000);
  }
});

it("maps a transport failure to VoiceOpError transport", async () => {
  const { cfg, emit } = makeFakeSynth();
  const p = synthesizePreview(cfg, "nova", "hello", new AbortController().signal);
  emit.close();
  const r = await p;
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 4: Run — verify fail**; then implement `preview-synth-client.ts` (mirrors `voice-mgmt-client`'s connect/settle/timer skeleton, but accumulates audio frames and terminates on `done`):

```ts
import type { Result } from "@sentient/protocol";
import { getLog } from "../../logging/logger.ts";
import { type LocalTtsFrame, buildConnectUrl, cancelMsg, endMsg, parseServerFrame, textMsg } from "./local-tts-protocol.ts";
import type { VoiceMgmtSocketFactory, VoiceOpError } from "./voice-mgmt-client.ts";

const log = getLog(["sentient", "tts", "preview-synth"]);
const PREVIEW_SAMPLE_RATE = 24000; // source rate — avoids upsampling; small clip
const READY_STATE_OPEN = 1;

export interface PreviewSynthConfig {
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly opTimeoutMs: number;
  readonly socketFactory?: VoiceMgmtSocketFactory;
}

export interface PreviewPcm {
  readonly pcm: Uint8Array;
  readonly sampleRate: number;
}

export async function synthesizePreview(
  cfg: PreviewSynthConfig,
  voiceId: string,
  text: string,
  signal: AbortSignal,
): Promise<Result<PreviewPcm, VoiceOpError>> {
  if (signal.aborted) return { ok: false, error: { kind: "transport" } };
  const factory = cfg.socketFactory ?? ((url: string) => new WebSocket(url));
  const url = buildConnectUrl(cfg.url, { format: "pcm", sampleRate: PREVIEW_SAMPLE_RATE, voice: voiceId });
  let socket: WebSocket;
  try {
    socket = factory(url);
    socket.binaryType = "arraybuffer";
  } catch {
    return { ok: false, error: { kind: "transport" } };
  }
  return new Promise((resolve) => runPreview(socket, cfg, text, signal, resolve));
}
```

Add the `runPreview` driver: arm connect + op timers (same pattern as `wireOpSocket`), on `open` clear connect-timer + arm op-timer + `send(textMsg(text)); send(endMsg())`; on `message` parse frame — `ready`→ignore, `audio`→push `frame.data` to a `chunks: Uint8Array[]` list, `error`→settle service-error, `done`→settle ok with `concat(chunks)`; on `error`/`close`/abort→settle transport; settle clears both timers, sends `cancelMsg()` best-effort, closes socket. Keep each function ≤40 lines (split `runPreview`/`onOpen`/`onMessage`/`makeSettle` like `voice-mgmt-client.ts`). `concat` helper sums lengths → one `Uint8Array`.

- [ ] **Step 5: Run — verify pass**

Run: `bun run test src/providers/tts/preview-synth-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/providers/tts/preview-synth-client.ts \
        gateway/src/providers/tts/pcm-to-wav.ts \
        gateway/src/providers/tts/preview-synth-client.test.ts \
        gateway/src/providers/tts/pcm-to-wav.test.ts
git commit -m "feat(gateway): one-shot PCM preview synth + WAV wrap"
```

---

## Task 7: Gateway voices handler — create-with-meta, preview route, guard widen, 409

**Files:**
- Modify: `gateway/src/api/handlers/voices.ts`
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`, `gateway/src/server.ts`
- Test: `gateway/src/api/handlers/voices.test.ts`

**Interfaces:**
- Consumes: `createVoice(cfg,name,audio,signal,description,tags)` (Task 5), `synthesizePreview` + `pcmToWav` (Task 6), `services.ttsConfig.preview_greetings/preview_timeout_ms/voice_*` (Task 4).
- Produces: `POST /api/v1/voices` accepts `description` + repeated `tags`; `POST /api/v1/voices/:id/preview` → `200 audio/wav`; DELETE guard widened; `builtin-voice` → 409. `VoicesHandlerDeps` gains `previewGreetings: readonly string[]`, `previewTimeoutMs: number`, `descriptionMaxLen: number`, `tagMaxLen: number`, `maxTags: number`.

- [ ] **Step 1: Failing handler tests** — add to `voices.test.ts` (mirror the existing fake-socket + deps harness):

```ts
it("POST create forwards description and tags", async () => { /* assert voiceCreateMsg payload seen by fake socket has description+tags */ });
it("POST create rejects over-cap tags with 422", async () => { /* tags.length > maxTags */ });
it("POST /voices/:id/preview returns audio/wav", async () => {
  // fake synth socket emits ready/audio/done
  const res = await handler(previewRequest("nova"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(44);
});
it("DELETE accepts a slug id shape", async () => { /* builtin-shaped id passes the guard, reaches service */ });
it("maps service builtin-voice error to 409", async () => {
  // fake delete socket emits {type:"error", reason:"builtin-voice"}
  expect(res.status).toBe(409);
});
it("preview maps tts-unreachable to 502", async () => { /* socket closes before ready */ });
```

- [ ] **Step 2: Run — verify fail**

Run: `bun run test src/api/handlers/voices.test.ts`
Expected: FAIL.

- [ ] **Step 3: Widen the id guard + add constants** in `voices.ts`:

```ts
const HTTP_CONFLICT = 409;
const VOICE_ID_SHAPE_RE = /^[a-z0-9-]{1,32}$/; // hex (32) OR built-in slug; blocks traversal shapes
const BUILTIN_VOICE_REASON = "builtin-voice";
const VOICE_PREVIEW_PATH_RE = /^\/api\/v1\/voices\/([^/]+)\/preview$/;
```

- [ ] **Step 4: Parse desc/tags in `parseCreateForm`** (validate caps from deps):

```ts
  const description = typeof form.get("description") === "string" ? (form.get("description") as string).trim() : "";
  if (description.length > deps.descriptionMaxLen) return { ok: false, error: `description exceeds ${deps.descriptionMaxLen} chars` };
  const tags = form.getAll("tags").filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  if (tags.length > deps.maxTags) return { ok: false, error: `too many tags (max ${deps.maxTags})` };
  if (tags.some((t) => t.length > deps.tagMaxLen)) return { ok: false, error: `tag exceeds ${deps.tagMaxLen} chars` };
```

(Thread `deps` into `parseCreateForm`, and pass `description`, `tags` in the returned `CreateFormInput`.) Update `handleVoicesPost` to call `createVoice(buildCfg(deps), name, audio, request.signal, description, tags)`.

- [ ] **Step 5: Add the preview route + handler.** In `handleVoices` dispatch, before the id-match:

```ts
  const previewMatch = VOICE_PREVIEW_PATH_RE.exec(pathname);
  if (previewMatch) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: HTTP_METHOD });
    return handleVoicesPreview(deps, decodeURIComponent(previewMatch[1] ?? ""), request.signal);
  }
```

```ts
async function handleVoicesPreview(deps: VoicesHandlerDeps, voiceId: string, signal: AbortSignal): Promise<Response> {
  const greeting = deps.previewGreetings[Math.floor(Math.random() * deps.previewGreetings.length)] ?? "Hello.";
  log.info("preview.request", { voiceId, greetingLen: greeting.length });
  const result = await synthesizePreview(
    { url: deps.ttsUrl, connectTimeoutMs: deps.connectTimeoutMs, opTimeoutMs: deps.previewTimeoutMs, ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}) },
    voiceId,
    greeting,
    signal,
  );
  if (!result.ok) return mapVoiceOpError(result.error);
  const wav = pcmToWav(result.value.pcm, result.value.sampleRate);
  log.info("preview.success", { voiceId, bytes: wav.byteLength });
  return new Response(wav, { status: HTTP_OK, headers: { "content-type": "audio/wav" } });
}
```

- [ ] **Step 6: Map `builtin-voice` → 409** in `mapVoiceOpError`:

```ts
    case "service-error":
      if (error.reason === BUILTIN_VOICE_REASON) return jsonError(HTTP_CONFLICT, BUILTIN_VOICE_REASON);
      return Response.json({ error: "voice-op-failed", reason: error.reason }, { status: HTTP_UNPROCESSABLE });
```

- [ ] **Step 7: Extend `VoicesHandlerDeps` + populate** it. In `voices.ts`, add `previewGreetings`, `previewTimeoutMs`, `descriptionMaxLen`, `tagMaxLen`, `maxTags`. In `server.ts` `createVoicesHandler({...})`:

```ts
    previewGreetings: services.ttsConfig.preview_greetings,
    previewTimeoutMs: services.ttsConfig.preview_timeout_ms,
    descriptionMaxLen: services.ttsConfig.voice_description_max_len,
    tagMaxLen: services.ttsConfig.voice_tag_max_len,
    maxTags: services.ttsConfig.voice_max_tags,
```

(`services.ttsConfig` already exists — `cfg.tts`; no `create-gateway-services.ts` change needed beyond confirming the type flows. If `ttsConfig` type is narrowed, ensure it's the full `TTSConfig`.)

- [ ] **Step 8: Run — verify pass + typecheck**

Run: `bun run test src/api/handlers/voices.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add gateway/src/api/handlers/voices.ts gateway/src/server.ts
git commit -m "feat(gateway): voice create metadata + live preview endpoint + builtin-delete 409"
```

---

## Task 8: WebUI services + use-voices — metadata + preview blob

**Files:**
- Modify: `gateway/webui/src/services/_helpers.ts`, `src/services/voices-api.ts`, `src/hooks/use-voices.ts`
- Test: `gateway/webui/src/hooks/use-voices.test.ts`

**Interfaces:**
- Produces: `handleBlobFetch(fetchPromise): Promise<Result<Blob>>`; `VoiceSummary` +`description: string` +`tags: string[]` +`source: "builtin"|"user"`; `VoicesApi.createVoice(token, name, audio, description, tags)`; `VoicesApi.previewVoice(token, voiceId): Promise<Result<Blob>>`; `UseVoices.createVoice(audio, name, description, tags)`.

- [ ] **Step 1: Add `handleBlobFetch`** to `_helpers.ts`:

```ts
export async function handleBlobFetch(fetchPromise: Promise<Response>): Promise<Result<Blob>> {
  let response: Response;
  try {
    response = await fetchPromise;
  } catch (err: unknown) {
    log.warn("network-error", { error: String(err) });
    return { ok: false, error: NETWORK_ERROR };
  }
  if (!response.ok) {
    return { ok: false, error: { status: response.status, code: `http-${response.status}` } };
  }
  return { ok: true, value: await response.blob() };
}
```

- [ ] **Step 2: Extend `voices-api.ts`.** `VoiceSummary`:

```ts
export interface VoiceSummary {
  voiceId: string;
  name: string;
  description: string;
  tags: string[];
  source: "builtin" | "user";
  createdAt: number;
  refDurationMs: number;
}
```

`createVoice` (append form fields) + `previewVoice`:

```ts
    createVoice(token, name, audio, description, tags) {
      log.debug("createVoice", { nameLength: name.length, audioBytes: audio.size, tagCount: tags.length });
      const form = new FormData();
      form.set("name", name);
      form.set("description", description);
      for (const t of tags) form.append("tags", t);
      form.set("audio", audio, "reference.wav");
      return handleFetch<CreateVoiceResult>(
        fetch(`${base}/api/v1/voices`, { method: "POST", headers: bearerHeaders(token), body: form }),
      );
    },

    previewVoice(token, voiceId) {
      log.debug("previewVoice", { voiceId });
      return handleBlobFetch(
        fetch(`${base}/api/v1/voices/${encodeURIComponent(voiceId)}/preview`, {
          method: "POST",
          headers: bearerHeaders(token),
        }),
      );
    },
```

Update the `VoicesApi` interface signatures accordingly (`createVoice(token, name, audio, description, tags)`, `previewVoice(token, voiceId): Promise<Result<Blob>>`) and import `handleBlobFetch`.

- [ ] **Step 3: Extend `use-voices.ts`.** `createVoice(audio, name, description, tags)`:

```ts
  async function createVoice(audio: Blob, name: string, description: string, tags: string[]): Promise<VoiceMutationResult> {
    log.debug("createVoice.request", { audioBytes: audio.size, nameLength: name.length, tagCount: tags.length });
    const r = await api.createVoice(token, name, audio, description, tags);
    ...
  }
```

Update `UseVoices.createVoice` type. (Leave `previewVoice` out of this hook — the preview lives in `use-voice-preview` in Task 12, calling `createVoicesApi().previewVoice` directly.)

- [ ] **Step 4: Update `use-voices.test.ts`** — the existing create test now passes `description`/`tags`; add a fake `VoicesApi.createVoice` capturing them. Assert they reach the api.

- [ ] **Step 5: Run — verify pass + typecheck**

Run: `source scripts/env.sh && cd gateway/webui && bun run test src/hooks/use-voices.test.ts && bun run typecheck`
Expected: `use-voices` tests PASS; typecheck will FAIL on `VoicesPanel`/`VoiceRecorder` (old `createVoice(audio,name)` callsites) — that's expected and fixed in Tasks 11–12. If typecheck is required green here, defer it: run `bun run test` only for this task and note the callsite breakage is resolved by Task 12.

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/services/_helpers.ts gateway/webui/src/services/voices-api.ts \
        gateway/webui/src/hooks/use-voices.ts gateway/webui/src/hooks/use-voices.test.ts
git commit -m "feat(webui): voice metadata fields + preview blob fetch"
```

---

## Task 9: WebUI — pure filter util + VoiceFilterBar

**Files:**
- Create: `gateway/webui/src/components/voices/voice-filter.ts`
- Create: `gateway/webui/src/components/voices/VoiceFilterBar.tsx`

No unit test (pure util + presentational — per test-lean doctrine; verified by typecheck + Task 14 E2E).

**Interfaces:**
- Produces: `type VoiceSource = "all" | "builtin" | "user"`; `deriveTagOptions(packs: VoiceSummary[]): string[]`; `filterPacks(packs, { q, source, tags }): VoiceSummary[]`; `VoiceFilterBar` props `{ q, source, activeTags, allTags, onQ, onSource, onToggleTag }`.

- [ ] **Step 1: Write `voice-filter.ts`:**

```ts
import type { VoiceSummary } from "../../services/voices-api.ts";

export type VoiceSource = "all" | "builtin" | "user";

/** Sorted union of every tag across packs. */
export function deriveTagOptions(packs: VoiceSummary[]): string[] {
  const set = new Set<string>();
  for (const p of packs) for (const t of p.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface VoiceFilterState {
  q: string;
  source: VoiceSource;
  tags: string[];
}

/** Source filter + case-insensitive search over name+description+tags + all-selected-tags-present. */
export function filterPacks(packs: VoiceSummary[], f: VoiceFilterState): VoiceSummary[] {
  const q = f.q.trim().toLowerCase();
  return packs.filter((p) => {
    if (f.source !== "all" && p.source !== f.source) return false;
    if (f.tags.length > 0 && !f.tags.every((t) => p.tags.includes(t))) return false;
    if (q === "") return true;
    const hay = [p.name, p.description, ...p.tags].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
```

- [ ] **Step 2: Write `VoiceFilterBar.tsx`:**

```tsx
import type { JSX } from "preact";
import { SearchField } from "../settings/primitives/search-field.tsx";
import { Segmented } from "../settings/primitives/segmented.tsx";
import { Chip } from "../settings/primitives/chip.tsx";
import type { VoiceSource } from "./voice-filter.ts";

const SOURCE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "builtin", label: "Built-in" },
  { value: "user", label: "Yours" },
];

export interface VoiceFilterBarProps {
  q: string;
  source: VoiceSource;
  activeTags: string[];
  allTags: string[];
  onQ: (v: string) => void;
  onSource: (v: VoiceSource) => void;
  onToggleTag: (tag: string) => void;
}

export function VoiceFilterBar(props: VoiceFilterBarProps): JSX.Element {
  return (
    <div class="voice-filter">
      <div class="voice-filter-row">
        <SearchField
          value={props.q}
          onChange={(e) => props.onQ((e.target as HTMLInputElement).value)}
          placeholder="Search voices"
          fullWidth
        />
        <Segmented value={props.source} onChange={(v) => props.onSource(v as VoiceSource)} options={SOURCE_OPTIONS} />
      </div>
      {props.allTags.length > 0 && (
        <div class="voice-filter-tags">
          {props.allTags.map((tag) => (
            <Chip key={tag} active={props.activeTags.includes(tag)} onClick={() => props.onToggleTag(tag)}>
              {tag}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd gateway/webui && bun run typecheck` (expect the same deferred VoicesPanel breakage as Task 8 — the two new files themselves must be clean).

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/voices/voice-filter.ts gateway/webui/src/components/voices/VoiceFilterBar.tsx
git commit -m "feat(webui): voice pack filter util + filter bar"
```

---

## Task 10: WebUI — VoicePackTile + VoicePackGrid

**Files:**
- Create: `gateway/webui/src/components/voices/VoicePackTile.tsx`, `VoicePackGrid.tsx`

Presentational — no unit test.

**Interfaces:**
- Produces:
  - `VoicePackTile` props `{ pack: VoiceSummary; isActive: boolean; previewState: "idle"|"loading"|"playing"; previewDisabled: boolean; busy: boolean; onPlay: () => void; onPick: () => void; onDelete?: () => void }`.
  - `VoicePackGrid` props `{ packs: VoiceSummary[]; loading: boolean; error: string | null; activeId: string; previewId: string | null; previewLoadingId: string | null; previewDisabled: boolean; busy: boolean; onPlay: (id: string) => void; onPick: (id: string) => void; onDelete: (id: string) => void }`.

- [ ] **Step 1: Write `VoicePackTile.tsx`** — badge (♦ builtin / ◐ user), name, description, tags, Play (icon `play`/`pause`, spinner class when loading), radio pick, delete only when `pack.source === "user"`:

```tsx
import type { JSX } from "preact";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { Btn } from "../settings/primitives/btn.tsx";
import { Icon } from "../common/icon.tsx";

export interface VoicePackTileProps {
  pack: VoiceSummary;
  isActive: boolean;
  previewState: "idle" | "loading" | "playing";
  previewDisabled: boolean;
  busy: boolean;
  onPlay: () => void;
  onPick: () => void;
  onDelete?: () => void;
}

export function VoicePackTile(props: VoicePackTileProps): JSX.Element {
  const { pack, isActive } = props;
  const playIcon = props.previewState === "playing" ? "pause" : "play";
  return (
    <div class={["vp-tile", isActive && "on", `vp-${pack.source}`].filter(Boolean).join(" ")}>
      <div class="vp-tile-head">
        <span class="vp-name">{pack.name}</span>
        <span class={`vp-badge vp-badge-${pack.source}`}>{pack.source === "builtin" ? "Built-in" : "Yours"}</span>
      </div>
      {pack.description && <div class="vp-desc">{pack.description}</div>}
      {pack.tags.length > 0 && (
        <div class="vp-tags">{pack.tags.map((t) => <span key={t} class="vp-tag">#{t}</span>)}</div>
      )}
      <div class="vp-acts">
        <Btn
          kind="ghost"
          size="sm"
          disabled={props.previewDisabled || props.previewState === "loading"}
          onClick={props.onPlay}
          title={props.previewDisabled ? "Can't preview while speaking" : "Play a sample"}
        >
          <Icon name={props.previewState === "loading" ? "waveform" : playIcon} size={12} />
        </Btn>
        <Btn kind={isActive ? "secondary" : "ghost"} size="sm" disabled={props.busy || isActive} onClick={props.onPick}>
          {isActive ? "Active" : "Pick"}
        </Btn>
        {props.onDelete && (
          <Btn kind="ghost" size="sm" danger disabled={props.busy} onClick={props.onDelete} title="Delete voice">
            <Icon name="trash" size={12} />
          </Btn>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `VoicePackGrid.tsx`** — error/loading/empty guards, then map tiles; delete-confirm `Modal` gated on local `confirmId` (mirror the current `VoiceList` confirm pattern):

```tsx
export interface VoicePackGridProps {
  packs: VoiceSummary[];
  loading: boolean;
  error: string | null;
  activeId: string;
  previewId: string | null;
  previewLoadingId: string | null;
  previewDisabled: boolean;
  busy: boolean;
  onPlay: (id: string) => void;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}
```

Render logic: `error` → `<p class="pane-error">`; `loading` → skeleton; `packs.length === 0` → empty hint ("No voices match — clear filters or add your own."); else `<div class="vp-grid">` mapping `VoicePackTile` with `previewState` derived (`previewLoadingId===id? "loading" : previewId===id? "playing" : "idle"`), `onDelete` only for `pack.source === "user"` (→ opens confirm modal). Keep the render function ≤40 lines by extracting `renderTiles`.

- [ ] **Step 3: Typecheck** (new files clean).

Run: `cd gateway/webui && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/voices/VoicePackTile.tsx gateway/webui/src/components/voices/VoicePackGrid.tsx
git commit -m "feat(webui): voice pack tile + grid"
```

---

## Task 11: WebUI — VoiceCapture + AddVoiceModal

**Files:**
- Create: `gateway/webui/src/components/voices/VoiceCapture.tsx` (capture-only, extracted from `VoiceRecorder`)
- Create: `gateway/webui/src/components/voices/AddVoiceModal.tsx`

Presentational — no unit test.

**Interfaces:**
- Consumes: `createWebAudioCapture`, `encodeWav`, `CAPTURE_SAMPLE_RATE`, `MIN_RECORDING_SECONDS` (=6) — from the existing `VoiceRecorder.tsx` logic.
- Produces:
  - `VoiceCapture` props `{ onBlob: (audio: Blob, durationMs: number) => void; disabled?: boolean }` — record/review states, emits a WAV blob (no name field, no create button).
  - `AddVoiceModal` props `{ open: boolean; busy: boolean; onClose: () => void; onCreate: (audio: Blob, name: string, description: string, tags: string[]) => Promise<boolean> }`.

- [ ] **Step 1: Write `VoiceCapture.tsx`** — lift the record/review state machine + timer + `encodeWav` from `VoiceRecorder.tsx`, dropping the name input and create button. On review "Use this take" → `onBlob(blob, durationMs)`; keep re-record. Reuse `MIN_RECORDING_SECONDS`, `TIMER_TICK_MS`, capture via `createWebAudioCapture` + `framesRef` + `encodeWav(frames, CAPTURE_SAMPLE_RATE)`.

- [ ] **Step 2: Write `AddVoiceModal.tsx`** — owns name/description/tags + Record|Upload segmented; Record renders `VoiceCapture`, Upload renders a file input (`.wav,.flac,.ogg`); both set a local `audio: Blob | null`. Submit calls `onCreate(audio, name, description, tags)` then closes on `true`:

```tsx
import { useState } from "preact/hooks";
import { Modal } from "../settings/primitives/modal.tsx";
import { Segmented } from "../settings/primitives/segmented.tsx";
import { TextField } from "../settings/primitives/text-field.tsx";
import { Btn } from "../settings/primitives/btn.tsx";
import { Chip } from "../settings/primitives/chip.tsx";
import { VoiceCapture } from "./VoiceCapture.tsx";

const SUGGESTED_TAGS = ["warm", "calm", "deep", "bright", "family", "kids", "news", "soft"];
const MODE_OPTIONS = [{ value: "record", label: "Record" }, { value: "upload", label: "Upload" }];
const UPLOAD_TYPES = ".wav,.flac,.ogg";
```

Component holds `mode` ("record"|"upload"), `name`, `description`, `tags: string[]`, `tagDraft`, `audio: Blob | null`. Tag UI: active/suggested chips + a text input that appends `tagDraft` on Enter (dedup, respect an 8-tag cap constant). Footer: `Cancel` + `Clone voice` (disabled unless `audio && name.trim()`). Render inside `<Modal title="Add a voice" onClose={onClose} footer={...}>`; return `null` when `!open`. Keep the body under the line/function caps by extracting a `TagEditor` sub-component in the same file (private helper, allowed by the co-location rule).

- [ ] **Step 3: Typecheck** (new files clean).

Run: `cd gateway/webui && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/voices/VoiceCapture.tsx gateway/webui/src/components/voices/AddVoiceModal.tsx
git commit -m "feat(webui): voice capture + add-voice modal with metadata editor"
```

---

## Task 12: WebUI — use-voice-preview + VoicesPanel rewrite + speaking guard

**Files:**
- Create: `gateway/webui/src/hooks/use-voice-preview.ts`
- Rewrite: `gateway/webui/src/components/voices/VoicesPanel.tsx`
- Delete: `gateway/webui/src/components/voices/VoiceList.tsx`, `VoiceRecorder.tsx`, `VoiceList.test.tsx`, `VoiceRecorder.test.tsx`
- Modify: `gateway/webui/src/app.tsx`, `gateway/webui/src/components/settings/settings-view.tsx`

Presentational/hook — no unit test (the hook's single-flight/abort logic is UI glue; verified by Task 14 E2E). 

**Interfaces:**
- Consumes: `createVoicesApi().previewVoice`, `createUseVoices` (Task 8), `filterPacks`/`deriveTagOptions` (Task 9), `VoicePackGrid` (Task 10), `AddVoiceModal` (Task 11).
- Produces: `use-voice-preview` returns `{ previewId: Signal<string|null>; loadingId: Signal<string|null>; play(voiceId): Promise<void>; stop(): void }`. `VoicesPanelProps` gains `assistantSpeaking?: ReadonlySignal<boolean>`.

- [ ] **Step 1: Write `use-voice-preview.ts`** — single-flight: abort/stop prior on each `play`; fetch blob → `URL.createObjectURL` → `new Audio` → play; revoke on end/stop; toast on error:

```ts
import { type ReadonlySignal, signal } from "@preact/signals";
import { createLogger } from "@sentient/web-sdk";
import { createVoicesApi } from "../services/voices-api.ts";

const log = createLogger(["sentient", "webui", "voices", "preview"]);

export interface UseVoicePreview {
  readonly previewId: ReadonlySignal<string | null>;
  readonly loadingId: ReadonlySignal<string | null>;
  play(voiceId: string): Promise<void>;
  stop(): void;
}

export function createUseVoicePreview(token: string, onError: () => void): UseVoicePreview {
  const api = createVoicesApi();
  const previewId = signal<string | null>(null);
  const loadingId = signal<string | null>(null);
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;

  function stop(): void {
    if (audio) { audio.pause(); audio = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
    previewId.value = null;
    loadingId.value = null;
  }

  async function play(voiceId: string): Promise<void> {
    stop();
    loadingId.value = voiceId;
    log.debug("preview.play", { voiceId });
    const r = await api.previewVoice(token, voiceId);
    if (loadingId.value !== voiceId) return; // superseded
    loadingId.value = null;
    if (!r.ok) { log.warn("preview.failed", { voiceId, code: r.error.code }); onError(); return; }
    url = URL.createObjectURL(r.value);
    audio = new Audio(url);
    previewId.value = voiceId;
    audio.addEventListener("ended", stop, { once: true });
    audio.play().catch((e) => { log.warn("preview.audio-failed", { voiceId, error: String(e) }); stop(); });
  }

  return { previewId, loadingId, play, stop };
}
```

- [ ] **Step 2: Rewrite `VoicesPanel.tsx`** — data hook + filter state + modal + preview + speaking guard:

Key structure:
```tsx
export interface VoicesPanelProps {
  token: string;
  activeVoiceId: string;
  onActiveVoiceChanged: (voiceId: string) => void;
  assistantSpeaking?: ReadonlySignal<boolean>;
}
```
- `hook = useMemo(() => createUseVoices({ token, initialActiveId, onActiveVoiceChanged }), [token])`; `useEffect load`; `syncActiveId`.
- `preview = useMemo(() => createUseVoicePreview(token, () => toast.show("Couldn't play preview", "error")), [token])`; `useEffect(() => preview.stop, [preview])` cleanup.
- Filter state: `useState` for `q`, `source`, `tags`. `const all = hook.voices.value ?? []`; `const shown = filterPacks(all, { q, source, tags })`; `const allTags = deriveTagOptions(all)`.
- `previewDisabled = assistantSpeaking?.value ?? false`.
- `onPlay(id)`: if `previewDisabled` → toast + return; else if `preview.previewId.value === id` → `preview.stop()` else `preview.play(id)`.
- Header action button "＋ Add voice" (`PaneHead action`), opens `AddVoiceModal`.
- Render `PaneHead` + `VoiceFilterBar` + `VoicePackGrid` + `AddVoiceModal`. Extract handlers to keep the component function under caps; consider a `voices-panel-handlers.ts` if it approaches 250 lines.

- [ ] **Step 3: Plumb `assistantSpeaking`.** In `app.tsx`, add `const assistantSpeaking = useComputed(() => client.cycleStatus.value === "speaking");` and pass to `<SettingsView ... assistantSpeaking={assistantSpeaking} />`. In `settings-view.tsx`, accept the prop and forward to `<VoicesPanel ... assistantSpeaking={assistantSpeaking} />`. (Type: `ReadonlySignal<boolean>`, imported from `@preact/signals`.)

- [ ] **Step 4: Delete the old components + tests.**

```bash
git rm gateway/webui/src/components/voices/VoiceList.tsx gateway/webui/src/components/voices/VoiceList.test.tsx \
       gateway/webui/src/components/voices/VoiceRecorder.tsx gateway/webui/src/components/voices/VoiceRecorder.test.tsx
```

- [ ] **Step 5: Run — typecheck + webui test suite**

Run: `source scripts/env.sh && cd gateway/webui && bun run typecheck && bun run test`
Expected: PASS (all old callsite breakage now resolved). Fix any remaining references to deleted files.

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-preview.ts gateway/webui/src/components/voices/VoicesPanel.tsx \
        gateway/webui/src/app.tsx gateway/webui/src/components/settings/settings-view.tsx
git commit -m "feat(webui): unified voice packs panel with live preview + speaking guard"
```

---

## Task 13: WebUI — wizard voice step reuses the pick grid (pick-only)

**Files:**
- Modify: the active wizard voice step (`gateway/webui/src/components/account-wizard/step-voice.tsx` — confirm via `AccountWizard.tsx` import; the `components/wizard/steps/step-voice.tsx` variant may be unused).

Presentational — no unit test. Low priority; may be deferred if it endangers the slice.

**Interfaces:**
- Consumes: `VoicePackGrid` (Task 10), `createUseVoices` or a lightweight list fetch, `filterPacks`.
- Produces: onboarding voice pick from built-ins (no add/delete, no preview delete affordance).

- [ ] **Step 1: Confirm the active step** — `git grep -n "step-voice" gateway/webui/src/components/*wizard*` and read `AccountWizard.tsx` to see which `step-voice` is imported.

- [ ] **Step 2: Render a pick-only grid** in that step — load voices, show `VoicePackGrid` with `onDelete` a no-op / omitted (grid already hides delete for `source !== "user"`; for onboarding pass an `onDelete` that never triggers because only built-ins are shown, or filter `source==="builtin"`). Pick sets the wizard's draft `voice.id`. Reuse `filterPacks(all, { q:"", source:"builtin", tags:[] })` to show built-ins only. Preview optional — safe to include (no speaking during onboarding) or omit.

- [ ] **Step 3: Typecheck + smoke the wizard renders**

Run: `cd gateway/webui && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/account-wizard/step-voice.tsx
git commit -m "feat(webui): onboarding voice step reuses the voice pack grid"
```

---

## Task 14: E2E sweep + testing-knowledge cases

**Files:**
- Modify: `agents/docs/testing-knowledge.md` (add reusable cases)
- Evidence under the Playwright output dir.

Drive Playwright MCP against a **live local stack**: rebuild the branch gateway (`deploy/macos/`), restart the host TTS service (with built-in packs shipped), log in. Cover desktop (1280×900) + mobile (390×844). This is the acceptance gate — a case is green only when the user-visible behavior AND the log trail match (no unexpected WARN/ERROR).

**E2E matrix (from spec §11):**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| browse-builtins | desktop | logged in, ≥4 built-ins shipped | open Voices | grid shows built-in packs, Built-in badge, tags | `voices.list` count≥4, source=builtin |
| filter-search | desktop | built-ins present | type "deep" | grid narrows to name/desc/**tag** matches | no error |
| filter-source | mobile 390 | built-ins + ≥1 user pack | toggle "Yours" | only user packs shown | — |
| filter-tag | desktop | tagged packs | click a tag chip | only packs with that tag | — |
| preview-play | desktop | built-in pack | click ▶ | spinner → audible greeting in that voice | gateway `preview.success` audio/wav bytes>0 |
| preview-abort | desktop | preview playing | click another ▶ | first stops, second plays | prior superseded, no overlap |
| preview-tts-down | desktop | TTS service stopped | click ▶ | error toast, no crash | `502` / `preview.failed` WARN |
| add-record | desktop | mic available | record ≥6s + name/desc/tags → Clone | pack appears, auto-picked | `voice.create` w/ desc+tags, `create.success` |
| add-upload | mobile 390 | wav fixture | upload + meta → Clone | pack appears | `create.success` |
| add-too-short | desktop | — | record 2s → Clone | 422 toast, no orphan pack | `create.invalid`/422, no `create.success` |
| pick-builtin | desktop | built-ins present | pick a built-in | radio active; next reply uses it | profile `voice.id=<slug>`, refreshVoice |
| delete-user | desktop | ≥1 user pack, active | delete it | pack gone; active resets to default | `delete.success`, profile reset |
| builtin-no-delete | desktop | built-in pack | inspect built-in tile | no delete affordance | crafted DELETE → 409 `builtin-voice` |
| speaking-guard | desktop | assistant speaking | attempt ▶ | Play disabled during speech | preview not dispatched |

- [ ] **Step 1: Build + boot the local stack** (`deploy/macos/` rebuild gateway, restart host TTS service), confirm `curl :8771/health` = 1.0.0 and built-in packs present.
- [ ] **Step 2: Run every matrix row** with Playwright MCP (desktop + the two mobile-viewport rows via `browser_resize`), capturing screenshots + console + network + the gateway/service log trail at each decision point.
- [ ] **Step 3: Verify the log trail** for each case (no unexpected WARN/ERROR; the expected trail present).
- [ ] **Step 4: Add reusable cases** to `agents/docs/testing-knowledge.md` (indexed by surface): `voices-browse-filter`, `voices-preview`, `voices-builtin-no-delete`, `voices-add-with-meta`.
- [ ] **Step 5: Pre-handover gate** — `source scripts/env.sh && bun run ci` (lint + typecheck + unit) green; service `uv run pytest -q` green; deployable artifact built.
- [ ] **Step 6: Commit**

```bash
git add agents/docs/testing-knowledge.md
git commit -m "test(voices): e2e sweep + reusable case library for voice pack UX"
```

---

## Deferred / risks (carry to final review)

- **Speaking-guard plumbing** (Task 12 Step 3) is new cross-tree wiring — verify the signal stays reactive through `SettingsView`. If the prop can't be threaded cleanly, fall back to a `preview-only` guard (in-flight single-flight) and note the "disable during speech" as a follow-up.
- **Built-in conds are model-version-tied** — record the model version in `LICENSES.md`; a model bump needs a regenerate (Task 3).
- **Preview vs live-reply contention** — the webui guard is the mitigation; if smoke shows jitter, add a gateway-side reject during an active cycle (out of scope here).
- **Wizard step (Task 13)** is low-priority; may be dropped from the slice without blocking the core feature.
```
