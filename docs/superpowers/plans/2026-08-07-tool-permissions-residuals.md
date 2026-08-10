# Tool Permissions — Residuals and Owner Decisions

Companion to `2026-08-07-tool-permissions.md`. Everything the 13-task build
deliberately did **not** do, why, and what needs your call. Nothing here blocks
the branch; every item was found by review or by smoke, adjudicated, and
recorded rather than silently dropped.

## What shipped

One per-tool setting — **Allow · Ask · Deny · Off** — rendered as a dropdown on
web, iOS and Android, owned by the gateway's `ToolBroker`. Underneath it, a role
gate: `canExecute(role, tier)` over `admin | adult | child | guest` and
`read | write | confirm | admin`. Both gates produce absence from the model's
`tools[]`, for the same reason, and are logged distinguishably.

Resolution, at **one** shared function that both the broker and the settings API
call, so the screen cannot lie about what the model can do:

```
stored[server][tool] ?? stored[server]["*"] ?? roleTemplate(role)[server][tool] ?? "off"
```

`mcp-policy.yaml`, `policy-engine.ts` and `policy-loader.ts` are gone.

Along the way the token stopped carrying authority (it identifies; every
decision resolves the role from the record at the moment of the decision), and a
role change now revokes the account's credentials — every earlier token stops
validating and the person's live sockets are closed.

## Needs your decision

### 1. A PIN reset does not revoke old tokens

`resetPinFlow` and `changePin` rewrite `pinHash` alone, so tokens issued under
the old PIN stay live — the one operation an operator performs *because* they
think a credential leaked. The mechanism is the same one-line write the role
change uses.

It is not done because the floor is per-user and global, so moving it on a PIN
change would also bounce the person who just changed their own PIN back to the
login screen. Whether that is right is a UX call. Comment-only at both sites
today.

### 2. `update_user_settings` resolves to Allow for everyone

It tiers as `read`, which is correct by the tier legend, and re-tiering it to
`write` would not add a prompt anywhere — it would make the tool **unreachable**,
because gateway-hosted tools only exist on the delegated socket (see §4). The
tier debate is moot until that changes.

### 3. `read`-tier tools that act on the house

`ha_get_camera_image` is `read`, so a `guest` can pull camera stills, and so can
a delegated Hermes run (`read` is the whole delegatable set). Same shape for
`ma_playback` / `ma_play_media` / `ma_volume`, which start audio in the house.

Not a regression — the retired `allow` tier held the same set — but the `guest`
role is new, and the legend says `read` means *"answers a question, or acts only
on the CALLER'S OWN session"*, which none of these four do.

### 4. The native loop cannot reach the gateway's own hosted tools

`config.yaml`'s `gateway:` entry is `transport: stdio`, and `mcp-client.ts:275`
skips every stdio entry. So a session's tool set is the HTTP catalog plus
`delegateTask`, and `identify_user`, `pause_audio`, `resume_audio` and
`update_user_settings` are reachable **only** through the delegated unix socket —
only by Hermes.

Consequences: your ruling that `identify_user` be allowed for every role "so the
model can function properly" is inert for the native loop; nobody has a
permission lever over the hosted half, since a tool absent from `mcpIndex` is
never resolved by that person's broker; and `delegated-broker.ts`'s promise that
a Deny/Off tool "must be refused here too" holds for *proxied* tools only.

Fixing it needs a design call — register the mcp-host tools natively beside
`delegateTask`, or teach the client to dial the unix socket.

### 5. Mobile still reads `isAdmin`, never `role`

`AuthUser` and `UserSummary` in the shared layer carry `isAdmin` and no `role`,
while the gateway documents `isAdmin` as derived and sunsetting. Both Ktor
clients set `ignoreUnknownKeys`, so `role` decodes and is discarded — meaning the
day `isAdmin` is dropped, every mobile user silently reads as non-admin.
Fail-safe, but silent. Mobile also cannot render `adult | child | guest` at all;
its Members roster shows only Admin/Member.

## Verified end to end

Nine of thirteen smoke cases green on the first run; the two that failed were
fixed and re-verified green, each two independent ways.

- A demotion closes the target's live socket — **and** a window that never
  started a conversation, which was the defect. `auth.error code=expired`, close
  1008, the tab routes itself to login.
- A demoted admin loses the Admin group at both viewports, with a positive
  control (a real admin sees it in full) so an empty nav cannot be mistaken for a
  broken build. `/api/v1/admin/*` still 403s.
- Reset-to-defaults restores the role template's answers rather than blanket
  `allow` — a `confirm`-tier tool reads **Ask**, verified by resolved value.

Two cases were not run: `cacheHitRatio` is structurally 0 on ollama-cloud (the
invariant it protects was verified directly instead — `tools[]` is byte-identical
across Allow/Ask/Deny and shrinks only under Off), and **native mobile Maestro
never ran at all** — the installed sim builds predate the feature and no flow
taps a per-tool select. That needs a build cycle plus new flows.

## Known residuals, verified, not fixed

| Where | What |
|---|---|
| `session-runtime.ts` | A turn already **running** when a revocation lands finishes under its old capability, including anything that steers it mid-flight. Bounded by that turn; no new turn starts. Closing it needs a third cancellation gesture. |
| `operator-config-migrator.ts` | The `0.1.5` step bumps `schema_version` even when it could not read an entry (a nested seq, or a map with no readable `name`). That host holds a config the schema refuses **and** a version the migration will never revisit — recovery is a hand-edit. Loud: the gateway won't boot, with a named error. |
| `operator-config-migrator.ts` | The migration round-trips the YAML, so untouched blocks reformat and comments can move. No values change. Pre-existing for every step in the chain. |
| web + iOS + Android | An unsettable tool (`delegateTask`) is enforced read-only in the **view** only; no ViewModel re-checks `settable`. Defence-in-depth, since native tools also have no write path at all. |
| `mcp-catalog.ts` | `projectServers` reads `tools.available ?? tools.include` while the broker reads `include` alone. The shipped config declares no `available`; the day an operator uses it, the settings screen lists tools whose dropdown saves and changes nothing. |
| `user-provisioner.ts` | `setRole` revokes credentials even when the role does not change, so an idempotent `PATCH {role:"adult"}` on an adult logs them out everywhere. Unreachable from the shipped UI, which only ever flips. |
| webui | A stale reconnect can eat a fresh login immediately after a kick, bouncing the person back to the picker as if their PIN failed. Pre-existing, self-clearing on reload. |
| `profile-renderer.ts` | `renderMcpServers` is a dead stub that always emits an empty block, carrying a comment instructing a task that has since come and gone to delete it. |
| `risk-accumulator.ts` | Five of six `RiskEvent` members have no emitter, including `policy_rejection` — named after the engine this slice deleted. |

## The recurring failure mode, for the next person

Eight tests on this branch passed against the very mutation they were written to
catch. **Every single one asserted an absence** — "this tool is not listed",
"nothing was sent", "the list is empty" — and every one was satisfied by the
thing under test never running at all.

The fix each time was the same: pin what *did* happen alongside what did not. An
ordered event log per socket, an exact object literal, a full key set. Where that
was done first — `credential-revocation.test.ts` is the model — the tests caught
close-before-send, double-ejection and skipped-peer regressions on their own.

The eighth instance was caught by the implementer before committing rather than
by a reviewer, which is the direction to keep moving.
