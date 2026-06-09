# Mobile Backend Configurability — Design

**Date:** 2026-06-04
**Status:** Approved design → ready for implementation plan
**Scope:** Android + iOS + KMP mobile SDK boundary. Spec 1 of 2 in the "mobile prod cleanup" series (Spec 2 = webui visual parity, separate doc).

## Context & Problem

Both mobile clients hardcode the backend (gateway) WebSocket URL at build time:

- `android/build.gradle.kts:29,33` — `buildConfigField` for debug (`wss://192.168.0.222:8888/api/v1/ws`) and release (`wss://home.dev32.io:8888/api/v1/ws`).
- `ios/App/SDK/GatewayConfig.swift:21,23` — `#if DEBUG` switch with the same two hosts.
- `ios/project.yml:27` — comment referencing `home.dev32.io`.

This locks anyone cloning the **public** repo (`github.com/dev32-io/sentient`) into the author's private infrastructure — a fresh clone cannot build a runnable app pointed at its own gateway. The SDK already accepts the URL via constructor (`SdkConfig.gatewayWsUrl` / `createSentientSdk(gatewayWsUrl:…)`), but nothing lets a user choose it at runtime, and there is no persisted override.

**Git-history finding (verified):** `home.dev32.io` was **never committed** — it exists only in the uncommitted working tree (`android/build.gradle.kts:33`, `ios/project.yml:27`). The only host string in committed history is the private LAN IP `192.168.0.222` (commits `e385dd4`, `be8be94`). Per decision, **no history rewrite** — that IP is a NAT'd private address, not security-sensitive, and rewriting force-pushes a public repo. The fix is clean-forward: externalize defaults so the private host is never committed again.

## Goals

1. A fresh public clone runs against the user's own gateway with a clear setup flow.
2. The agent can rebuild a **debug** build against a new IP by editing **one gitignored file** — no source edits.
3. No private host string in committed source.
4. Both debug and release expose a runtime "backend setup" page.
5. SDK boundary unchanged — it stays a black box that takes a resolved URL.

## Non-Goals

- Git history rewrite (clean-forward only).
- Bundle/application ID change — `io.dev32.sentient` is the org's legitimate reverse-DNS namespace, not a leak. **Keep it.**
- WebUI visual parity (Spec 2).
- TLS cert pinning / TOFU — reuse the existing trust-all mechanism; pinning is future hardening.

## Resolution Model

One precedence chain, identical on both platforms:

```
runtime-persisted override  →  build-time default  →  (none) ⇒ force setup page
```

- **Release** bakes **no default** → first launch has no usable URL → forces the setup page.
- **Debug** bakes a default from the local file (or a safe fallback) → straight to the avatar-grid login; the gear icon is always present to override.
- A runtime override, once saved, wins on every subsequent launch (both build types).

**Trust posture per source:** a runtime override carries the explicit security selection from the 3-way control. The **build-time-default path** uses `allowSelfSignedDevHost = (build type == debug)` — preserving today's "debug trusts self-signed for the local dev stack" behavior without a runtime selection. Release has no build-time default, so this only ever applies to debug.

## Build-Time Default (the agentic-rebuild knob)

### Android
- `local.properties` (already gitignored, `.gitignore:18`) gains key `sentient.gatewayUrl=wss://…`.
- `build.gradle.kts` reads it and emits `buildConfigField("String", "GATEWAY_WS_URL", …)`.
- Absent → safe fallback `wss://10.0.2.2:8888/api/v1/ws` (emulator loopback to host).
- **Release** build emits an **empty** `GATEWAY_WS_URL` (no fallback) so resolution forces the setup page.
- Commit `local.properties.example` documenting the key.

### iOS
- `Local.xcconfig` (new, **gitignored** — add to `.gitignore`) defines `GATEWAY_WS_URL = wss://…`.
- `project.yml` wires the xcconfig into the build settings; the value flows to `Info.plist`; `GatewayConfig` reads it from the bundle (replacing the `#if DEBUG` literals).
- Absent → fallback `wss://localhost:8888/api/v1/ws` (simulator reaches host `localhost`).
- **Release** leaves `GATEWAY_WS_URL` empty → forces setup page.
- Commit `Local.xcconfig.example`.

> The agent's full-agentic loop: edit `local.properties` / `Local.xcconfig`, rebuild. No tracked file changes, no private host in git.

## Persistence Layer (native-owned, per-platform)

- **Android:** a `BackendConfigStore` backed by **DataStore** holding `{ host, port, security, trustSelfSigned }`.
- **iOS:** a `BackendConfigStore` backed by **UserDefaults** (`@AppStorage`-friendly) holding the same fields.
- Each platform owns a `resolveGatewayConfig()` that applies the precedence chain and returns either a resolved `SdkConfig` input pair `(gatewayWsUrl, allowSelfSignedDevHost)` or "unconfigured" (→ force setup).

## Setup UI — "Sentient backend setup"

- **Entry points:**
  - **Gear icon**, top corner of the avatar-grid login screen (both build types, always present).
  - **Forced full-screen** when `resolveGatewayConfig()` returns "unconfigured" (release first launch). The avatar grid cannot load users without a backend, so setup precedes it.
- **Fields:**
  - **Host** (IP or domain) — required, non-empty.
  - **Port** — numeric, 1–65535, defaults to `8888`.
  - **Connection security** — 3-way segmented control (see mapping table).
- **Save button = save + probe (combined):**
  1. Tap → button shows in-progress spinner.
  2. Probe `GET {baseUrl}/auth/users` using the **same** scheme + trust setting that will be applied (so cert failures surface now). `baseUrl` derived via the existing `deriveBaseUrl()` (strip `/ws`, `wss→https`/`ws→http`).
  3. **Success** → brief checkmark on the button → persist → auto-dismiss the setup page → hot-swap apply.
  4. **Failure** → revert the button → stay on the page with inline error text (or a popup) describing the failure (unreachable / TLS rejected / bad host).
- No separate "Test connection" button — the test is folded into Save.

## Connection Security → SDK Mapping

The 3-way selector resolves to the SDK's existing two inputs, now sourced from persisted config instead of `BuildConfig.DEBUG` / `#if DEBUG`:

| Selector | `gatewayWsUrl` scheme | `allowSelfSignedDevHost` | Use case |
|---|---|---|---|
| **TLS — valid cert** | `wss://` | `false` (strict CA) | Public domain with a real cert |
| **TLS — trust self-signed** | `wss://` | `true` (reuse trust-all, per-backend) | LAN Sentient box with the gateway's self-generated cert |
| **Plain ws** | `ws://` | n/a | Non-TLS gateway (rare) |

URL construction: `{scheme}://{host}:{port}/api/v1/ws`. The path `/api/v1/ws` is a code constant the user never sees.

**Security note:** "trust self-signed" in a release build is a deliberate, per-backend opt-in. The UI carries a short warning. This matches the gateway reality — `gateway/config.yaml:43-58`: the gateway owns cert generation and serves **wss with a self-signed cert** on the LAN (no plaintext `ws` by default), so a release build needs this mode to reach a LAN box.

## Hot-Swap Apply (no restart)

On successful save, the native layer:
1. Tears down the current SDK holder + AuthClient.
2. Rebuilds them from the newly resolved `SdkConfig`.
3. Reconnects.

Seam: `SdkHolder` rebuild (Android) / `SdkStore.makeSdk` re-init (iOS). No app restart.

## SDK Boundary (unchanged)

The KMP SDK stays a black box constructed with `SdkConfig(gatewayWsUrl, allowSelfSignedDevHost, …)`. **Config resolution + persistence is native-owned, per-platform.**

**Rejected alternative:** push persistence into KMP via `expect/actual`. Rejected — persistence APIs differ (DataStore vs UserDefaults), the resolution logic is trivial, and it would widen the SDK surface for no gain. Keeps the "SDK takes a URL, knows nothing else" contract intact.

## De-hardcode / Git Changes

- Strip host literals from committed `android/build.gradle.kts`, `ios/App/SDK/GatewayConfig.swift`, and the `ios/project.yml:27` comment.
- Add `Local.xcconfig` to `.gitignore`.
- Commit `local.properties.example` + `Local.xcconfig.example`.
- **No history rewrite.** `192.168.0.222` stays in its 2 historical commits (accepted).

## Logging (per logging rules)

Tagged loggers required at these boundaries:
- Config resolution: which source won (override / default / unconfigured), the resolved scheme + host (host may be logged; no secrets involved), and `trustSelfSigned`.
- Save/probe: probe target, outcome (reachable / unreachable / TLS-rejected), elapsed ms.
- Hot-swap: teardown start, rebuild with new host, reconnect outcome.
- Force-setup decision with the reason (`no override`, `empty build default`).

## Decisions Log

| Decision | Choice |
|---|---|
| Git history | Clean-forward only, no rewrite |
| Spec structure | 2 separate specs; backend config first |
| Setup field shape | Host + Port + 3-way connection-security selector |
| Connection security | Single 3-way selector (TLS-valid / TLS-trust-self-signed / plain ws) |
| Force setup | Only when no usable URL (release first launch); debug uses baked default |
| Apply on save | Hot-swap, no restart |
| Save UX | Probe folded into Save; checkmark + auto-dismiss on success; stay + error on failure |
| Bundle ID | Keep `io.dev32.sentient` |
| Cert trust | Reuse trust-all per-backend (no TOFU/pinning) |

## E2E / Test Matrix (inline)

> **Scope caveat (per `.claude/rules/e2e-testing.md`):** Playwright/chromium cannot drive native Android/iOS apps. The full-flow cases below are **simulator/emulator + manual**, flagged for operator follow-up. Unit-level cases are automatable in the KMP/native test suites. "Viewport" column = build/device target.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Release first launch, no config | Release (device/sim) | No persisted override, empty build default | Cold launch | Setup page forced (no avatar grid) | force-setup decision logged, reason `empty build default` |
| Save valid public backend | Release | On setup page | Enter host + port, `TLS — valid cert`, Save | Spinner → checkmark → page dismisses → avatar grid loads | probe reachable, config resolved `wss/strictCA`, hot-swap reconnect ok |
| Save LAN self-signed backend | Release | On setup page | Enter LAN IP + port, `TLS — trust self-signed`, Save | Connects to self-signed gateway, grid loads | probe reachable with `trustSelfSigned=true`, no TLS-reject |
| Save unreachable host | Release | On setup page | Enter bad host, Save | Button reverts, inline error, stays on page | probe `unreachable`, no config persisted |
| Save wss-valid to self-signed box | Release | On setup page | Enter LAN IP, `TLS — valid cert`, Save | Button reverts, TLS error shown, stays | probe `TLS-rejected` |
| Debug default, no local override | Debug emulator/sim | `local.properties`/`Local.xcconfig` absent | Cold launch | Straight to avatar grid via fallback host | resolved source `build default` = `10.0.2.2`/`localhost` |
| Debug agentic rebuild | Debug emulator/sim | Edit local file to new IP, rebuild | Cold launch | Connects to the new IP | resolved source `build default` = new host |
| Change backend via gear (hot-swap) | Release | Connected to backend A | Open gear, change to backend B, Save | Tears down A, reconnects to B, no restart | hot-swap teardown→rebuild→reconnect logged for host B |
| Persistence across restart | Release | Saved override exists | Kill + relaunch | Goes straight to backend (no setup page) | resolved source `override` |
| Unit: URL builder | KMP/native unit | — | `(host, port, scheme)` → URL | — | `{scheme}://{host}:{port}/api/v1/ws` exact |
| Unit: precedence resolver | KMP/native unit | override / default / none permutations | resolve | — | correct source wins each permutation |
| Unit: config serialize round-trip | KMP/native unit | `{host,port,security,trust}` | persist → read | — | identical struct out |

## Out of Scope

- WebUI visual parity (Spec 2).
- Git history rewrite.
- Bundle-ID change.
- Cert pinning / TOFU.
- Gateway-side plaintext-ws support (gateway stays wss+self-signed on LAN).
