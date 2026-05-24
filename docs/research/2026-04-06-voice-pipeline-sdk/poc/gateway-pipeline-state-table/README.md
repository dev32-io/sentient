# Gateway Pipeline State Table PoC

Formal state machine modeling the **server-side** gateway pipeline lifecycle.

## States (11)

| State | Description | Timeout Guard |
|-------|-------------|---------------|
| `disconnected` | No session | — |
| `connecting` | STT + TTS providers connecting | — |
| `idle` | Session active, ready for utterance | — |
| `receiving-audio` | Audio streaming to STT | — |
| `finalizing-stt` | STT finalizing transcript | 5s → STT_TIMEOUT |
| `running-llm` | LLM streaming tokens | 30s → LLM_TIMEOUT |
| `streaming-response` | LLM→TTS overlap, audio to client | (inherits LLM timer) |
| `cancelling` | Barge-in abort in progress | — |
| `reconnecting` | Provider dropped, reconnecting (3 retries) | 10s → RECONNECT_TIMEOUT |
| `error` | Recoverable error, session alive | — |
| `closed` | Terminal | — |

## Key Design Decisions

1. **LLM→TTS overlap modeled explicitly**: `running-llm` transitions to `streaming-response` on first `SENTENCE_READY`, while LLM tokens continue flowing. The `llmActive` context flag tracks whether LLM is still producing.

2. **Reconnect with retry budget**: 3 attempts before giving up. Attempts counter resets on success.

3. **Barge-in goes through `cancelling`**: Ensures abort propagates cleanly before accepting new input. `cancelling` always returns to `idle`, even on errors during cleanup.

4. **Every state transition emits user-visible feedback**: Status indicators (`connecting`, `listening`, `processing`, `thinking`, `speaking`, `ready`) or error messages. No silent gaps.

5. **Partial transcripts relayed during both `receiving-audio` and `finalizing-stt`**: Client gets real-time feedback even while STT is finalizing.

## Run Tests

```bash
bun test
```

154 tests covering: exhaustiveness, terminal state, timeout guards, reachability (BFS), transition table consistency, complete conversation flows, error recovery, barge-in, reconnection retry logic, and status indicator coverage.
