# TTS Engine Swap (Chatterbox → Qwen3-TTS) + Full Rename to `local-tts` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the English-only Chatterbox-Turbo TTS engine with multilingual **Qwen3-TTS** (English + Mandarin + auto-detect), and rename the whole service from `Chatterbox*`/`chatterbox_tts` to the engine-neutral **`local-tts`** — no `chatterbox` left in active code.

**Architecture:** The gateway↔service WS protocol is already engine-neutral (`local-tts`: text in → audio out, `voice.create/list/delete`), so the swap is **service-internal** + a rename; the gateway only needs comment/CONTRACT renames. Qwen3-TTS clones from a **raw reference wav** (ECAPA speaker encoder, in-context) rather than precomputed `conds`, so `voice_store` stores `ref.wav` instead of `conds.safetensors`. Language is `lang_code="auto"` per synthesis (bench-verified auto-detect for en/zh).

**Tech Stack:** Python 3.11 + mlx-audio (`qwen3_tts` model) + websockets (service); Bun/TS gateway (comment renames only). Bench evidence (this machine): qwen3-tts RTF **~0.41 flat** across en/zh + short/long, streaming TTFA ~850ms, ref-audio-only cloning works, `lang_code="auto"` detects zh. Model: `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit`, output 24 kHz.

## Global Constraints

- **Branch:** `feature/local-tts-chatterbox` (continue; the branch name itself is historical — do NOT rename the git branch).
- **New name = `local-tts`** (user-chosen, engine-neutral, matches the gateway's existing `local-tts` provider): service dir `capabilityServices/LocalTTSService`; Python package `local_tts`; launchd label `io.dev32.sentient.local-tts`; host config `~/.sentient/local-tts/`; env vars `LOCAL_TTS_*` (was `CHATTERBOX_TTS_*`); logger tags `local_tts.*`.
- **Rename ACTIVE refs only.** Rename: the service, config, deploy, `.claude/rules`, `CLAUDE.md` project map, `CONTRACT.md`, active `agents/docs`, memory. **KEEP as accurate history (do NOT rename):** `docs/superpowers/plans/2026-07-08-local-chatterbox-tts.md`, `docs/superpowers/specs/2026-07-08-local-chatterbox-tts-design.md`, this branch's `.superpowers/sdd/progress.md`, and `pocs/localTTS/chatterbox/` (a POC exploration record). Also do NOT touch anything under `.venv/`.
- **Qwen3-TTS specifics:** model `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit`; clone via `generate(text, ref_audio=<wav path|array>, lang_code="auto", stream=True, streaming_interval=<cfg>)`; `ref_text` is OPTIONAL and we do NOT have sample transcripts → always ref-audio-only; result chunks expose `.audio` (mx.array) at 24 kHz.
- **The gateway wire protocol does NOT change.** `voice.create` still sends a name + a binary reference clip; `voice.list`/`voice.delete`/synthesis frames are unchanged. The Fish + voice-UX features call this wire and MUST keep working unmodified.
- **The Chatterbox `streaming_interval` vocoder-per-chunk pathology does NOT apply to Qwen** (bench RTF is flat 0.41 regardless of chunk size). Keep the config key, but its tuning rationale changes — update the comment.
- Python service rules: files ≤300 lines, functions ≤40, no magic strings, `logging.getLogger("local_tts.*")`, log ids/lengths only, config fail-loud. Gateway TS rules unchanged. Tests: service `uv run pytest` (from the renamed dir), gateway `bun test` native, webui vitest.
- Commit format `type(scope): description`. Prefer `git mv` for renames (preserves history).

## File Structure (after rename)

`capabilityServices/LocalTTSService/`
- `src/local_tts/engine.py` — NEW qwen wrapper (replaces `chatterbox_mlx.py`).
- `src/local_tts/voice_store.py` — stores `ref.wav` (was `conds.safetensors`).
- `src/local_tts/{connection_session,synthesis,synth_worker,server,config,wire_protocol,pipeline_events,pack_meta,builtin_library,event_sender,event_logger,health_server,metrics,synth_metrics,audio_constants,__main__,__init__}.py` — renamed package, adapted where they touched the engine/conds.
- `src/local_tts/encoders/{base,opus_encoder,pcm_encoder}.py` — unchanged logic, renamed package.
- `src/local_tts/voices_library/<slug>/{ref.wav, meta.json}` — built-ins as ref wavs.
- `scripts/{build_builtin_voices.py, download_models.py}` — updated for qwen.
- `tests/` — `test_local_tts_engine.py` (was `test_chatterbox_mlx.py`) + adapted store/config tests.
- `config/config.example.yaml`, `CONTRACT.md`, `README.md`, `pyproject.toml`.

`deploy/mac-prod/native/local-tts.sh` (was `chatterbox-tts.sh`), `tts-backend.py`; `deploy/setup-prod.py`, `deploy/mac-prod/deploy.conf`.

---

## Task 1: Qwen3-TTS engine wrapper

**Files:**
- Create: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/qwen_engine.py` (temporary path — the package rename is Task 6; build it in the current tree first, then it moves with the package). Name the module `local_tts_engine`-to-be; for now `qwen_engine.py`.
- Modify: `pyproject.toml` (confirm the `mlx-audio` version that ships `qwen3_tts`; add `download_models.py` entry for the qwen model).
- Test: `tests/test_qwen_engine.py` (`@pytest.mark.live`).

**Interfaces:**
- Produces: `class QwenEngine` with:
  - `__init__(self, model_id: str, default_lang: str = "auto")`
  - `warm(self) -> None` — `load_model(model_id)` + one tiny generate to JIT.
  - `synthesize(self, text: str, ref_audio_path: str | None, lang_code: str, streaming_interval: float, cancel: threading.Event) -> Iterator[np.ndarray]` — yields 24 kHz mono float32 PCM chunks. Passes `ref_audio=ref_audio_path` (None → model default voice), `lang_code`, `stream=True`, `streaming_interval`. Extracts `result.audio` (mx.array → np.float32, reshape(-1)); checks `cancel` between chunks.
  - `SAMPLE_RATE = 24000` module constant.
- Consumes: `from mlx_audio.tts.utils import load_model`.

- [ ] **Step 1: Live test** `tests/test_qwen_engine.py` (mark `live`): load the model, `synthesize("你好，有什么可以帮您？", ref_audio_path=None, lang_code="auto", streaming_interval=2.0, cancel)` → assert it yields >0 chunks and the concatenated audio is >0.5s of 24 kHz float32. A second case with `ref_audio_path=<a test wav>` (reuse `pocs/localTTS/ref.wav`) + English text → yields audio (cloning path). (These are `@live` — excluded from the default suite, run with `-m live`.)

- [ ] **Step 2: Run — verify fail** (`uv run pytest -m live -k qwen -q` → import error).

- [ ] **Step 3: Implement `qwen_engine.py`** per the interface. Mirror the current `chatterbox_mlx.py` structure (module-level `@lru_cache`'d `_load_model`, `SAMPLE_RATE`, a `_prepare_chunk(result)` that does `np.asarray(result.audio, dtype=np.float32).reshape(-1)`). The generate call:
  ```python
  for result in model.generate(text, ref_audio=ref_audio_path, lang_code=lang_code,
                               stream=True, streaming_interval=streaming_interval):
      if cancel.is_set(): return
      yield _prepare_chunk(result)
  ```
  No `prepare_conditionals`/`default_conditionals` (qwen has no conds). `ref_audio_path=None` → model default voice. Tagged logger `logging.getLogger("local_tts.engine")`.

- [ ] **Step 4: Run live test** (`uv run pytest -m live -k qwen -q` → PASS; audition the emitted audio informally).

- [ ] **Step 5: Commit** `feat(tts): Qwen3-TTS engine wrapper (multilingual, ref-audio cloning)`.

---

## Task 2: `voice_store` — store reference wav instead of conds

**Files:**
- Modify: `voice_store.py`, `pack_meta.py`, `builtin_library.py`
- Test: `tests/test_voice_store.py`

**Interfaces:**
- Consumes: `QwenEngine` (Task 1) — but note `voice_store` no longer needs the engine to *build* anything (no `prepare_conditionals`). It just persists the ref wav.
- Produces: pack layout `<voiceId>/{ref.wav, meta.json}` (was `conds.safetensors`). `pack_meta.CONDS_FILENAME` → `REF_FILENAME = "ref.wav"`. `VoiceStore.create(ref_wav: np.ndarray, sr: int, name, description="", tags=None)` writes `ref.wav` via `soundfile.write` (24 kHz mono) instead of building/saving conds; returns `{voiceId, name, createdAt}`. `get(voiceId)` returns the **ref.wav path** (str) or `None` (→ engine default). `get_or_default` returns the path or None. `delete`/`list` unchanged in shape (`source` tagging, meta round-trip, traversal guards ALL preserved). `builtin_library` scans `ref.wav` (was `conds.safetensors`).

- [ ] **Step 1: Failing tests** — adapt `test_voice_store.py`: the `_StubEngine`/create tests now assert a `ref.wav` file is written + `get(voiceId)` returns its path; the traversal-guard + meta + source-tag + delete tests stay (change `conds.safetensors` → `ref.wav` in fixtures). Add: `create` writes a readable wav; `get(None)`/`get(unknown)` → `None` (default). The `@live` roundtrip (create → get → engine.synthesize with that ref) replaces the old conds roundtrip.

- [ ] **Step 2–4:** Run (fail) → implement (drop `prepare_conditionals`/`_save_atomic(conds)`; add `soundfile.write(pack/REF_FILENAME, ref_wav, sr)`; `get` returns the path; `_MIN_REF_SECONDS` stays as an upload-length guard — keep at `>3.0` for qwen unless the live test shows shorter works) → run (pass).

- [ ] **Step 5: Commit** `refactor(tts): voice_store persists reference wav for qwen speaker-encoder cloning`.

---

## Task 3: Synthesis wiring + config

**Files:**
- Modify: `connection_session.py`, `synthesis.py`, `synth_worker.py`, `config.py`, `server.py`, `__main__.py`, `config/config.example.yaml`
- Modify (host, in place): `~/.sentient/chatterbox-tts/config/config.yaml` (until Task 7 migrates the dir)
- Test: `tests/test_config.py`, `tests/test_server_ws*.py` (stub-engine)

**Interfaces:**
- Consumes: `QwenEngine.synthesize(text, ref_audio_path, lang_code, streaming_interval, cancel)`, `VoiceStore.get(voiceId) -> str | None`.
- Produces: `voice.create` now: decode the uploaded clip (`_decode_audio`, already mp3-capable) → `VoiceStore.create(array, sr, name, desc, tags)` (writes ref.wav; NO conds build, NO synth lock needed for a lightweight file write — but keep the lock if the model touches shared state; qwen create touches nothing, so the lock can be dropped for create — verify). Synthesis: resolve `ref_audio_path = voice_store.get(voiceId)`; call `engine.synthesize(text, ref_audio_path, lang_code=cfg.default_lang, streaming_interval=cfg.streaming_interval, cancel)`. Config gains `default_lang: str` (default `"auto"`); `model` → the qwen model id; `exaggeration`/`cfg_weight` REMOVED (qwen has no such knobs — the bench warned they're ignored); keep `default_format`/`default_sample_rate`/`streaming_interval`/`voice_dir`/`builtin_voice_dir`/caps/`log_dir`/etc.

- [ ] **Step 1: config test** — `test_config.py`: assert `default_lang` parses (required, default not allowed per the loud loader → add it as a required key) and that `exaggeration`/`cfg_weight` are gone. Update `config.example.yaml`: `model: mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit`, add `default_lang: "auto"  # qwen auto-detects en/zh/…; force with a code like "en"/"zh"`, remove `exaggeration`/`cfg_weight`, update the `streaming_interval` comment (qwen doesn't thrash the vocoder; 2.0 is fine, lower is OK too).
- [ ] **Step 2–4:** Run (fail) → implement the wiring (ConnectionSession/SynthesisRunner take `default_lang`; the create path writes ref.wav; synth passes ref path + lang) → run the stub WS tests (they don't load a model) pass. Update the host config in place.
- [ ] **Step 5: Commit** `feat(tts): wire qwen synthesis (ref-audio + lang=auto), drop chatterbox conds/knobs`.

---

## Task 4: Built-in voice packs (qwen ref-wav)

**Files:**
- Modify: `scripts/build_builtin_voices.py`
- Replace: `src/chatterbox_tts/voices_library/<slug>/conds.safetensors` → `ref.wav` (regenerate), update `meta.json`/`LICENSES.md`
- On-host (live).

**Interfaces:** built-ins now ship a `ref.wav` (a short CC0/public-domain clip) per slug; `voice_store`/`builtin_library` (Task 2) read `ref.wav`.

- [ ] **Step 1:** rewrite `build_builtin_voices.py` to simply COPY/normalize each source clip to `voices_library/<slug>/ref.wav` (24 kHz mono via soundfile) + write `meta.json` — no model/conds step at all (qwen clones at synth). Optionally include a slug with NO ref (the qwen default voice) as "nova".
- [ ] **Step 2:** delete the old `conds.safetensors` built-ins (`git rm`); regenerate `ref.wav` packs from the CC0 clips (re-fetch the LibriVox PD clips per `LICENSES.md`, or reuse `pocs/localTTS/ref.wav` for one). Update `LICENSES.md` (same PD provenance; note the model is now qwen — but conds are gone, so packs are just the PD audio; provenance still applies).
- [ ] **Step 3:** verify: `find voices_library -name ref.wav` + a live `engine.synthesize(text, ref_audio=<builtin ref.wav>, lang="auto")` renders. Add `ref.wav` (audio) commit note — these are small PD clips (committing PD audio is fine; note in LICENSES).
- [ ] **Step 4: Commit** `feat(tts): built-in voice packs as reference wavs for qwen`.

---

## Task 5: Rename the service package → `local_tts` + dir → `LocalTTSService`

**Files:** the entire `capabilityServices/ChatterboxTTSService/` tree.

- [ ] **Step 1:** `git mv capabilityServices/ChatterboxTTSService capabilityServices/LocalTTSService`; `git mv src/chatterbox_tts src/local_tts`; `git mv src/local_tts/qwen_engine.py src/local_tts/engine.py` (the Task-1 module); `git mv tests/test_chatterbox_mlx.py tests/test_local_tts_engine.py` (and delete the truly-chatterbox-specific test body, replacing with the qwen engine test from Task 1); remove the stale `src/chatterbox_tts.egg-info`.
- [ ] **Step 2:** rename inside every file: `chatterbox_tts` → `local_tts` (imports, `logging.getLogger("chatterbox_tts.*")` → `"local_tts.*"`), env `CHATTERBOX_TTS_*` → `LOCAL_TTS_*` (`__main__.py` path resolution + `_DEFAULT_DATA_DIR = ~/.sentient/local-tts`), `pyproject.toml` `[project] name`/packages/scripts, `__init__.py` docstring + `__version__` (keep `1.0.0` or bump — keep for continuity; note the engine changed in the changelog/README), `CONTRACT.md`/`README.md`/`config.example.yaml` prose (Chatterbox → Qwen3-TTS where describing the engine; `chatterbox-tts` → `local-tts` where naming the service). Fix all imports; drop any remaining `Chatterbox`/`prepare_conditionals`/`conds` references (dead after Tasks 1–3).
- [ ] **Step 3:** `uv run pytest -q` green (non-live); `uv run pytest -m live -q` green on-host (engine + roundtrip).
- [ ] **Step 4: Commit** `refactor(tts): rename service chatterbox_tts → local_tts / LocalTTSService`.

---

## Task 6: Rename gateway + shared references (comments/CONTRACT/types)

**Files:** `gateway/src/config/startup-config.ts`, `gateway/src/providers/tts/{local-tts-provider,local-tts-protocol,tts-types}.ts`, `gateway/src/tts/streaming-tts-synthesizer.ts`, `gateway/src/api/handlers/voices.ts` + `.test.ts`, `gateway/src/api/handlers/fish/fish-clone.ts` + `.test.ts`, `shared/config/src/schema.ts`.

- [ ] **Step 1:** replace "Chatterbox"/"ChatterboxTTS"/"ChatterboxTTSService" in comments, JSDoc, and any string/type names with "local-tts" / "Qwen3-TTS" (engine-neutral for names, "Qwen3-TTS" only where a comment describes the actual engine). The wire-protocol MODULE names (`local-tts-protocol`, `local-tts-provider`) are ALREADY correct — keep them. Do NOT change any wire `type` strings or the `voice.*` message shapes. This is comments/docs only — no behavior change.
- [ ] **Step 2:** `source scripts/env.sh && bun run typecheck && bun test` (gateway) green; `bun run test --filter @sentient/config` green.
- [ ] **Step 3: Commit** `docs(gateway): rename Chatterbox references to local-tts/Qwen3-TTS (comments only)`.

---

## Task 7: Deploy rename + launchd relabel + host dir migration

**Files:** `deploy/mac-prod/native/chatterbox-tts.sh` → `local-tts.sh`; `deploy/mac-prod/native/tts-backend.py`; `deploy/setup-prod.py`; `deploy/mac-prod/deploy.conf`. Host: launchd plist + `~/.sentient/` dir.

- [ ] **Step 1:** `git mv deploy/mac-prod/native/chatterbox-tts.sh deploy/mac-prod/native/local-tts.sh`; inside it + `tts-backend.py` + `setup-prod.py` + `deploy.conf`: rename `CHATTERBOX_TTS_*` consts + env, the launchd label `io.dev32.sentient.chatterbox-tts` → `io.dev32.sentient.local-tts`, the host paths `~/.sentient/chatterbox-tts` → `~/.sentient/local-tts`, the service dir `ChatterboxTTSService` → `LocalTTSService`, the model id → qwen, and any "Chatterbox" prose. `setup-prod.py`'s `apply_tts_backend`/`configure_native_tts` paths + `TTS_BACKEND_SCRIPT`/`CHATTERBOX_LAUNCHER` constants.
- [ ] **Step 2 (host migration — local dev, in place):** unload the old agent (`launchctl bootout gui/$(id -u)/io.dev32.sentient.chatterbox-tts` or `launchctl unload ~/Library/LaunchAgents/io.dev32.sentient.chatterbox-tts.plist`); `git mv`/write the new plist `io.dev32.sentient.local-tts.plist` (new label, new ProgramArguments pointing at `LocalTTSService`, new `LOCAL_TTS_*` env + `~/.sentient/local-tts` paths); migrate the host data dir `mv ~/.sentient/chatterbox-tts ~/.sentient/local-tts` (contains config + user voices + logs); update the migrated `config/config.yaml` to the qwen model + `default_lang` + drop `exaggeration`/`cfg_weight`; load the new agent + confirm health (`curl :8771/health`).
- [ ] **Step 3: Commit** `chore(deploy): rename chatterbox-tts → local-tts (launcher, backend, setup-prod, launchd)`.
- [ ] **PROD NOTE (do NOT execute — observational prod):** the Mac mini's `~/.sentient/chatterbox-tts` + its launchd agent must be migrated the same way at deploy time (user action, per the prod-observational rule). Document in the deploy README.

---

## Task 8: Rename rules / docs / memory (active only)

**Files:** `CLAUDE.md` (project map + Providers line), `.claude/rules/*` mentioning the service, `agents/docs/*` (active details/learnings), memory files under `~/.claude/projects/.../memory/`. **KEEP historical:** `docs/superpowers/plans|specs/2026-07-08-local-chatterbox-*`, `pocs/localTTS/chatterbox/`, `.superpowers/sdd/progress.md`.

- [ ] **Step 1:** `CLAUDE.md` — update the Providers paragraph ("TTS via local-tts / ChatterboxTTSService …") to "TTS via local-tts / **LocalTTSService** (Qwen3-TTS, multilingual)". `.claude/rules/*` + `agents/docs/*` — replace active `ChatterboxTTSService`/`chatterbox_tts`/`Chatterbox` references with the new name/engine. Leave the retired-constructs lists that name Chatterbox as *historical* alone if they're describing history.
- [ ] **Step 2 (memory):** update `[[project_fish_browse_clone]]` + `[[project_voice_ux_refresh]]` (service now LocalTTSService/Qwen3-TTS); `[[reference_chatterbox_streaming_interval_perf]]` — this finding is Chatterbox-specific and MOOT under qwen (flat RTF, no vocoder thrash): rename it (e.g. `reference_local_tts_perf`) + add a note "engine swapped to Qwen3-TTS 2026-07-14; the streaming_interval vocoder-thrash no longer applies; qwen RTF ~0.41 flat." Update `MEMORY.md` index lines.
- [ ] **Step 3: Commit** `docs: rename active Chatterbox references to LocalTTSService/Qwen3-TTS`.

---

## Task 9: Residual-chatterbox sweep + verification

- [ ] **Step 1:** `grep -rniE "chatterbox" --exclude-dir=.venv --exclude-dir=node_modules --exclude-dir=.git .` — the ONLY remaining hits must be the intentionally-kept historical records (2026-07-08 spec/plan, `pocs/localTTS/chatterbox/`, `.superpowers/sdd/progress.md`, this plan's own history references). Any hit in active service/gateway/deploy/rules/config code is a miss → fix.
- [ ] **Step 2:** confirm no dead `conds`/`prepare_conditionals`/`exaggeration`/`cfg_weight` in `local_tts`. Confirm `LOCAL_TTS_*` env everywhere (no `CHATTERBOX_TTS_*` left). Confirm the launchd label + host paths are `local-tts`.
- [ ] **Step 3: Commit** (if any residual fixes) `chore: purge residual chatterbox references from active code`.

---

## Task 10: E2E + full gate (multilingual, on the renamed qwen service)

Boot the renamed **LocalTTSService** (qwen) via its new launchd agent + rebuild the gateway; drive Playwright + a real conversation.

**E2E matrix (inline):**

| Case | Viewport | Action | Expected user-visible | Expected log trail |
|------|----------|--------|-----------------------|--------------------|
| en-reply-tts | desktop | ask something → assistant replies (English) | natural English speech | `local_tts` synth, rtf<1 |
| **zh-reply-tts** | desktop | ask in Mandarin / force a Mandarin reply | natural **Mandarin** speech (the bug is fixed) | lang auto→zh, coherent audio |
| clone-record-en+zh | desktop | record a voice → set active → get an English AND a Mandarin reply | both render in the cloned voice | ref.wav stored; synth uses it |
| fish-clone-zh | desktop | Clone from Fish Audio a voice → Mandarin reply | Mandarin in the Fish-cloned voice | fish clone → ref.wav → qwen |
| builtins | desktop | Voices panel shows built-ins; preview + pick | built-in packs preview + work | builtin_library ref.wav |
| voice-ux-regression | desktop+390 | record/upload(+mp3)/preview/pick/delete | all still work on qwen | no regressions |
| health/version | — | `curl :8771/health` | version ok; service = local-tts | `local_tts.*` logs |

- [ ] **Step 1:** migrate+boot the local-tts (qwen) service (Task 7 host steps) + rebuild gateway; confirm health + built-ins load.
- [ ] **Step 2:** run every matrix row (audition en + zh quality; capture the log trail — no `chatterbox` in logs, `local_tts.*` tags).
- [ ] **Step 3:** `source scripts/env.sh && bun run ci` green; `cd capabilityServices/LocalTTSService && uv run pytest -q` green (+ `-m live` on-host).
- [ ] **Step 4: Commit** `test(tts): e2e — qwen multilingual (en+zh) on the renamed local-tts service`.

## Risks / notes
- **Qwen ref-audio min length / quality** — validate the `_MIN_REF_SECONDS` guard against qwen (the bench ref worked; confirm a ~3s clip clones acceptably). Some Fish samples are short — the too-short reject still applies.
- **Model size/RAM** — qwen 0.6B-8bit vs chatterbox turbo-8bit; confirm it warms + fits alongside the gateway/STT (bench loaded fine).
- **`ref_text` omission** — we clone ref-audio-only (no transcript); bench quality was "amazing" per the user, so acceptable. If quality dips for some voices, `ref_text` is a future lever (we'd need the sample transcript).
- **Built-in PD audio committed** — small CC0 wavs under `voices_library/`; note in LICENSES.
- **The 5 existing chatterbox `conds.safetensors` built-ins are deleted** (useless for qwen).
