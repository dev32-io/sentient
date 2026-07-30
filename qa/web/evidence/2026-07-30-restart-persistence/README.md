# restart-persistence — PASS (real native restart path)

**Pre-state:** the same rich 29-article session used for reload-convergence,
now grown further (13+ turns, tool calls, permission confirms, delegate
errors, several long essays).

**Action:** killed the gateway process (`kill <pid>`, the real native
`bun --hot src/main.ts` process, not a container) and relaunched it fresh
— this exercises the migration's actual restart path (was container
`docker restart sentient-gateway` pre-migration; now a real process
kill+relaunch, `launchctl kickstart -k` in prod). Also served double duty:
this restart was needed anyway to pick up the `compact_threshold_tokens`
config edit (see `2026-07-30-compaction-continue/README.md` — `bun --hot`
does not reload YAML config; discovered via zero `compaction.*` log lines
appearing well past the estimated new threshold, confirmed by only one
`config-loaded` line existing for the whole session before the restart).

**Result:** feed intact. Article count and tool-pill count unchanged
before/after (29 articles). The webui's own reconnect logic handled the
~7s restart window itself, with real evidence of the layered resume
protocol working as designed:
```
ws.reconnect: attempt failed ×4 (network, "ws closed before ready") — while the gateway was down
session-configured | epoch=1 requestedEpoch=3 requestedLastSeq=3311
resume.not-recovered | reason="fresh-journal-or-epoch-mismatch"   ← correct: a process restart has no live resume buffer
turn-emitter.conversation-snapshot | itemCount=48                 ← correct fallback: full history refetch from the persisted store
```
The client's own `stream.resumed.no-session-id — cannot refetch history`
warning is likewise the expected, correct signal for this path (live
stream-resume genuinely isn't available across a process restart; the
snapshot fallback is what actually carries the history through). No real
defect here — captured as evidence of the fallback working, not a bug.

Screenshot: `desktop-after-restart.png`.
