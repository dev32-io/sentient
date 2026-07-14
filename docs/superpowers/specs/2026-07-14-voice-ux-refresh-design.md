# Voice Picking & Cloning UX Refresh — Design

**Branch:** `feature/local-tts-chatterbox` (stacked onto PR #19; lands together)
**Date:** 2026-07-14
**Status:** Design — pending user review

## 1. Goal

Refine the web UI for picking and cloning voices now that local Chatterbox TTS
is live. Replace the current thin "record/upload + flat list" Voices panel with
a single, filterable **Voice Packs** catalog that unifies **built-in packs**
(shipped, pre-cloned, read-only) and **user packs** (cloned from record/upload),
each with a live-synth **Play** preview, name/description/tags metadata, and a
minimal one-row filter.

## 2. Non-Goals

- **No Fish Audio.** The original idea (revive Fish browse as a clone source)
  was rejected: it re-adds the external key + proxy + preview stream we removed
  in PR #19 and carries voice-likeness/ToS risk. A bundled library gives the
  same browse/filter/preview/pick UX with none of that. (Decision below.)
- No emotion/vibe inference, no per-voice tuning knobs, no voice sharing controls
  beyond the already-shipped shared-household model (`gateway/src/api/handlers/voices.ts`
  authorization block — all authenticated members share one catalog).
- No mobile client changes (TTS wire unchanged; this is webui + gateway + service).

## 3. Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Clone/browse source | **Bundled library** — built-in packs shipped with the service + user cloning. No Fish. |
| Preview (Play button) | **Live-synth**: POST a random greeting → TTS renders it in that voice → play. |
| Filter depth | **Minimal**: one search + source toggle + tag chips. Search also matches tags. |
| Built-in clips | **Curated open-license set** (~4–6, CC0 / public-domain), pre-cloned, shipped in the service. |
| Tags | **Free-form + suggested chips.** Built-ins tagged from the same vocab so filters populate day one. |
| Branch / PR | **Stack onto `feature/local-tts-chatterbox`** (PR #19). Lands together. |
| Preview audio format | **WAV (PCM16)** — plays in `new Audio()` everywhere (avoids Safari ogg-opus `<audio>` gap). Conversation path stays opus. |

## 4. Information Architecture

One panel, one catalog, one filter row. Metadata editing lives in a modal, not
on the main surface — this is what removes the "multiple filters / nested groups"
crowding of the original tabbed proposal.

```
Voices
Pick the voice Sentient replies in — or add your own.               [ ＋ Add voice ]

[ 🔍 Search ]   [ All | Built-in | Yours ]
 #warm  #calm  #deep  #bright  #family                        ← union of tags, click to filter

┌───────────────┬───────────────┬───────────────┐
│ Nova       ♦ │ Atlas      ♦ │ Sage       ♦ │  name + source badge
│ Warm, calm    │ Deep, news    │ Bright, warm  │  description
│ #warm #calm   │ #deep #news   │ #bright       │  tags
│ ▶   ● Active  │ ▶   ○ Pick    │ ▶   ○ Pick    │  Play (live-synth) + radio-pick
├───────────────┼───────────────┼───────────────┤
│ Dad        ◐ │ ...                            │  ◐ = yours; delete via tile menu
│ ▶   ○ Pick    │                                │
└───────────────┴───────────────┴───────────────┘
```

- **♦** built-in (read-only, no delete). **◐** user pack (deletable by any member — shared household).
- **Add voice** opens a modal: `( ◉ Record | ○ Upload )` + Name / Description / Tags + **Clone**.

## 5. Architecture

Three tiers, unchanged in shape from PR #19 — this extends each.

### 5.1 TTS service (`capabilityServices/ChatterboxTTSService`, Python)

**Voice-pack meta gains `description` + `tags`.** Current meta:
`{name, createdAt, refDurationMs}` → new:
`{name, description, tags, createdAt, refDurationMs}`. Absent fields on old packs
read as `description: ""`, `tags: []` (backward-compatible load).

**Built-in library.** A shipped, read-only directory beside the writable user store:

```
capabilityServices/ChatterboxTTSService/voices_library/<slug>/
    conds.safetensors     # pre-computed Conditionals (committed binary)
    meta.json             # {name, description, tags}  (no createdAt/refDurationMs needed)
```

- `VoiceStore.__init__` takes an optional `builtin_dir: Path | None`.
- `list()` merges built-ins + user packs; every returned record carries
  `source: "builtin" | "user"`. Built-ins sort first.
- `get(voice_id)` resolves a **built-in slug** (from the known built-in set) OR a
  **user hex id**. Built-in resolution has its own validation: slug regex
  `^[a-z0-9-]{1,32}$` + belt-and-suspenders `is_relative_to(builtin_dir)`, exactly
  mirroring the existing hex traversal guard. Unknown/deleted → model default
  (unchanged fallback).
- `delete(voice_id)` **refuses a built-in** — raises a typed error / returns a
  distinct result so the wire can surface "cannot delete a built-in voice".
  User-pack delete is unchanged.
- `create()` unchanged in id minting (uuid4 hex, user store only); now also
  persists `description` + `tags`.

**Built-in id form = readable slug** (`nova`, `atlas`, …). User ids stay
`uuid4().hex`. Note a hex id *also* matches a permissive slug regex (a–f ⊂ a–z),
so shape alone cannot disambiguate. `get()`/`delete()` resolve by **known-built-in-set
membership first**: if `voice_id` is in the loaded built-in slug set → `builtin_dir`;
otherwise hex-validate → user `voice_dir`. Built-in slugs are minted from filenames
under `builtin_dir` at startup, never from caller input, so an attacker cannot forge
membership. (Practically, uuid4 hex — all digits/a–f — will never equal a
human-chosen slug like `nova`, but the set-membership check is the *guarantee*, not
the naming coincidence.)

**Wire protocol** (`wire_protocol.py`):
- `voice.create` message gains optional `description: str` and `tags: list[str]`.
  `VoiceCreateMessage` + `parse_client_message` + payload extended.
- `voice.list` result items gain `description`, `tags`, `source`.
- `voice.deleted` path: on a built-in id, emit `{type:"error", reason:"builtin-voice"}`
  instead of `voice.deleted`.
- **No new synth message for preview** — preview reuses the existing synth path
  (text in → audio frames out) on a connection opened with the target `voice_id`.

**Config** (`config.py`): `builtin_voice_dir` (default = packaged `voices_library/`),
plus caps used at the create boundary: `voice_description_max_len`, `voice_tag_max_len`,
`voice_max_tags`.

### 5.2 Gateway (`local-tts` provider + voices REST)

**Preview endpoint.** `POST /api/v1/voices/:id/preview` (Bearer auth):
1. Pick a greeting at random from the configured list.
2. Open a TTS connection with `voice_id=:id` **and `format=pcm`** (the service's
   direct-consumer PCM path).
3. Synthesize the greeting, buffer all PCM frames (greetings ~2s), wrap in a
   WAV container.
4. Return `200 audio/wav` (bytes). On service unreachable → `502 tts-unreachable`;
   on timeout → `504`; on unknown/invalid id → the synth still succeeds against the
   model default (service `get_or_default`), so preview is best-effort and never
   404s on a stale id.
- Bounded by a new `preview_timeout_ms`. One synth per request; no streaming.
- Reuses the generalized streaming synthesizer from PR #19 with a one-shot text +
  per-connection `voice_id` override, drained to a buffer (dispose-in-finally, same
  leak guard as the conversation path).

**Create with metadata.** `handleVoicesPost` / `parseCreateForm` parse
`description` + `tags` (repeated `tags` form fields) from the multipart body,
validate against caps (mirroring service caps as gateway constants sourced from
config), and forward to `createVoice(...)`. `voice-mgmt-client.createVoice` + the
`voice.create` wire message carry them.

**List surfaces new fields.** `VoiceSummary` / `listVoices` return
`{ voiceId, name, description, tags, source }`.

**⚠️ Contract change — the one cross-boundary risk.**
`gateway/src/api/handlers/voices.ts` currently guards DELETE with
`VOICE_ID_SHAPE_RE = /^[0-9a-f]{32}$/`. Built-in slugs don't match, and while the
UI never offers "delete" on a built-in, the endpoint must not 422 a legitimate
slug-shaped id from a crafted request in a way that masks the real "built-in" answer.
Resolution:
- Widen the shape guard to a single **`^[a-z0-9-]{1,32}$`** (a safe-shape check that
  covers both a 32-char hex id and a built-in slug; it only blocks path-traversal
  shapes — separators, `..`, over-length).
- Make the **service** the single authority that refuses built-in deletion (by
  set-membership, per §5.1); the gateway maps the service's `builtin-voice` error to
  `409 Conflict` (`{error:"builtin-voice"}`).
- `profile.voice.id` already stores an arbitrary string, so **picking** a built-in
  needs no profile-schema change. Verify the `z.preprocess` migration is untouched.

### 5.3 Web UI (`gateway/webui`)

New components (one per file, ≤300 lines, presentational vs container split per rules):

| File | Responsibility |
|------|----------------|
| `components/voices/VoicesPanel.tsx` (rewrite) | Container: loads via `use-voices`, owns filter + modal state. |
| `components/voices/VoiceFilterBar.tsx` | Search input + source segmented (All/Built-in/Yours) + tag chips. Pure, controlled. |
| `components/voices/VoicePackGrid.tsx` | Renders filtered tiles; empty/loading/error states. |
| `components/voices/VoicePackTile.tsx` | Badge, name, description, tags, Play (spinner in-flight), radio-pick, delete (user only). |
| `components/voices/AddVoiceModal.tsx` | Record/Upload segmented + name/description/tags editor + Clone. Reuses `VoiceRecorder`. |
| `components/voices/voice-filter.ts` | Pure: `filterPacks(packs, {q, source, tags})` + `deriveTagOptions(packs)`. Search matches name+description+tags. |
| `hooks/use-voice-preview.ts` | Single-flight `POST /voices/:id/preview`; aborts prior; plays via `new Audio(objectURL)`; revokes URL on end. |

- `hooks/use-voices.ts` + `services/voices-api.ts`: `VoiceSummary` gains
  `description`, `tags`, `source`; `createVoice` takes `description` + `tags`.
- **Play disabled while the assistant is actively speaking** (read SDK speaking
  state) — a preview and a live reply contend for the single TTS model; the guard
  prevents a preview from jittering a reply.
- **Tags input:** free-form add + a suggested-chip row (`warm, calm, deep, bright,
  family, kids, news, soft`); typing a new tag adds it. Caps enforced client-side
  (max tags, tag length) with the same constants as the gateway.
- **Filter state is local/ephemeral** (not URL params). A settings sub-pane filter
  is not a shareable view; `settings-view` already remounts the pane via `key={tab}`.
  Documented deviation from the URL-state rule.
- **Wizard reuse:** `components/.../step-voice.tsx` renders `VoicePackGrid` in a
  **pick-only** mode (built-ins only, no add/delete) so onboarding can choose a
  voice. One small task; low priority.

## 6. Data Flows

**Play (preview):**
```
tile Play click
  → use-voice-preview: abort any in-flight; POST /api/v1/voices/:id/preview
  → gateway: random greeting → TTS connect(voice_id=:id, format=pcm) → synth → WAV
  → 200 audio/wav → new Audio(objectURL).play()  (spinner clears on 'playing')
  new click / unmount / pick-change → abort + stop + revokeObjectURL
```

**Add (clone):**
```
Add modal → Record|Upload → client-side WAV encode
  → POST /api/v1/voices  (multipart: name, description, tags[], audio=wav)
  → gateway parse+validate → createVoice → service clone (uuid4 pack, meta w/ desc+tags)
  → 200 {voiceId,name} → grid reloads, new pack auto-picked (existing activate-on-create contract)
  too-short clip → 422 (no orphan pack, existing invariant)
```

## 7. Greetings (config `tts.preview_greetings`)

One chosen at random per preview:
- "Hi, I'm your family's Sentient assistant. How can I help?"
- "Hello there — Sentient here, ready when you are."
- "Hey! I'm Sentient. Ask me anything."
- "Good to see you. I'm your family assistant."
- "Hi! What can I do for the family today?"

## 8. Config additions

**`gateway/config.yaml` → `tts:`**
- `preview_greetings: [ ... ]` — greeting texts (list above).
- `preview_timeout_ms: 8000` — max wait for a preview synth.
- `voice_description_max_len: 240` — create/edit cap.
- `voice_tag_max_len: 24`, `voice_max_tags: 8` — tag caps.

**Service `config.py`**
- `builtin_voice_dir` — default packaged `voices_library/`.
- Mirror caps (`voice_description_max_len`, `voice_tag_max_len`, `voice_max_tags`)
  for defense-in-depth at the service boundary.

## 9. Built-in pack generation (asset task)

- Source ~4–6 diverse CC0 / public-domain clips (LibriVox public-domain readings
  or CC0 voice datasets), ≥6s each (service min is >5s).
- Run each through the service's `prepare_conditionals` on-host (Metal/MLX) to
  produce `conds.safetensors`; hand-write `meta.json` (name, description, tags from
  the suggested vocab).
- Commit packs under `voices_library/`. Record source + license + attribution in
  `voices_library/LICENSES.md`.
- Slugs: `nova`, `atlas`, `sage`, … (stable, `^[a-z0-9-]{1,32}$`).

## 10. Security notes

- Preview endpoint is Bearer-authed like the rest of `/voices*`.
- Built-in deletion refused at the service (authority), surfaced as `409` — the UI
  also hides delete on built-ins (defense in depth, not the only guard).
- Slug validation mirrors the existing hex traversal guard (regex + is-relative-to);
  `Conditionals.load` unpickle stays safe because built-in packs are service-shipped,
  not user-supplied.
- Preview reflects a *random* server-chosen greeting, not user input — no text
  injection surface. (If a future `?text=` is added, it must be length-capped and
  logged length-only.)
- No user/chat content logged; preview logs voiceId + elapsed + byte count only.

## 11. Testing (test-lean doctrine)

Keep only wire/protocol, FSM/invariant, and security-boundary tests.

**Service (pytest):**
- `voice_store`: built-in list/get resolves a slug; `delete(builtin)` refuses;
  meta round-trips `description` + `tags`; old meta (no desc/tags) loads as `""`/`[]`.
- `wire_protocol`: `voice.create` parses `description` + `tags`; `voice.list`
  result includes `source`; built-in delete emits `error/builtin-voice`.

**Gateway (vitest):**
- Preview handler: happy path returns `audio/wav`; `tts-unreachable` → 502;
  timeout → 504.
- `handleVoicesPost`: forwards `description` + `tags`; over-cap tag/description → 422.
- DELETE shape guard accepts hex OR slug; service `builtin-voice` → 409.

**No tests for:** `voice-filter.ts` (pure util), component wiring, tile rendering,
tag-chip UI — surface in smoke.

**E2E matrix (Playwright, live local stack — inline, per e2e rules):**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| browse-builtins | desktop | logged in, ≥4 built-ins shipped | open Voices | grid shows built-in packs, ♦ badge, tags | `voices.list` count≥4, source=builtin |
| filter-search | desktop | built-ins present | type "deep" in search | grid narrows to packs matching name/desc/**tags** | no error |
| filter-source | mobile 390 | built-ins + ≥1 user pack | toggle "Yours" | only ◐ user packs shown | — |
| filter-tag | desktop | tagged packs | click #warm chip | only #warm packs shown | — |
| preview-play | desktop | built-in pack | click ▶ | spinner → audible greeting in that voice | gateway `voices.preview` 200 audio/wav, bytes>0 |
| preview-abort | desktop | preview playing | click another ▶ | first stops, second plays | prior request aborted, no overlap |
| preview-tts-down | desktop | TTS service stopped | click ▶ | error toast, no crash | `502 tts-unreachable` (WARN) |
| add-record | desktop | mic available | record ≥6s + name/desc/tags → Clone | pack appears, auto-picked | `voice.create` w/ desc+tags, `create.success` |
| add-upload | mobile 390 | wav clip in fixtures | upload + meta → Clone | pack appears | `create.success` |
| add-too-short | desktop | — | record 2s → Clone | 422 toast, no orphan pack | `create.invalid`/422, no `create.success` |
| pick-builtin | desktop | built-ins present | pick "Atlas" | radio active; next reply uses Atlas | profile `voice.id=atlas`, refreshVoice |
| delete-user | desktop | ≥1 user pack, is active | delete it | pack gone; active resets to default | `delete.success`, profile reset |
| builtin-no-delete | desktop | built-in pack | inspect built-in tile | no delete affordance | (crafted DELETE → 409 `builtin-voice`) |
| speaking-guard | desktop | assistant speaking | attempt ▶ | Play disabled during speech | preview not dispatched |

Reuse `login`, `voices-create`, `voices-delete-reset` cases from
`agents/docs/testing-knowledge.md`; add the new preview/filter/builtin cases there.

## 12. Task decomposition (for the plan)

Independent, well-bounded — order roughly:
1. Service: meta desc+tags (create/list/wire) + tests.
2. Service: built-in library (dir, list-merge, slug get, delete-refuse) + tests.
3. Built-in pack assets (CC0 clips → conds + meta + LICENSES) — on-host.
4. Gateway: create-with-meta pass-through + list fields + caps.
5. Gateway: preview endpoint (WAV) + route + config + tests.
6. Gateway: DELETE guard widen + `builtin-voice`→409 + tests.
7. Webui: `voice-filter.ts` + `VoiceFilterBar` + `VoicePackGrid`/`VoicePackTile`.
8. Webui: `AddVoiceModal` (record/upload + metadata) + `use-voices` create-with-meta.
9. Webui: `use-voice-preview` + Play wiring + speaking guard.
10. Webui: `VoicesPanel` rewrite composing the above.
11. Wizard: `step-voice` pick-only grid reuse.
12. E2E sweep + testing-knowledge case additions.

## 13. Open risks

- **Built-in id/contract widening** (§5.2) — the only cross-boundary change; must
  keep the profile migration and traversal guards intact.
- **Preview vs live-reply contention** on the single TTS model — mitigated by the
  webui speaking-guard; if it proves audible in smoke, add a gateway-side reject
  during an active cycle (deferred).
- **Built-in conds portability** — packs are pickled `{t3, gen}` (per `voice_store`
  docstring), tied to the model. If the model version changes, built-in conds may
  need regeneration. Note in `LICENSES.md` which model version produced them.
