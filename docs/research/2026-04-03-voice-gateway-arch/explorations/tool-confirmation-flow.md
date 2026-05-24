# Tool Routing Sub-Decision: Confirmation Flow

## Parent Decision Area
`tool-routing` — this is a sub-decision extracted during decomposition.

## Decision Area
How the gateway pauses the agent loop to request user confirmation for high-impact tools, handles timeouts, WebSocket disconnects, and barge-in during the confirmation wait. The score flagged: `session.request_confirmation()` is referenced but never defined; no handling for WebSocket drops during await.

## Key Questions

1. **Confirmation protocol**: Exact message sequence between gateway and client for confirm-execute tools — request, approve/deny, timeout, cancel.
2. **WebSocket drop during await**: If the client disconnects while the gateway is waiting for confirmation, how does the agent loop recover? Retry on reconnect? Auto-deny?
3. **Timeout behavior**: What happens when the 30s confirmation timeout expires? Inform the LLM? Retry? How does the LLM respond to the user?
4. **Barge-in during confirmation**: If the user speaks a new command while a confirmation is pending, does the new command cancel the pending confirmation?
5. **Multiple pending confirmations**: If the ReAct loop emits two confirm-tier tool calls in parallel, how are they presented to the user? Sequential? Batched?
6. **Confirmation UX across clients**: Desktop can show a dialog; mobile can show a notification; voice-only has no screen — how does confirmation work for voice-only clients?
7. **Future state tracking**: The agent loop's asyncio future for confirmation — lifecycle management, cancellation, garbage collection.

---

## Approaches

*To be explored in the Explore step.*
