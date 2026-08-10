# NM-T9g — the delegated proxy tier, verified live

Branch `feature/native-orchestrator`, local dev stack (gateway `bun --hot src/main.ts` on `:8888`,
docker addons up, prod untouched). QA user **`u_1eee01a4`** — never hand-patched, the same user 9d
closed D11 on. Second user **`u_0417d3b0`** used for the drift/repair case; its profile was restored
byte-for-byte afterwards.

Artifacts here: `tools-list-u_1eee01a4.txt` (raw socket listing), `gateway-log-excerpt.txt`.

---

## 1. The proxy tier is advertised, and the negative holds

Raw JSON-RPC `tools/list` straight onto `~/.sentient/run/mcp-u_1eee01a4.sock` — no hermes in the
loop, so this is the gateway's own wire contract:

```
pause_audio  resume_audio                                  <- gateway-hosted, allow tier
ha_list_floors_areas  ha_config_get_calendar_events  ha_get_camera_image  ha_get_history
ha_get_overview  ha_get_state  ha_get_operation_status  ha_get_todo  ha_eval_template  ha_get_zone
fetch  search_web                                          <- PROXIED, allow tier
```

**The negative, asserted explicitly rather than eyeballed.** None of these appears:
`ha_call_service`, `ha_bulk_control`, `ha_set_todo_item`, `ha_remove_todo_item`,
`ha_config_set_calendar_event`, `ha_config_remove_calendar_event`, `ma_queue`, `ma_queue_item`,
`ma_group`, `ma_transfer_queue`, `update_user_settings`, `identify_user`, `delegateTask`.

Calling a confirm-tier tool by name anyway is refused at the registry, before any policy question:

```
-> {"method":"tools/call","params":{"name":"ha_call_service","arguments":{"domain":"lock","service":"unlock"}}}
<- {"error":{"code":-32601,"message":"unknown tool: ha_call_service"}}
```

`delegateTask` is `allow`-tiered in `mcp-policy.yaml` and is absent for a different reason: the
delegated broker registers **no background tools at all**, so recursive self-delegation is
structurally impossible rather than filtered.

## 2. The delegated agent really holds them

```
$ hermes -p u_1eee01a4 -z "List the exact names of every tool you can call, then stop."
…
mcp__gateway__fetch
mcp__gateway__ha_config_get_calendar_events
mcp__gateway__ha_eval_template
mcp__gateway__ha_get_camera_image
mcp__gateway__ha_get_history
mcp__gateway__ha_get_operation_status
mcp__gateway__ha_get_overview
mcp__gateway__ha_get_state
mcp__gateway__ha_get_todo
mcp__gateway__ha_get_zone
mcp__gateway__ha_list_floors_areas
mcp__gateway__pause_audio
mcp__gateway__resume_audio
mcp__gateway__search_web
```

A real search tool, not just `pause_audio` — which is what 9d's close could not say. The rest of that
output is **hermes's own tier** (`browser_*`, `terminal`, `memory`, its own `delegate_task`, …),
untouched by us: exactly the two-tier split the owner described.

## 3. A proxied call goes through the broker — the whole justification for the tier

```
$ hermes -p u_1eee01a4 -z "Call mcp__gateway__ha_get_overview once. Reply TOTAL_ENTITIES=<n>."
TOTAL_ENTITIES=211
```

Gateway log for that one call:

```
[mcp-host:delegated-broker] delegated-broker.created | userId="u_1eee01a4" role="adult" sessionChannel="text"
[tools:tool-broker]  tool-broker.pdp.decision | sessionId="delegated:u_1eee01a4" tool="ha_get_overview"
                     toolCallId="1c20355a-…" action="allow" reason="Read-only Home Assistant query"
                     rule="allow_ha_get_overview"
[tools:tool-broker]  tool-broker.dispatch.foreground.done | sessionId="delegated:u_1eee01a4"
                     tool="ha_get_overview" isError=false contentLength=9763
[mcp-host:proxied-tool] proxied-tool.done | tool="ha_get_overview" server="home_assistant"
                     userId="u_1eee01a4" isError=false contentLength=9763 elapsedMs=79
```

The PDP evaluated the call, named the rule that authorised it, and the result came back — 9,763 bytes
of real Home Assistant state. "Exit 0" is not what is being claimed here; the rule name and the byte
count are.

## 4. The dispatch-time setup phase repairs drift, and touches nothing else

On `u_0417d3b0`, a user-owned decoy MCP server was added, then the gateway entry was drifted to a
stale socket (which also left it `enabled: false`):

```
BEFORE  {"gateway": {"command":"nc","args":["-U","/tmp/stale-mcp.sock"],"enabled": false},
         "qa-decoy": {"command":"echo","args":["hello"],"enabled": false}}
```

Running the exact `provide()` the `delegateTask` setup phase runs:

```
[external-tools:hermes-cli] hermes-cli.ok | step="list" elapsedMs=159
[external-tools:hermes]     hermes.register.start | server="gateway" verdict="drifted"
                            socketPath="/Users/kevinye/.sentient/run/mcp-u_0417d3b0.sock"
[external-tools:hermes-cli] hermes-cli.ok | step="add"  elapsedMs=493
[external-tools:hermes-cli] hermes-cli.ok | step="list" elapsedMs=166
[external-tools:hermes]     hermes.register.ok | repairedFrom="drifted" elapsedMs=820
```

```
AFTER   {"gateway": {"command":"nc","args":["-U","/Users/kevinye/.sentient/run/mcp-u_0417d3b0.sock"],"enabled": true},
         "qa-decoy": {"command":"echo","args":["hello"],"enabled": false}}
```

**`qa-decoy` survived byte-identical, including its `enabled: false`** — a "normalising" reconcile
would have flipped that. A second run on an already-correct entry returned `{"ok":true}` in 174 ms
having issued exactly one `config get` and no `mcp add`. The decoy was removed afterwards and both QA
profiles are back to their pre-run state.

---

## Defect found by this verification, not by the plan — MCP replies over ~8 KB were truncated

The first live `tools/list` **hung**: the server logged `proxied-surface.refreshed` 33 ms after
connect and the client timed out at 60 s. `initialize` answered instantly on the same socket, which
ruled out the obvious "an async handler can't write" theory. A diagnostic on `socket.write`'s return
value gave the real answer:

```
WARN [mcp-host:unix-listener] reply-partial-write | written=8192 length=31604
```

`socket.write` accepts only what fits the send buffer and returns the count;
`unix-socket-listener.ts` ignored it and dropped the remaining 23 KB. A truncated JSON-RPC line has
no trailing newline, so the peer does not error — **it waits forever**. Latent since the MCP host was
written, invisible only because the hosted surface was two tools and always fitted in one write.

Fixed with a byte-level outbox drained from Bun's `drain` callback (`3f3675b`). The regression test
fails **by timeout** against the old single-write behaviour — mutation-verified, not assumed.

## Environment notes (neither caused nor fixed here)

- **`search_web` returns 0 results** on this box. `proxied-tool.done | isError=false` — the proxy
  path is fine; the `sentient-searxng` container itself logs
  `httpx.ConnectError: [Errno -3] Temporary failure in name resolution`. A local addon/DNS problem.
- **`ma_*` tools are absent from the listing.** The orchestrator recreates `sentient-ma-mcp` during
  boot reconcile, *after* the shared `McpClient` has already connected, and `tools/mcp-client.ts`
  caches a server's transport and only evicts it on a failed CONNECT — never on a failed
  `listTools`. So the poisoned session survives for the process lifetime
  (`Session not found`, `-32600`). This limits the "a late addon is picked up without a restart"
  claim and it affects the gateway's **own** loop identically. Pre-existing, outside this task's
  file ownership, recorded in `docs/native-todo.md`.
