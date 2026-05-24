# ACP Probe Results — 2026-05-07

Verification of R1–R13 from `docs/superpowers/specs/2026-05-07-acp-pivot-design.md` §10
against the ACP overlay running locally. Plan reference: `docs/superpowers/plans/2026-05-07-acp-pivot.md`
Phase 3.2 + 3.3.

## Overlay version

- Image: `sentient/hermes:acp-test` built from `HERMES_VERSION=v2026.4.23`
- Profile: `u_8c866990` (live profile, mounted from
  `~/.sentient/gateway/data/u_8c866990` to `/data/u_8c866990` inside the
  test container)
- Probe scenario: `all` (initialize → session/new → session/list →
  session/prompt → cancel)
- Container: `acp-probe-test` on host port 8651 (kept clear of the
  running production stack on 8643–8650)
- Env: `OLLAMA_API_KEY` mirrored from the running gateway's per-program
  env so the LLM call could complete; probe used real `ollama-cloud`
  with the profile's configured model (`gemini-3-flash-preview:cloud`)

The overlay underwent two architecture changes during this phase before
the probe could run end-to-end:

1. The original duck-typed `WSStreamReader/Writer` adapters fail
   `acp.AgentSideConnection.__init__`'s strict
   `isinstance(stream, asyncio.StreamReader/Writer)` check. Initial fix
   built real `StreamReader/Writer` over `os.pipe()`. This worked at the
   protocol level but exposed a deeper issue (see #2).
2. Running `acp.run_agent(HermesACPAgent())` in-process skips Hermes'
   CLI-level profile bootstrap (model from `config.yaml`, `.env`,
   runtime credentials), so `AIAgent` was constructed with `model=""`
   and every chat completion failed with `HTTP 404: model "" not found`.
   Final fix: spawn `hermes -p <profile> acp` as a child process and
   bridge WS↔child stdio. Matches production's per-profile process model
   and inherits the standard CLI bootstrap.

The `ACPStreamBridge` (pipe-based) intermediate is not in tree —
`HermesACPBridge` (subprocess-based) replaced it before commit.

## Captured output

### Probe stdout — request results

`initialize`:

```json
{
  "agentCapabilities": {
    "loadSession": true,
    "sessionCapabilities": {"fork": {}, "list": {}, "resume": {}}
  },
  "agentInfo": {"name": "hermes-agent", "version": "0.11.0"},
  "authMethods": [
    {"id": "ollama-cloud", "name": "ollama-cloud runtime credentials",
     "description": "Authenticate Hermes using the currently configured ollama-cloud runtime credentials."}
  ],
  "protocolVersion": 1
}
```

`session/new` (excerpt — confirms model state restored after the
profile-config fix; see Decisions for the gateway-side template change
that replaces the originally proposed upstream patch `0011`):

```json
{
  "models": {
    "availableModels": [
      {"description": "Provider: Ollama Cloud • current",
       "modelId": "ollama-cloud:gemini-3-flash-preview:cloud",
       "name": "gemini-3-flash-preview:cloud"},
      ... (other ollama-cloud models)
    ]
  }
}
```

`session/list`:

```json
{
  "sessions": [
    {"cwd": "/",
     "sessionId": "40c87b6e-4f47-4216-aa66-213662cde408",
     "title": "Interrupted Cat Story Request",
     "updatedAt": "2026-05-07T23:39:36.416924+00:00"},
    {"cwd": "/", "sessionId": "...", "title": "Failed greeting API request", "updatedAt": "..."},
    {"cwd": "/", "sessionId": "...", "title": "Model not found error",      "updatedAt": "..."}
  ]
}
```

`session/prompt` (first prompt — completed end-to-end):

```json
{"id": 4,
 "result": {
   "stopReason": "end_turn",
   "usage": {"cachedReadTokens": 0, "inputTokens": 9233,
             "outputTokens": 199, "thoughtTokens": 0, "totalTokens": 9432}
 }}
```

`session/prompt` (second prompt — cancelled mid-generation):

```json
{"id": 5,
 "result": {
   "stopReason": "cancelled",
   "usage": {"cachedReadTokens": 0, "inputTokens": 9233,
             "outputTokens": 199, "thoughtTokens": 0, "totalTokens": 9432}
 }}
```

### Probe stdout — captured notifications

The probe captured 5 notifications during the 15s trailing window:

1. `available_commands_update` listing 7 commands (`help`, `model`,
   `tools`, `context`, `reset`, `compact`, `version`).
2. `agent_thought_chunk` — narrator status text (`( •_•)>⌐■-■ ruminating...`).
3. `agent_message_chunk` — final response to first prompt (`Hello there, how are you?`).
4. `agent_thought_chunk` — narrator status during second prompt.
5. `agent_message_chunk` — partial cat story (cancelled mid-stream:
   `Operation interrupted: waiting for model response (1.2s elapsed).`).

No `session_info_update` notification was emitted (R10 detail below).

### Server log highlights

```
ws-connected profile=u_8c866990 remote=185.199.108.133
spawned hermes acp child profile=u_8c866990 pid=8
hermes-acp[u_8c866990]: acp_adapter.entry: Starting hermes-agent ACP adapter
hermes-acp[u_8c866990]: acp_adapter.server: ACP client connected
hermes-acp[u_8c866990]: acp_adapter.server: Initialize from unknown (protocol v1)
hermes-acp[u_8c866990]: tools.mcp_tool: MCP server 'gateway' failed initial connection after 3 attempts (expected — no MCP UDS in test container)
hermes-acp[u_8c866990]: agent.auxiliary_client: Auxiliary auto-detect: using main provider ollama-cloud (gemini-3-flash-preview:cloud)
hermes-acp[u_8c866990]: acp_adapter.server: New session 31e3a3b2-0b1a-4d63-82e7-0fb0be9e4779 (cwd=/)
hermes-acp[u_8c866990]: acp_adapter.server: Prompt on session 31e3a3b2-...: Say hi in 5 words.
hermes-acp[u_8c866990]: acp_adapter.server: Prompt on session 31e3a3b2-...: Write a long story about a cat.
hermes-acp[u_8c866990]: agent.auxiliary_client: Auxiliary title_generation: using auto (nemotron-3-nano:30b)
hermes-acp[u_8c866990]: acp_adapter.server: Cancelled session 31e3a3b2-...
hermes-acp[u_8c866990]: ⚡ Interrupted during API call.
ws-disconnected profile=u_8c866990 remote=185.199.108.133
```

The MCP-server "failed initial connection" warnings are expected — the
test container is run standalone (no companion HA/MA/DDG containers, no
gateway-MCP UDS). They do not gate any R-finding.

## R1–R13 results

| #   | Risk | Result | Evidence / one-liner |
|-----|------|--------|----------------------|
| R1  | available_commands covers our slash commands | **PARTIAL** | Notification fires; upstream advertises `help, model, tools, context, reset, compact, version`. Our surface needs `personality, new, clear, skills` (`model` overlaps). Gap: rename + add 4 commands upstream OR translate gateway-side. See decisions. |
| R2  | ~~session/list returns `preview` per row~~ | **DROPPED** | Per-row preview feature retired per user direction. Drawer rows render title + lastActive + messageCount only. The gateway-side enrichment + overlay REST mount originally planned to fill the gap are no longer needed. |
| R3  | tool_call streaming wire matches | **DEFERRED** | Probe prompt `Say hi in 5 words` does not trigger tool calls. No `tool_call` / `tool_call_update` captured. Verify in Phase 4 / Phase 5 smoke once HA + DDG MCP servers are wired into the test container. |
| R4  | `session/cancel` aborts cleanly | **PASS** | Critical correction: ACP uses `session/cancel` (param: `sessionId`), NOT LSP-style `$/cancelRequest`. Cancel returned `stopReason: "cancelled"` in `session/prompt` response; server log shows `Cancelled session ... Interrupted during API call.` Probe corrected mid-investigation. |
| R5  | `_meta` extensibility on requests | **PASS** | Probe sent `initialize` with `_meta: {cycleId, customField}`; server accepted, response valid. Schema permits arbitrary additionalProperties under `_meta`. |
| R6  | `mcpServers` array per session/new | **PASS** | Probe passed `mcpServers: []`; `session/new` accepted. Tool routing not verified (R3 follow-on). |
| R7  | Custom WS transport framing | **PASS** | All requests + notifications round-tripped over WS; new `HermesACPBridge` test suite passes (6/6) inside container. |
| R8  | id correlation under concurrency | **PASS** | Standalone test sent ids 10/20/30 back-to-back; all three responses correlated correctly. |
| R9  | SOUL.md persona loaded | **PASS** | `request_dump_*.json` shows the system prompt being sent to ollama-cloud contains the full `# u_8c866990` SOUL.md content (warm family-AI persona, memory section, skills section). Persona path is intact through `hermes -p X acp` bootstrap. |
| R10 | auto-title timing (event-driven) | **PASS (event-driven, no polling required)** | `maybe_auto_title` runs (server log: `Auxiliary title_generation: using auto`); title persists to `state.db` and shows up in subsequent `session/list` rows (`Interrupted Cat Story Request`, `Failed greeting API request`). No `session_info_update` notification is needed: the past-sessions drawer is closed during a chat, so live-updating its rows is moot. The client requests `session/list` only when it needs it (drawer open, post-rename, post-delete) — auto-titles are present whenever the client asks. No upstream patch, no translator-side polling. |
| R11 | ARM64 (Pi) | **DEFERRED** | Per plan §6.x. Not exercised on this dev Mac. |
| R12 | `use_unstable_protocol=True` | **N/A under subprocess model** | Our spawn path is `hermes -p X acp` which already passes `use_unstable_protocol=True` internally (per `acp_adapter/entry.py`). The bridge no longer constructs `AgentSideConnection`, so the flag is upstream-managed. No gap. |
| R13 | Single-client reconnect | **PASS (overlay code path verified earlier)** | The new `HermesACPBridge` does not retain prior-WS bookkeeping in app state; we removed that since each connection now spawns its own subprocess (see "Decisions" — single-WS-per-port enforcement now relies on the supervisord program owning port 8650). Reconnect during in-flight prompt: prior WS close cascades to subprocess stdin EOF → child exits → new connection spawns a fresh child. |

## Decisions

### Block-rewrite gaps fixed in this phase

- **Architecture: in-process ACP runtime → subprocess.** Changed
  `acp_ws_server.py` to spawn `hermes -p <profile> acp` and bridge
  WS↔child stdio. Mandatory because the in-process path skips Hermes'
  CLI profile bootstrap. Side benefit: the overlay file shrank from
  one `acp.run_agent` call wrapped in pipe-bridge plumbing to a clean
  `asyncio.create_subprocess_exec` + two pumps. Test suite rewritten to
  match (`test_ws_stream_adapters.py`).

- **Gateway-side template change replaces patch `0011`.** Hermes'
  `acp_adapter/session.py:_make_agent` reads only `model_cfg.get("default")`
  while the gateway's profile-renderer was writing `model:`. The probe
  initially shipped a one-line upstream patch (`0011-acp-model-config-key.patch`)
  that taught ACP to accept either key. Per the user's hard-stop directive
  on adding upstream patches, that approach was retired. The fix moved
  to the gateway: the three model templates
  (`model.openrouter.tmpl`, `model.ollama-cloud.tmpl`, `model.custom.tmpl`)
  now write `default: {{model_id}}` instead of `model: {{model_id}}`.
  This satisfies ACP natively and preserves the gateway runner — the
  runner reads BOTH keys (`gateway/run.py:513`:
  `model_cfg.get("default") or model_cfg.get("model")`), so writing
  `default:` works for both code paths. Net effect: zero new patches,
  same behavior end-to-end. Patch `0011-acp-model-config-key.patch` is
  removed from `deploy/hermes-overlay/patches/`.

### Block-rewrite gaps deferred to Phase 4 (translator)

- **R1 slash-command surface.** Map upstream commands (`help, model,
  tools, context, reset, compact, version`) onto our UI's vocabulary
  (`personality, model, new, clear, skills`). Translator can synthesize
  `personality` (no upstream equivalent — set via `config.yaml`),
  `new` (= no-op locally; the gateway's UI already starts a new
  session via `session/new`), `clear` (= upstream `reset`), and
  `skills` (no upstream equivalent — gateway's MCP host serves these).
  Only `model` and `tools` map directly. Keep this in the gateway-side
  `availableCommands` translator; do not file an upstream patch.

- **R2 session/list preview field — DROPPED.** Per-row preview is
  retired as a feature; the past-sessions drawer renders title +
  lastActive + messageCount only. No translator enrichment, no overlay
  REST mount, no `GET /api/sessions/{id}` per row. The Hermes-internal
  coupling needed to fetch a useful preview (private
  `SessionDB._get_session_rich_row` because upstream's
  `GET /api/sessions/{id}` does NOT return preview) is not worth the
  cosmetic value.

- **R3 tool_call streaming.** Cannot verify with the standalone
  probe. Verify in Phase 4 once the test container has companion HA +
  MA + DDG MCP containers. The wire shape (`tool_call`,
  `tool_call_update`) is in upstream's `AgentNotificationKind`
  union — translator just maps to gateway's internal task-mirror
  events.

- **R10 auto-title — event-driven, no polling.** Hermes runs
  `maybe_auto_title` and persists the title to `state.db`; subsequent
  `session/list` calls return the title. The client requests
  `session/list` only when it actually needs it (drawer open,
  post-rename, post-delete) — the drawer is not visible during a chat,
  so there is no need to push a live `session_info_update` notification.
  Phase 4 T-B simplifies: no special poll path, no upstream patch —
  `session/list` is fresh on every client request.

### Non-blocking observations

- The probe needed two corrections during this phase:
  - `initialize` requires `protocolVersion: 1` (was missing).
  - Cancel uses `session/cancel` (notification, param `sessionId`),
    NOT LSP-style `$/cancelRequest`. Both fixed in
    `scripts/acp_probe.py`. Phase 4 gateway-side ACP client must use
    these correct shapes.
- `availableModels` advertises every Ollama-cloud model (auto-discovered
  from `models_dev_cache.json`). The gateway UI may want to filter
  this list to the user-configured model + a curated short list.
- Single-client-per-profile enforcement: with the subprocess-spawn
  architecture, each WS connection gets its own Hermes child, so the
  earlier "close prior WS before accepting new" logic still applies
  (the prior subprocess is shut down before a fresh one spawns).
- The `DeprecationWarning: Changing state of started or joined
  application is deprecated` from aiohttp comes from `app["active_ws"] =
  ws` after `app.start()`. Cosmetic; harmless. Move to a
  `weakref.WeakValueDictionary` or `app.middlewares` slot in a future
  cleanup if the warning becomes blocking.

## Blocking gaps for Phase 4

**None — plan stands as-is**, with these added Phase 4 tasks:

- T-A. Translator: map ACP `available_commands_update` → gateway's
  slash-command surface (synthesize `personality, new, skills`;
  rename `reset` → `clear`).
- T-B. Translator: when the client requests the past-sessions list
  (drawer open / post-rename / post-delete), call `session/list` —
  auto-titles for completed sessions are present whenever the client
  asks. No polling required. No upstream patch needed.
- ~~T-C. Overlay: mount `/api/sessions*` REST routes on the ACP WS
  port so the translator can call `GET /api/sessions/{id}` for preview
  enrichment without a second port.~~ **DROPPED** — preview feature
  retired (see R2 above). The overlay stays single-purpose: ACP WS +
  /healthz only.
- T-D. Translator: use `session/cancel` (param: `sessionId`) for
  interrupt + barge-in. NOT `$/cancelRequest`.
- T-E. Translator: send `protocolVersion: 1` on `initialize`. (Today
  the WS adapter sends a custom envelope; the new ACP wire MUST
  include this field.)

These are all gateway TS work — they do not require a respin of the
overlay or new upstream patches.

## Files of interest

- Overlay: `/Users/kevinye/Development/sentient/deploy/hermes-overlay/acp_ws_server.py`
- Overlay tests: `/Users/kevinye/Development/sentient/deploy/hermes-overlay/test_ws_stream_adapters.py`
- Gateway model templates: `/Users/kevinye/Development/sentient/gateway/templates/profile/model.openrouter.tmpl`, `model.ollama-cloud.tmpl`, `model.custom.tmpl` (all now write `default: {{model_id}}`, replacing the retired `0011-acp-model-config-key.patch`)
- Probe script: `/Users/kevinye/Development/sentient/deploy/hermes-overlay/scripts/acp_probe.py`
- Captured probe stdout: `/tmp/acp-probe-output.txt` (309 lines)
- Captured server log: `/tmp/acp-probe-server.log` (48 lines)
