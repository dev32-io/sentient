# SentientMobileVitals — Design

**Status:** approved (brainstormed in-thread 2026-06-13)
**Branch:** `feature/resume-conversation-continuity` (continues on the existing branch — one PR)
**Scope:** KMP mobile (iOS + Android via `shared/mobile-sdk`) + a new gateway upload endpoint. Web later.

## Goal

A unified, self-hosted client diagnostic subsystem — **SentientMobileVitals** — that always captures the app's full runtime log (privacy-safe metadata only), survives app kill, auto-captures crashes, and lets a real occurrence be **uploaded to the gateway** for the developer to read. Built to debug hard-to-reproduce bugs (e.g. the warm-reconnect vanishing-bubble) and crashes **without** a commercial service (privacy) and **without** a dashboard (the dev reads raw files).

The name carries the brand; it is the platform umbrella for any future self-monitoring/diagnostic feature.

## Non-goals (explicit)

- **No symbolication / grouping / dashboards / alerting.** If crash *analytics* are ever wanted, the self-hostable OSS path is **GlitchTip** (~512 MB, 4 containers, Sentry-SDK-compatible) + `sentry-kotlin-multiplatform` — complementary, added later. SentientMobileVitals does NOT try to be that; it ships raw logs.
- **Native signal crashes (SIGSEGV/SIGABRT)** are NOT a guaranteed feature — async-signal-safe handlers can't do normal I/O. Mitigated by periodic/background flush (the file still holds recent logs), but those crashes may lack a clean crash marker. Documented gap.
- **Web** is out of scope now (same `createLogger` shape exists; same gateway endpoint reusable later).

## Architecture — commonMain owns the magic

~90% lives in `shared/mobile-sdk` commonMain. Each platform implements only a thin capability interface. The app's entire job: `init()` once, keep calling `createLogger().info/.error`, wire `onAppBackground()` into the existing presence relay, and have Settings call `listSessions()` + `upload()`.

```
commonMain — io.sentient.mobilesdk.vitals

  object/class SentientMobileVitals                 // the facade the app touches
    init(config, platform)        // capture session-meta; rotate file; register crash hook;
                                  //   on prior-crash marker → auto-upload immediately
    logger(tags).info/.error(...) // unchanged surface (createLogger), tee'd: sink + ring
    onAppBackground()             // flush ring → file (called by the existing presence relay)
    listSessions(): List<VitalsSession>   // for the Settings picker: label, ts, crashed?, size
    upload(sessionId, onProgress): Result<UploadRef>   // manual upload

  internal (all shared, NO platform import):
    RingBuffer        // bounded BY BYTES (cap ~2 MB working buffer); captures DEBUG+ always
    SessionMeta       // device/os/build/sdk/deviceId/userId/start/locale/network/mem (header)
    RollingFile       // rotate-at-launch (POSIX-time suffix); 50 MB/file cap; keep 5 files;
                      //   crash-marker; SessionMeta header block; buffered flush
    CrashFlush        // SYNCHRONOUS on-crash: flush ring → file + write crash marker (no net)
    Uploader          // single authenticated POST of the file; Ktor onUpload → progress %;
                      //   auto-fires on init when a prior crash marker is found

expect/actual — io.sentient.mobilesdk.vitals.SentientMobileVitalsPlatform  (thin)
    files: appDir read / write / list / delete    // Android filesDir · iOS Caches
    registerCrashHandler(onCrash: () -> Unit)      // Android UncaughtExceptionHandler ·
                                                   //   iOS K/N setUnhandledExceptionHook + ObjC
    deviceMeta(): DeviceMeta                        // UIDevice (iOS) · Build (Android)
    // reuse: Ktor (http) · existing Clock · the app's presence relay (lifecycle)
```

## Session metadata (captured at `init()`)

Written as a structured header block at the top of every rolling file AND carried with the upload (so even a rolled/truncated file is identifiable). All non-PII:

`platform` (ios/android) · `device` (model) · `os` (name+version) · `appVersion` + `build` · `sdkVersion` · `deviceId` · `userId` (if authed — opaque id) · `sessionStart` (POSIX+ISO) · `locale`/`language` · `network` (wifi/cellular/none) · `freeMem`/`freeDisk` · `appUptime` · `crashed` flag.

Excluded: display name, location, contacts, and any chat content.

## Capture & file model

- **Always-on, full detail.** The ring captures `DEBUG+` regardless of the logcat min level (release logcat stays `INFO+` and clean). Privacy-safe — see below.
- **Ring is byte-bounded** (~2 MB working buffer; a burst can't blow memory).
- **Buffered flush** ring → file on a timer, on app-background, and on crash. Not a write-per-line.
- **Rolling file:** one file per app launch, `POSIX-time` suffix; **50 MB/file** ceiling (rarely hit — a launch would need ~350k lines); **keep 5 files** (evict oldest) so the user can pick a prior session after relaunch.
- Stored in app-private dir (Android `filesDir`, iOS Caches). Worst-case local footprint 5×50 MB = 250 MB, but realistic is tens of MB (per-launch files are single-digit MB).

## Privacy

The SDK **already logs only metadata** — `deltaLen`/`totalLen` (not the text), `len` for sends/transcripts (not the message), ids/cycleIds — and `sanitizeLog` strips PASETO/Bearer before emission. So "no chat content in logs" holds today by convention. We add a **guard**: a commonTest that drives representative frames through the logger + ring and asserts no captured line contains the message bodies. Release builds need no redaction layer.

## Crash model

- **On crash (synchronous, local, fast):** `CrashFlush` flushes ring → file + writes a crash marker. **No network** — a dying process can't reliably do async I/O.
- **On next launch (auto, first thing):** `init()` detects the crash marker → `Uploader` auto-uploads that file immediately, before the user does anything.
- **Catch scope:** Kotlin unhandled exceptions on Android (`UncaughtExceptionHandler`, chaining the prior handler) + iOS K/N (`setUnhandledExceptionHook`) — covers crashes in the **shared SDK** where bugs live; iOS ObjC via `NSSetUncaughtExceptionHandler`. Native signals = documented gap (see non-goals).

## Upload model

- **Gateway endpoint:** `POST /api/v1/diagnostics/logs` — authenticated (PASETO bearer → `userId`, reusing the `readBearer` + `tokens.validate` pattern from `sessions.ts`). Body = the log file bytes + meta (meta also in the file header). Single POST (2 MB is small); Ktor `onUpload { bytesSentTotal, contentLength }` → progress %. Multipart deferred (only if logs grow / web parity / resumable later).
- **Gateway storage:** a NEW folder `clientLogs/mobile/` mounted at the same level as `logs/` (host `~/.sentient/gateway/clientLogs` → container `/app/clientLogs`, added to `deploy/{macos,pi,docker}` compose volumes). File named to be findable: `<userId>-<platform>-<device>-<sessionStart>[-crash]-<ref>.log`.
- **Ref code:** the POST returns a short `UploadRef`; the user quotes it ("ref AB12CD") and the dev greps the filename. Body-size limit configured (e.g. 64 MB) to bound abuse.

## UX — two lanes

1. **Crash lane — automatic, invisible.** Crash log auto-uploads on next launch. User does nothing (optional tiny notice: "Sent a crash report").
2. **Manual lane — you choose.** Settings → **"Send diagnostic log"** → session picker:
   - default-selects **"This session"**;
   - lists earlier sessions **newest-first, human-labeled** ("Today 9:43 PM", "Yesterday 2 PM"), **🔴 flag** crashed ones — never the POSIX suffix;
   - tap → the **button morphs in-place into a progress bar** (%) → **"Sent ✓ — ref AB12CD"** (or "Upload failed — retry").

One-line mental model: **"Crashes send themselves. For anything else: Settings → Send diagnostic log → pick the session → it uploads."**

## Versions

Bump on ship: `shared/mobile-sdk` + Android + iOS apps (+0.0.1), gateway (+0.0.1, new endpoint). Coherent with the existing scheme.

## E2E matrix

> Native = Maestro (Android `adb` + iOS `simctl`); driven against the local stack. Web N/A (not built).

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Manual upload happy (Android) | Android app | Logged in; some chat activity (log has content) | Settings → Send diagnostic log → "This session" | Button → progress bar → "Sent ✓ ref …" | gateway: `POST /api/v1/diagnostics/logs` 200; new file under `clientLogs/mobile/`; no WARN/ERROR |
| Manual upload happy (iOS) | iOS app | Same | Same (`simctl`) | Same | Same |
| Pick a prior session | Android/iOS | ≥2 launches, one earlier | Settings → picker → select earlier session (human label) | Earlier session uploads | gateway file for the earlier `sessionStart` |
| Crash auto-upload | Android/iOS | Trigger a Kotlin unhandled exception | Crash → relaunch app | (optional) "Sent a crash report"; no manual step | crash marker in file; auto `POST` on relaunch; filename has `-crash-` |
| Session-meta present | Android/iOS | Fresh launch | Upload current session | — | uploaded file header has platform/device/os/build/sdk/deviceId/start/network |
| Privacy guard | commonTest (unit) | Representative frames (user/assistant/delta) | Drive logger + ring | — | assert NO captured line contains the message bodies |
| Upload offline (sad) | Android/iOS | Airplane mode | Tap Send | "Upload failed — retry" (no crash, no hang) | no server file; client logs the failure |
| Retention eviction (sad) | Android/iOS | 6 launches | Inspect local files | Only 5 newest retained | oldest file deleted |

A case is green only when the user-visible behavior AND the log trail match.

## Open / deferred

- GlitchTip + `sentry-kotlin-multiplatform` for crash *analytics* (symbolicated dashboards) — later, complementary, not a replacement for raw-log upload.
- Web client parity (same endpoint, browser ring) — later.
- Native-signal crash capture — documented gap.
- Gateway `clientLogs/` retention/cleanup policy (operator-managed; cap or age-out) — confirm at plan time.
