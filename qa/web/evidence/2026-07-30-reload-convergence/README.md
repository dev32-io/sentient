# reload-convergence — PASS

**Pre-state:** a real, rich 9-turn session (mix of plain replies, tool calls,
permission confirms allowed/denied, delegateTask errors, two long
essay-length replies) — deliberately not a toy fixture, so the projection
has to cope with every entry kind at once.

**Action:** hard reload (`page.goto` on the same URL — fresh WS connection,
new `epoch`).

**Result:** identical feed. DOM check before/after: **18 message
articles**, **12 `<code>` elements** (tool pills + inline code in the
delegate error text) — same both times. Server confirms via
`turn-emitter.conversation-snapshot | itemCount=35` on the reload (the full
underlying entry count, more granular than the 18 rendered bubbles since
one bubble can carry multiple tool pills). All tool tiles present after
reload (`ha_get_state`, `ha_search`, `ha_get_overview`, `ha_call_service`
×2, `delegateTask` ×5) — confirms `render(replay) == render(live)` holds
across the full entry-kind matrix, not just plain text turns.

Screenshot: `desktop-after-reload.png`.
