# Fish Audio integration — disable / removal guide

The "Clone from Fish Audio" feature lets a user browse Fish Audio's public
voice library (`api.fish.audio`) inside Settings → Voice → ＋ Add voice, and
clone a picked voice into a local Chatterbox voice pack. It was built as a
self-contained, removable module on both sides (gateway + webui) — this doc
is the operator-facing note for turning it off or ripping it out entirely.

## Known issue (as of this writing)

Cloning is currently broken: Fish's public `GET /model/:id` endpoint (used to
resolve a picked voice's sample audio) returns a **presigned URL on
`<hash>.r2.cloudflarestorage.com`**, not on `fish.audio` or a subdomain of it.
The clone route's SSRF host allowlist (`gateway/src/api/handlers/fish/fish-clone.ts`,
`ALLOWED_SAMPLE_HOST = "fish.audio"`) rejects that host, so every clone
attempt 502s with `preview-host-not-allowed` before a download is ever
attempted. Browse, search, facet filters, and preview playback (which hits
the list endpoint's `platform.r2.fish.audio` / `fish.audio` URLs directly from
the browser, never through the gateway) are unaffected. Fixing this requires
widening the allowlist to accept Fish's R2 storage host — track separately;
this doc covers disable/removal, not the fix.

## Option A — disable at runtime (no rebuild, no data loss)

Set the feature flag to `false` in the operator config
(`~/.sentient/gateway/config/config.yaml` in the standard macOS deploy) and
restart the gateway container:

```yaml
providers:
  fish_browse_enabled: false
```

```bash
docker compose -f deploy/macos/docker-compose.yml restart gateway
```

Effects, verified end-to-end:
- Every `/api/v1/providers/voices*` route 404s **before auth is checked** —
  a disabled deploy leaks no information that the route ever existed.
- The webui's `GET /api/v1/services/versions` response reports
  `features.fish_browse_enabled: false`, and the "Clone from Fish Audio" tab
  disappears from the ＋ Add voice modal (only Record / Upload remain).
- No rebuild needed — `fish_browse_enabled` is read at gateway boot from
  YAML config, default `true` (`shared/config/src/schema.ts`).
- Nothing under `gateway/src/providers/fish/` or `gateway/src/api/handlers/fish/`
  needs to change; the routes are gated, not removed.

This is the reversible option — flip back to `true` and restart to
re-enable.

## Option B — remove the feature entirely

Delete these directories/files:

- `gateway/src/providers/fish/` — the Fish HTTP client (`fish-fetcher.ts`,
  `fish-fetcher.test.ts`, `fish-voice-types.ts`).
- `gateway/src/api/handlers/fish/` — the browse + clone route handlers
  (`fish-browse.ts`, `fish-browse.test.ts`, `fish-clone.ts`, `fish-clone.test.ts`).
- `gateway/webui/src/services/fish-api.ts` — the webui's Fish API client.
- `gateway/webui/src/components/voices/fish/` — the browse grid UI
  (`FishClonePanel.tsx`, `fish-toolbar.tsx`, `fish-filter-section.tsx`,
  `fish-voice-tile.tsx`, `fish-bucket.ts`, `fish-langs.ts`).

Then remove the wiring that references those modules:

- **`gateway/src/api/handlers/providers.ts`** — the two `import` lines
  (`fish-browse.js`, `fish-clone.js`), the `fishDeps?` / `fishCloneDeps?`
  optional fields on the handler's deps type, the POST-clone mount block
  (routed before the blanket GET-only dispatch), the GET-browse mount block,
  and the `dispatchClone` helper.
- **`gateway/src/server.ts`** — the `fishDeps: {...}` and
  `fishCloneDeps: {...}` objects passed into the providers handler, and the
  `fishBrowseEnabled: services.providersConfig.fish_browse_enabled` passed
  into the services-versions handler.
- **`gateway/src/bootstrap/create-gateway-services.ts`** — the
  `fishApiKey: process.env.FISH_AUDIO_API_KEY ?? null` line and the
  `services.fishApiKey` field it populates.
- **`gateway/src/api/handlers/services-versions.ts`** — the
  `fish_browse_enabled` field on `ServicesVersionsFeatures` and its
  construction in the handler body.
- **`gateway/webui/src/components/voices/AddVoiceModal.tsx`** — the
  `FishClonePanel` import, `FISH_MODE_OPTION`, the `fishBrowseEnabled` prop,
  every `mode === "fish"` branch, and the `onCloneFromFish` prop.
- **`gateway/webui/src/components/voices/voices-panel-handlers.ts`** — the
  `handleCloneFromFish` function, `mapFishCloneError`, the `fishApi` dep, and
  the `FishApi` / `FishApiError` import.
- **`gateway/webui/src/components/voices/VoicesPanel.tsx`** — the
  `createFishApi()` import/instantiation, the `fishBrowseEnabled` derivation
  from `useServiceVersions`, and the `onCloneFromFish` prop pass-through to
  `AddVoiceModal`.
- **Config schema** (`shared/config/src/schema.ts`) — drop the two
  `providers.fish_browse_enabled` and `providers.fish_cache_ttl_ms` keys
  from `providersConfigSchema`. Also drop `providers.fish_cache_ttl_ms` from
  any operator config that sets it explicitly.
- **`FISH_AUDIO_API_KEY`** — drop the env var from any `.env` / secrets
  documentation; it was never required for browse (Fish's `/model` listing
  is public) and only optionally raised Fish's own rate limits.

### What can stay (Fish-agnostic, shared by Record/Upload too)

- `gateway/webui/src/hooks/use-voices.ts`'s `activateVoiceLocally` — generic
  optimistic-activation helper used by every voice-creation path, not
  Fish-specific.
- `gateway/webui/src/services/_helpers.ts`'s `reason` field on the shared
  API-error shape — used by every `services/*-api.ts` client (voices, auth,
  admin, providers, profile), not Fish-specific.

## ToS note

Fish Audio's public `/model` listing is intended for **playback preview**
(the sample tiles you hear in the browse grid). Cloning — downloading a
sample clip and feeding it into Chatterbox's voice-cloning pipeline to
synthesize new speech in that voice — is a materially stronger form of reuse
than playback and may not be covered by the same terms. No Fish API key is
committed to this (public) repository; `FISH_AUDIO_API_KEY` is optional and
resolved from the environment only. Operators enabling this feature in a
shared or production deployment should review Fish Audio's current ToS
before doing so — the whole feature is one flag flip (Option A) or one
directory-set deletion (Option B) away from being fully dark.
