# Fish Audio Browse-and-Clone + Service MP3 Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained, removable "Clone from Fish Audio" flow — browse/filter Fish's public voice library, pick a voice, and clone its sample clip into a local Chatterbox voice pack — plus native mp3 reference-clip support in the TTS service.

**Architecture:** The TTS service already decodes mp3 (libsndfile 1.2.2 — verified). The Fish integration is **browse-only** (Fish's `/model` API is public; we never revive Fish's TTS synth/WS): a gated gateway `fish/` module proxies the library + a clone endpoint that downloads the voice's mp3 sample and feeds it to the EXISTING `createVoice`. The web UI revives the old browse UI (from git history) as a third tab in the Add-voice modal. All Fish code lives in isolated `fish/` units behind a `fish_browse_enabled` flag — removable as a unit.

**Tech Stack:** Python 3.11 + libsndfile/soundfile (service); Bun + TypeScript + zod (gateway); Preact + Vite + Signals (webui). Revived files sourced from git history: **webui at rev `115fb59^`**, **gateway at rev `45e690a^`** (use `git show <rev>:<path>`).

## Global Constraints

- **Branch:** `feature/local-tts-chatterbox` (stacked on PR #19). Never push to `develop`/`main`.
- **SELF-CONTAINED / REMOVABLE (hard requirement):** all Fish code lives in clearly-named `fish/` modules gated behind `providers.fish_browse_enabled`. Removal = delete the `fish/` dir(s) + remove one conditional route mount + one conditional modal tab + drop the config flag. No Fish logic bleeds into core `voices.ts`/`AddVoiceModal` beyond a conditional mount. The plan's final task adds a `docs/` removal note.
- **NO committed Fish secret.** Fish's `/model` browse API is PUBLIC — the bearer is OPTIONAL (rate-limit relief only), read from `${FISH_AUDIO_API_KEY}` env when present, never required, never committed.
- **Reuse, don't fork, voice creation.** The clone endpoint calls the existing `createVoice(...)` + `activateVoice(...)` and mirrors `handleVoicesPost`'s partial-failure invariants (never drop the voiceId; `warning:"not-activated"` on a failed local activation).
- **mp3 flows through untouched.** The gateway downloads the Fish mp3 bytes and passes them straight to `createVoice`; the SERVICE decodes mp3 (libsndfile). No gateway/client transcode.
- **Files ≤300 lines / functions ≤40 / no magic strings / tagged loggers.** NEVER log Fish voice titles / tags / descriptions / user content — ids / counts / lengths only.
- **Test-lean:** unit tests ONLY for wire/protocol + security (the Fish fetcher zod-parse; the clone endpoint's contract + guards). The revived browse UI + filter utils are presentational/pure → NO unit test (typecheck + the Task 9 E2E). Gateway tests = `bun test` native (`cd gateway/src && bun test <path>`); webui = vitest (`cd gateway/webui && bun run test`); service = `uv run pytest` from `capabilityServices/ChatterboxTTSService/`.
- **Commit format:** `type(scope): description`. Source `scripts/env.sh` before any `bun run`.
- **KNOWN RISK (handle gracefully, don't prevent):** some Fish preview samples are <5s → the service rejects with "clip too short" (422). Surface it as a clear toast; the user picks another voice.

## File Structure

**Service** — Modify `connection_session.py` (rename `_decode_wav`→`_decode_audio`), `CONTRACT.md`; Test `tests/test_server_ws_voice_create.py` (or a new decode test).

**Gateway (self-contained `fish/`)**
- Create `gateway/src/providers/fish/fish-fetcher.ts` — Fish `/model` HTTP caller (revive from `45e690a^:gateway/src/providers/catalogs/fish-fetcher.ts`).
- Create `gateway/src/providers/fish/fish-voice-types.ts` — `VoiceEntry` type (revive from `45e690a^:gateway/src/providers/catalogs/types.ts`).
- Create `gateway/src/api/handlers/fish/fish-browse.ts` — proxy routes + cache (revive+trim from `45e690a^:gateway/src/api/handlers/providers.ts` + `providers-deps.ts`, Fish-voices-only).
- Create `gateway/src/api/handlers/fish/fish-clone.ts` — `POST .../voices/:id/clone` handler.
- Modify the existing providers handler to mount the Fish routes when enabled; `shared/config/src/schema.ts` (`providersConfigSchema` + flag); `create-gateway-services.ts` + `server.ts` (deps); `system-orchestrator`/services-versions (surface the flag).
- Reuse `gateway/src/util/ttl-cache.ts` (`createTtlCache`).

**WebUI (self-contained `fish/`)**
- Create `gateway/webui/src/services/fish-api.ts` — browse + clone client (revive from `115fb59^:gateway/webui/src/services/providers-api.ts`).
- Create `gateway/webui/src/components/voices/fish/` — `FishClonePanel.tsx`, `fish-voice-tile.tsx`, `fish-bucket.ts`, `fish-filter-section.tsx`, `fish-langs.ts` (revive from `115fb59^:.../panes/voice-*.{ts,tsx}`, adapted).
- Modify `AddVoiceModal.tsx` (third tab + `.mp3` accept), `use-service-versions.ts` (consume the flag), and whatever passes the flag down.

---

## Task 1: Service — accept mp3 (and any libsndfile format) as a reference clip

**Files:**
- Modify: `capabilityServices/ChatterboxTTSService/src/chatterbox_tts/connection_session.py`
- Modify: `capabilityServices/ChatterboxTTSService/CONTRACT.md`
- Test: `capabilityServices/ChatterboxTTSService/tests/test_server_ws_voice_create.py`

**Interfaces:**
- Consumes: existing `_decode_wav(wav_bytes) -> (np.ndarray, int)` using `sf.read(io.BytesIO(bytes), dtype="float32")`.
- Produces: `_decode_audio(audio_bytes) -> (np.ndarray, int)` — identical body, decodes wav/flac/ogg/mp3 (libsndfile 1.2.2 supports MP3, verified: a 7s mp3 → 24k float32 mono).

- [ ] **Step 1: Write the failing test** — add to `tests/test_server_ws_voice_create.py` (or a small `tests/test_decode_audio.py`). Generate a real mp3 in-test with `soundfile` if it can write mp3, else with a tiny pre-encoded fixture; simplest is a round-trip via soundfile writing OGG (guaranteed) AND asserting the function name changed. Use this decode test (writes an OGG the decoder must read + asserts the rename exists for mp3-capability intent):

```python
import io
import numpy as np
import soundfile as sf
from chatterbox_tts.connection_session import _decode_audio


def test_decode_audio_reads_compressed_mono():
    # 6s mono tone at 24k, encoded to OGG/Vorbis (libsndfile-native), decoded back.
    sr = 24000
    tone = (0.1 * np.sin(2 * np.pi * 180 * np.arange(sr * 6) / sr)).astype("float32")
    buf = io.BytesIO()
    sf.write(buf, tone, sr, format="OGG")
    buf.seek(0)
    arr, out_sr = _decode_audio(buf.read())
    assert out_sr == sr
    assert arr.ndim == 1
    assert arr.size > sr * 5  # > 5s → clone-viable


def test_decode_audio_downmixes_stereo():
    sr = 24000
    stereo = np.zeros((sr, 2), dtype="float32")
    stereo[:, 0] = 0.2
    buf = io.BytesIO()
    sf.write(buf, stereo, sr, format="WAV")
    buf.seek(0)
    arr, _ = _decode_audio(buf.read())
    assert arr.ndim == 1  # mono after downmix
```

- [ ] **Step 2: Run — verify fail**

Run: `cd capabilityServices/ChatterboxTTSService && uv run pytest tests/test_server_ws_voice_create.py -q -k decode_audio`
Expected: FAIL — `cannot import name '_decode_audio'`.

- [ ] **Step 3: Rename `_decode_wav` → `_decode_audio`** in `connection_session.py`. The body is unchanged (it was never wav-specific — `sf.read` sniffs the container). Update the docstring + the one call site in `_create_voice`:

```python
def _decode_audio(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded reference clip to mono float32 PCM + its sample rate.

    Accepts any container libsndfile can read — wav / flac / ogg / **mp3**
    (libsndfile >=1.1). Content-sniffed by soundfile, so the caller need not
    declare the format. Multi-channel input is downmixed to mono.
    """
    array, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    if array.ndim > 1:
        array = array.mean(axis=1).astype(np.float32)
    return array, sr
```

In `_create_voice`, change `array, sr = _decode_wav(wav_bytes)` → `array, sr = _decode_audio(wav_bytes)` (keep the `wav_bytes` param name or rename to `audio_bytes` for clarity — implementer's choice, do it consistently).

- [ ] **Step 4: Run — verify pass + full suite**

Run: `uv run pytest -q`
Expected: PASS (all non-live).

- [ ] **Step 5: Update CONTRACT.md** — wherever it documents `voice.create`'s reference-clip upload, change "WAV" to "wav / flac / ogg / mp3 (any libsndfile-decodable container; content-sniffed)".

- [ ] **Step 6: Commit**

```bash
git add capabilityServices/ChatterboxTTSService/src/chatterbox_tts/connection_session.py \
        capabilityServices/ChatterboxTTSService/CONTRACT.md \
        capabilityServices/ChatterboxTTSService/tests/test_server_ws_voice_create.py
git commit -m "feat(tts): accept mp3 (and any libsndfile format) as a reference clip"
```

---

## Task 2: Gateway — Fish fetcher module + config flag

**Files:**
- Create: `gateway/src/providers/fish/fish-voice-types.ts`
- Create: `gateway/src/providers/fish/fish-fetcher.ts`
- Modify: `shared/config/src/schema.ts` (`providersConfigSchema`, lines ~286-292)
- Test: `gateway/src/providers/fish/fish-fetcher.test.ts`

**Interfaces:**
- Produces:
  - `interface VoiceEntry { id: string; title: string; description: string; languages: string[]; tags: string[]; coverImageUrl: string | null; previewAudioUrl: string | null; visibility: "public" | "private"; taskCount: number; createdAt: string; }`
  - `interface FishFetchConfig { apiKey: string | null; timeoutMs: number; baseUrl?: string; }`
  - `fetchFishVoices(cfg: FishFetchConfig, opts?: { title?: string; page?: number }): Promise<Result<{ voices: VoiceEntry[]; hasMore: boolean }, FishFetchError>>`
  - `fetchFishVoiceById(cfg: FishFetchConfig, id: string): Promise<Result<VoiceEntry, FishFetchError>>` (error kind `"not-found" | "upstream"`)
  - `providersConfigSchema` gains `fish_browse_enabled: boolean` (default `true`) + `fish_cache_ttl_ms: number` (default `600000`).

- [ ] **Step 1: Recover the source** — read the reference implementation:

Run: `git show 45e690a^:gateway/src/providers/catalogs/fish-fetcher.ts` and `git show 45e690a^:gateway/src/providers/catalogs/types.ts` and `git show 45e690a^:gateway/src/providers/catalogs/fish-fetcher.test.ts`.
These contain the exact Fish `/model` query shapes, the zod item schema, and `mapToVoiceEntry`. Port them verbatim into the new `fish/` paths, changing only imports.

- [ ] **Step 2: Write `fish-voice-types.ts`** — the `VoiceEntry` interface above (verbatim from `45e690a^:.../catalogs/types.ts`).

- [ ] **Step 3: Write the failing fetcher test** `fish-fetcher.test.ts` — port from `45e690a^:.../fish-fetcher.test.ts`, adapting to `fetchFishVoices(cfg, opts)` / `fetchFishVoiceById(cfg, id)`. It must pin (via an injected `fetch` or a mocked global): the URL `https://api.fish.audio/model?page_size=200&sort_by=score`, that `title`/`page_number` are appended only when set/`>1`, that `Authorization: Bearer` is sent iff `apiKey` present, that the `{items:[{_id,title,samples:[{audio}]...}]}` response maps to `VoiceEntry` with `previewAudioUrl = samples[0].audio`, and `hasMore = voices.length >= 200`.

- [ ] **Step 4: Run — verify fail**

Run: `source scripts/env.sh && cd gateway/src && bun test providers/fish/fish-fetcher.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Write `fish-fetcher.ts`** — port from `45e690a^:.../fish-fetcher.ts`. Key literals (verbatim): `const FISH_BASE_URL = "https://api.fish.audio"`, `FETCH_PAGE_SIZE = 200`, `FETCH_SORT_BY = "score"`. List = `GET {base}/model?page_size=200&sort_by=score[&page_number=<n>][&title=<q>]`; single = `GET {base}/model/<encodeURIComponent(id)>`. `Authorization: Bearer <apiKey>` header only when `cfg.apiKey` is non-null. `AbortSignal.timeout(cfg.timeoutMs)`. Zod-parse the item shape `{_id, title, description?="", languages?=[], tags?=[], cover_image?=null, samples?=[{audio}], visibility?="public", task_count?=0, created_at?=""}` in `{items:[...]}`; `mapToVoiceEntry` → `VoiceEntry` (`previewAudioUrl = samples[0]?.audio ?? null`). Tagged logger `["sentient","providers","fish","fetcher"]` — log counts/status only, NEVER titles/tags. Return typed `Result` (never throw). 404 on single → `{kind:"not-found"}`.

- [ ] **Step 6: Run — verify pass**

Run: `bun test providers/fish/fish-fetcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Add config** to `shared/config/src/schema.ts` `providersConfigSchema` (append):

```ts
  // Feature flag for the self-contained Fish-Audio browse-and-clone module.
  // When false, the gateway 404s every /providers/voices* route and the webui
  // hides the "Clone from Fish Audio" tab. Set false (or delete the fish/
  // modules) to fully disable the integration.
  fish_browse_enabled: z.boolean().default(true),
  // Cache TTL for the default (unfiltered, page-1) Fish voice listing. Fish
  // rate limits are undocumented — keep short.
  fish_cache_ttl_ms: z.number().int().min(10_000).default(600_000),
```

- [ ] **Step 8: Run typecheck + config test**

Run: `bun run typecheck` (root) and `cd shared/config && bun run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add gateway/src/providers/fish/ shared/config/src/schema.ts
git commit -m "feat(gateway): self-contained Fish voice fetcher + fish_browse_enabled flag"
```

---

## Task 3: Gateway — Fish browse proxy routes (gated)

**Files:**
- Create: `gateway/src/api/handlers/fish/fish-browse.ts`
- Modify: the existing providers handler (find it: `git grep -l "handleProviders\|/providers/models" gateway/src/api`) to mount the Fish voice routes when enabled.
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`, `gateway/src/server.ts` (deps: `fishBrowseEnabled`, `fishApiKey`, `fishCacheTtlMs`, `externalFetchTimeoutMs`).
- Test: `gateway/src/api/handlers/fish/fish-browse.test.ts`

**Interfaces:**
- Consumes: `fetchFishVoices`/`fetchFishVoiceById` (Task 2), `createTtlCache` from `gateway/src/util/ttl-cache.ts`, `tokens.validate`.
- Produces: `handleFishBrowse(deps, request): Promise<Response>` handling `GET /api/v1/providers/voices[?title&page]` → `{voices, hasMore, stale}` and `GET /api/v1/providers/voices/:id` → `{voice}` (404 on not-found, 503 on upstream). Every route 404s when `!deps.fishBrowseEnabled`. `interface FishBrowseDeps { tokens; fishBrowseEnabled: boolean; fishApiKey: string | null; timeoutMs: number; cacheTtlMs: number; fetchers?: {...} }`.

- [ ] **Step 1: Recover the proxy logic** — `git show 45e690a^:gateway/src/api/handlers/providers.ts` and `git show 45e690a^:gateway/src/api/providers-deps.ts`. Reuse ONLY the voices half (list/get + the `"all"`-key cache + stale-fallback + `getFishAudioKeySync ?? env("FISH_AUDIO_API_KEY")` resolution). Drop the models half (the current providers handler still owns models).

- [ ] **Step 2: Write the failing test** `fish-browse.test.ts` — assert, with injected fake `fetchers`: `GET /api/v1/providers/voices` (bearer) → 200 `{voices,hasMore,stale}`; `?title=x` bypasses cache; a second default call hits cache; `GET /api/v1/providers/voices/<id>` → `{voice}`; unknown id → 404; **`fishBrowseEnabled:false` → 404 for every route**; missing bearer → 401.

- [ ] **Step 3: Run — verify fail**; then **Step 4: Write `fish-browse.ts`** per the interface, `createTtlCache(cacheTtlMs)` for the default view only, tagged logger `["sentient","api","fish","browse"]` (counts/status/ids only). Key resolution: `deps.fishApiKey` (already resolved at wiring time from `env("FISH_AUDIO_API_KEY")` — see Step 6). Enabled-gate FIRST in the handler: `if (!deps.fishBrowseEnabled) return new Response("Not Found", {status: 404})`.

- [ ] **Step 5: Mount in the providers handler** — in the existing providers handler, after the models routes, add: `if (pathname === "/api/v1/providers/voices" || VOICE_ID_SUBPATH.test(pathname)) return handleFishBrowse(fishDeps, request)`. (Route registration is the ONLY Fish reference in the core handler — a one-block conditional that's trivially removable.)

- [ ] **Step 6: Wire deps** — `create-gateway-services.ts`: resolve `fishApiKey = process.env.FISH_AUDIO_API_KEY ?? null`, `fishBrowseEnabled = cfg.providers.fish_browse_enabled`, `fishCacheTtlMs = cfg.providers.fish_cache_ttl_ms`, `externalFetchTimeoutMs = cfg.providers.external_fetch_timeout_ms`; pass into the providers handler construction in `server.ts`.

- [ ] **Step 7: Run — verify pass + typecheck**

Run: `cd gateway/src && bun test api/handlers/fish/fish-browse.test.ts` then root `bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add gateway/src/api/handlers/fish/ gateway/src/bootstrap/create-gateway-services.ts gateway/src/server.ts gateway/src/api/handlers/providers*.ts
git commit -m "feat(gateway): gated Fish voice-library browse proxy"
```

---

## Task 4: Gateway — clone-from-Fish endpoint

**Files:**
- Create: `gateway/src/api/handlers/fish/fish-clone.ts`
- Modify: the providers handler (mount `POST /api/v1/providers/voices/:id/clone`).
- Test: `gateway/src/api/handlers/fish/fish-clone.test.ts`

**Interfaces:**
- Consumes: `fetchFishVoiceById` (Task 2); `createVoice(cfg, name, audio: ArrayBuffer, signal, description, tags)` + `activateVoice(deps, userId, voiceId)` from the voices handler family (import them; they already exist); `mapVoiceOpError`.
- Produces: `handleFishClone(deps, userId, fishVoiceId, request): Promise<Response>` — body `{ name: string; description?: string; tags?: string[] }`. Flow: fetch the Fish voice → if `previewAudioUrl` null → `422 {error:"no-preview-sample"}`; download the mp3 (`fetch(previewAudioUrl, {signal: AbortSignal.timeout(timeoutMs)})` → `arrayBuffer()`; on failure → `502 {error:"preview-download-failed"}`) → `createVoice(buildCfg, name, mp3, signal, description ?? "", tags ?? [])` → on service-error map via `mapVoiceOpError` (a <5s sample surfaces as the service's `422` "clip too short" — pass it through) → `activateVoice` → return `{voiceId, name}` (or `{voiceId, name, warning:"not-activated"}` on activation failure — NEVER drop the voiceId). `interface FishCloneDeps` = the fish fetch config + the voice-create deps subset (`tokens, profileStore, refreshVoice, ttsUrl, connectTimeoutMs, opTimeoutMs, descriptionMaxLen, tagMaxLen, maxTags, socketFactory?`). Reuse `descriptionMaxLen`/`tagMaxLen`/`maxTags` to validate the JSON body (mirror `parseCreateForm`'s caps).

- [ ] **Step 1: Write the failing test** `fish-clone.test.ts` — with a fake `fetchFishVoiceById` (returns a voice with a `previewAudioUrl`), a fake global `fetch` for the mp3 download (returns bytes), and the existing fake voice-mgmt socket: assert `POST /api/v1/providers/voices/<id>/clone {name,description,tags}` → 200 `{voiceId,name}`, and that `createVoice` received the downloaded bytes + name/desc/tags; a voice with `previewAudioUrl:null` → 422 `no-preview-sample`; a service "clip too short" error → surfaced as 422 (not 500); over-cap tags → 422 before any fetch; missing bearer → 401; `fishBrowseEnabled:false` → 404.

- [ ] **Step 2: Run — verify fail**; **Step 3: Write `fish-clone.ts`** per the interface. Enabled-gate first. Validate the JSON body (name required + trimmed; description ≤ cap; tags ≤ maxTags, each ≤ tagMaxLen). Tagged logger `["sentient","api","fish","clone"]` — log `userId`, `fishVoiceId`, `bytes`, `tagCount` only (NEVER the title/name/description/tags content). Bound the mp3 download with `externalFetchTimeoutMs`.

- [ ] **Step 4: Mount** — in the providers handler: `const cloneMatch = /^\/api\/v1\/providers\/voices\/([^/]+)\/clone$/.exec(pathname); if (cloneMatch && request.method === "POST") return handleFishClone(fishCloneDeps, userId, decode(cloneMatch[1]), request)`. Guard the id with the same shape/decoder discipline (`safeDecode`) — a Fish id is not our slug/hex, so DON'T apply `VOICE_ID_SHAPE_RE` (Fish ids are opaque); just reject empty / decode-failure. The Fish id only flows to `fetchFishVoiceById` (URL-encoded there), never to a filesystem path, so traversal isn't a concern here — note this in a comment.

- [ ] **Step 5: Run — verify pass + typecheck**

Run: `cd gateway/src && bun test api/handlers/fish/fish-clone.test.ts` then root `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/api/handlers/fish/fish-clone.ts gateway/src/api/handlers/providers*.ts
git commit -m "feat(gateway): clone-from-Fish endpoint (download sample → local voice pack)"
```

---

## Task 5: Gateway — surface `fish_browse_enabled` to the web UI

**Files:**
- Modify: `gateway/src/system-orchestrator/index.ts` (or wherever `handleServicesVersions` builds its payload) + `gateway/src/api/handlers/services-versions.ts`
- Modify: `gateway/webui/src/hooks/use-service-versions.ts`
- Test: `gateway/src/api/handlers/services-versions.test.ts`

**Interfaces:**
- Produces: the `GET /api/v1/services/versions` JSON gains `features: { fish_browse_enabled: boolean }` (or a top-level `fish_browse_enabled` — implementer picks the least-invasive shape matching the existing payload). `ServiceVersions` (webui) gains the same field. This is the startup surface the webui already fetches (auth + bootstrap gated).

- [ ] **Step 1: Scout** — read `services-versions.ts` + `use-service-versions.ts` + the existing `ServiceVersions`/`ServiceVersionRecord` types to see the payload shape. Choose: add `features: { fish_browse_enabled }` (preferred — namespaced, extensible) to the response.

- [ ] **Step 2: Failing test** — in `services-versions.test.ts`, add `fish_browse_enabled` to the deps/fixture and assert the response includes `features.fish_browse_enabled` matching the configured value (both true and false).

- [ ] **Step 3: Run — verify fail**; **Step 4: Implement** — thread `fishBrowseEnabled` from `cfg.providers.fish_browse_enabled` into the services-versions deps + response `features` object. Update `use-service-versions.ts`'s `ServiceVersions` type + parse.

- [ ] **Step 5: Run — verify pass + typecheck**

Run: `cd gateway/src && bun test api/handlers/services-versions.test.ts` then root `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/system-orchestrator/ gateway/src/api/handlers/services-versions*.ts gateway/webui/src/hooks/use-service-versions.ts
git commit -m "feat(gateway): surface fish_browse_enabled feature flag to the webui"
```

---

## Task 6: WebUI — Fish browse-and-clone API client

**Files:**
- Create: `gateway/webui/src/services/fish-api.ts`
- Test: none (thin fetch client; wire shape is pinned gateway-side + by E2E — but if the project has a services test pattern, a small shape test is acceptable).

**Interfaces:**
- Produces:
  - `interface FishVoiceEntry` = same fields as gateway `VoiceEntry` (id/title/description/languages/tags/coverImageUrl/previewAudioUrl/visibility/taskCount/createdAt).
  - `interface FishApi { listVoices(token, opts?: {title?; page?}): Promise<Result<{voices: FishVoiceEntry[]; hasMore: boolean; stale: boolean}>>; getVoice(token, id): Promise<Result<{voice: FishVoiceEntry}>>; cloneFromFish(token, input: {fishVoiceId: string; name: string; description: string; tags: string[]}): Promise<Result<{voiceId: string; name: string; warning?: "not-activated"}>>; }`
  - `createFishApi(): FishApi`.

- [ ] **Step 1: Recover** — `git show 115fb59^:gateway/webui/src/services/providers-api.ts` for the `VoiceEntry` + `listVoices`/`getVoice` shapes (GET `/api/v1/providers/voices?title=&page=`, `/voices/:id`, bearer via `bearerHeaders`, through `handleFetch`).

- [ ] **Step 2: Write `fish-api.ts`** — `listVoices`/`getVoice` per the recovered shapes (drop the wizard-mode prefix — user-mode `/api/v1/providers` only). Add `cloneFromFish` → `POST /api/v1/providers/voices/${encodeURIComponent(fishVoiceId)}/clone` with `jsonHeaders(bearerHeaders(token))` + `JSON.stringify({name, description, tags})` through `handleFetch<{voiceId,name,warning?}>`. Tagged logger `createLogger(["sentient","webui","fish","api"])` — log lengths/counts/ids only. Import `bearerHeaders`/`jsonHeaders`/`handleFetch` from `./_helpers`.

- [ ] **Step 3: Typecheck**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/services/fish-api.ts
git commit -m "feat(webui): Fish browse + clone-from-fish API client"
```

---

## Task 7: WebUI — revive the Fish browse UI (self-contained `fish/`)

**Files:**
- Create: `gateway/webui/src/components/voices/fish/fish-bucket.ts`, `fish-langs.ts`, `fish-filter-section.tsx`, `fish-voice-tile.tsx`, `FishClonePanel.tsx`

Presentational/pure → NO unit test (typecheck + Task 9 E2E).

**Interfaces:**
- Consumes: `FishApi` (Task 6), `FishVoiceEntry`.
- Produces: `FishClonePanel` props `{ token: string; busy: boolean; onClone: (input: {fishVoiceId: string; suggestedName: string; suggestedTags: string[]}) => void }` — it owns browse/search/filter/preview state and calls `onClone` when the user picks a voice (the AddVoiceModal owns the final name/desc/tags editor + the actual clone call). Also `fish-bucket.ts` exports `deriveFilterOptions/applyFilters/sortVoices/bucketVoiceTags/toggleInArray/VoiceFilters/SortKey`; `fish-langs.ts` exports `langDisplay`.

- [ ] **Step 1: Recover** — `git show 115fb59^:gateway/webui/src/components/settings/panes/voice-bucket.ts`, `voice-langs.ts`, `voice-filter-section.tsx`, `voice-tile.tsx`, `voice-pane.tsx`. These are the filter engine, lang map, facet section, tile, and the browse pane (search/pagination/preview) respectively.

- [ ] **Step 2: Port the pure/leaf files verbatim** into `fish/`: `fish-bucket.ts` (= `voice-bucket.ts`), `fish-langs.ts` (= `voice-langs.ts`), `fish-filter-section.tsx` (= `voice-filter-section.tsx`), `fish-voice-tile.tsx` (= `voice-tile.tsx`, keep its `onSelect`/`onPreview`/`onTagClick`/`playing`/`selected` props). Only change imports.

- [ ] **Step 3: Adapt `voice-pane.tsx` → `FishClonePanel.tsx`** — keep the browse machinery verbatim (300ms-debounced `api.listVoices(token,{title})` server search; client-side `applyFilters`/`sortVoices` facets; `loadMoreFromServer` with `fetchSeqRef` stale-drop + id-dedup + `hasMore`; the `new Audio(previewAudioUrl)` single-`audioRef` preview player with stop-on-ended). REMOVE: the `savedVoice`/`draft`/`onDraftVoice` profile wiring, the `VoiceSavedTile`, the PaneHead/"Powered by Fish Audio" chrome. REPLACE the select action: on tile select, call `props.onClone({ fishVoiceId: v.id, suggestedName: v.title, suggestedTags: v.tags.slice(0, /* maxTags handled by modal */ 8) })` instead of setting a draft voice. Use `createFishApi()` (or accept an injected api). Tagged logger; no content logging. If the file approaches 300 lines after trimming, extract the toolbar/filter rows into a co-located helper.

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/voices/fish/
git commit -m "feat(webui): revive Fish voice browse UI as a self-contained module"
```

---

## Task 8: WebUI — mount the Fish tab in the Add-voice modal + wire the clone

**Files:**
- Modify: `gateway/webui/src/components/voices/AddVoiceModal.tsx`
- Modify: `gateway/webui/src/components/voices/VoicesPanel.tsx` (pass `fishBrowseEnabled` + a clone handler) and its parents so the flag + token reach the modal.

**Interfaces:**
- Consumes: `FishClonePanel` (Task 7), `createFishApi().cloneFromFish` (Task 6), `useServiceVersions().features.fish_browse_enabled` (Task 5).
- Produces: `AddVoiceModal` gains an optional `fishBrowseEnabled?: boolean` prop; when true, a third `Segmented` mode `{value:"fish", label:"Clone from Fish Audio"}` renders `<FishClonePanel>`. Picking a Fish voice prefills the modal's existing name/description/tags fields (from `suggestedName`/`suggestedTags`) and switches the modal into a "confirm clone" state; **Clone** calls a new `onCloneFromFish(fishVoiceId, name, description, tags): Promise<boolean>` (passed from VoicesPanel, which calls `fishApi.cloneFromFish` then refreshes + picks) instead of the record/upload `onCreate`.

- [ ] **Step 1: Add `.mp3` to upload accept** in `AddVoiceModal.tsx`: `const UPLOAD_TYPES = ".wav,.flac,.ogg,.mp3";` (the service now decodes mp3 — Task 1).

- [ ] **Step 2: Conditional third tab** — extend `MODE_OPTIONS` with the Fish entry only when `fishBrowseEnabled`; add `CaptureMode` variant `"fish"`; render `<FishClonePanel token={token} busy={busy} onClone={handleFishPick} />` in the `mode==="fish"` branch. `handleFishPick({fishVoiceId, suggestedName, suggestedTags})` sets local state (`fishVoiceId`, prefilled `name`=suggestedName, `tags`=suggestedTags capped to `MAX_TAGS`) and reveals the name/desc/tags editor + a "Clone voice" button whose submit calls `props.onCloneFromFish(fishVoiceId, name, description, tags)`; close on `true`. Reuse the existing metadata editor + toast patterns; keep the record/upload paths unchanged.

- [ ] **Step 3: Wire VoicesPanel** — pass `fishBrowseEnabled` (from `useServiceVersions`) + `onCloneFromFish` into `AddVoiceModal`. `onCloneFromFish` calls `fishApi.cloneFromFish(token, {...})`; on `ok` → `hook.load()` + set the new `voiceId` active (mirror the record/upload create success path incl. the `warning:"not-activated"` toast); on error → toast (surface a clip-too-short 422 as e.g. "That sample is too short to clone — try another voice."). Thread `fishBrowseEnabled` through `settings-view.tsx`→`VoicesPanel` (VoicesPanel can read `useServiceVersions` itself if it already has the token — implementer picks the least-plumbing route).

- [ ] **Step 4: Typecheck + lint + webui tests**

Run: `bun run typecheck && bun run lint && cd gateway/webui && bun run test`
Expected: PASS (94+ tests; no regressions).

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/voices/AddVoiceModal.tsx gateway/webui/src/components/voices/VoicesPanel.tsx gateway/webui/src/components/settings/settings-view.tsx
git commit -m "feat(webui): Clone-from-Fish tab in the add-voice modal"
```

---

## Task 9: E2E sweep + removal doc

**Files:**
- Modify: `agents/docs/testing-knowledge.md` (add Fish cases)
- Create: `docs/fish-integration.md` (the removal note)

Drive Playwright MCP against the rebuilt local stack (gateway rebuilt from branch, TTS restarted). Cover desktop + 390px. A case is green only when user-visible behavior AND the log trail match.

> **Prerequisite:** `fish_browse_enabled` defaults true; Fish `/model` browse is public so NO key is needed for browse. Rebuild the gateway (`docker compose -f deploy/macos/docker-compose.yml build gateway && up -d gateway`), restart the TTS service.

**E2E matrix:**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| fish-tab-visible | desktop | fish enabled | Add voice → tabs | "Clone from Fish Audio" tab present | webui services/versions `features.fish_browse_enabled=true` |
| fish-browse | desktop | Fish tab open | (loads) | grid of Fish voices with preview + tags | gateway `GET /providers/voices` 200, count>0 |
| fish-search | desktop | Fish tab | type a name | grid narrows (server `?title=`) | gateway `/providers/voices?title=` |
| fish-facet-filter | desktop | Fish results | click a language/gender/vibe chip | grid narrows client-side | — |
| fish-preview | desktop | a Fish tile | click ▶ | its mp3 sample plays (browser `<audio>`) | (no gateway synth — direct CDN mp3) |
| fish-clone | desktop | pick a Fish voice ≥6s sample | confirm name/tags → Clone | new local pack appears under Yours, auto-picked | gateway `clone` → service `voice.create` `create.success` |
| fish-clone-too-short | desktop | pick a voice w/ <5s sample | Clone | clear "sample too short" toast, no pack | gateway 422 clip-too-short, no `create.success` |
| upload-mp3 | mobile 390 | good.mp3 (>6s) | Upload tab → mp3 → Clone | pack created | service decodes mp3, `create.success` |
| fish-tab-hidden | desktop | set `fish_browse_enabled:false` in host config + restart gateway | Add voice → tabs | NO Fish tab; `GET /providers/voices`→404 | `features.fish_browse_enabled=false` |

- [ ] **Step 1: Rebuild + boot** the local stack; confirm the Fish tab appears + browse loads.
- [ ] **Step 2: Run every matrix row** (desktop + the mobile rows), capturing screenshots + network + the gateway/service log trail.
- [ ] **Step 3: Verify** each log trail (no unexpected WARN/ERROR).
- [ ] **Step 4: Write `docs/fish-integration.md`** — the self-contained REMOVAL note: (a) set `providers.fish_browse_enabled: false` to disable at runtime; (b) to fully remove: delete `gateway/src/providers/fish/`, `gateway/src/api/handlers/fish/`, `gateway/webui/src/services/fish-api.ts`, `gateway/webui/src/components/voices/fish/`, remove the conditional route mounts in the providers handler + the Fish tab in `AddVoiceModal`, drop the two `providers.fish_*` config keys + the `features.fish_browse_enabled` surface. Note the ToS caveat (Fish sample reuse for cloning).
- [ ] **Step 5: Pre-handover gate** — `bun run ci` green; service `uv run pytest -q` green.
- [ ] **Step 6: Commit**

```bash
git add agents/docs/testing-knowledge.md docs/fish-integration.md
git commit -m "test(fish): e2e sweep + removal/disable documentation"
```

---

## Known risks / notes
- **Short Fish samples** can't clone (<5s) — surfaced as a clear toast, not prevented (fish-clone-too-short case).
- **Fish ToS**: cloning Fish sample clips is a stronger reuse than playback; the whole feature is one flag/dir away from removal (Task 9 doc). Public repo — no key committed.
- **Fish id ≠ our slug/hex**: Fish ids are opaque and only ever flow to `fetchFishVoiceById` (URL-encoded), never to a filesystem path — so `VOICE_ID_SHAPE_RE` is deliberately NOT applied to the clone route's id (documented in Task 4).
