# Refactor Probe Progress

## Scoreboard
| Topic | Status | PlugSimp | StateComp | UserPres | ExtSurf | BndClarity | TestIsol | Total | Δ | Streak | Approaches |
|-------|--------|----------|-----------|----------|---------|------------|----------|-------|---|--------|------------|
| client-vad | ACTIVE | 7 | 5 | 6 | 8 | 8 | 3 | 37 | 37 | 0 | pluggable-detector-interface |
| sdk-state-machine | ACTIVE | 5 | 7 | 8 | 6 | 7 | 4 | 37 | 37 | 0 | pure-function-effects |
| sdk-gateway-contract | ACTIVE | 6 | 4 | 7 | 7 | 8 | 2 | 34 | 34 | 0 | utterance-lifecycle-contract |
| gateway-pipeline | ACTIVE | 5 | 4 | 4 | 7 | 7 | 2 | 29 | 29 | 0 | async-generator-composition |
| codec-negotiation | ACTIVE | 4 | 3 | 3 | 6 | 5 | 1 | 22 | 22 | 0 | negotiation-protocol-layered |
| testing-strategy | ACTIVE | 7 | 4 | 3 | 7 | 6 | 6 | 33 | 33 | 0 | mock-enhancement-layered-architecture |
| error-ux | ACTIVE | 5 | 5 | 6 | 6 | 6 | 1 | 29 | 29 | 0 | error-classifier-recovery |

## Task Queue

> For every `Score` task: you MUST read `expansion-loop.md` and `scoring-rubric.md` before starting. Do not score from memory or assumption.

- [x] Scan: read codebase, create exploration files in offline-research/2026-04-06-voice-pipeline-sdk/explorations/
- [x] Survey: all topics (skim landscape + codebase patterns, log in sources.md)
- [x] Explore: client-vad
- [x] Explore: sdk-state-machine
- [x] Explore: sdk-gateway-contract
- [x] Explore: gateway-pipeline
- [x] Explore: codec-negotiation
- [x] Explore: testing-strategy
- [x] Explore: error-ux
- [x] Synthesize: update synthesis.md
- [x] Score: client-vad → 37/60 (PlugSimp:7, StateComp:5, UserPres:6, ExtSurf:8, BndClarity:8, TestIsol:3)
- [x] Score: sdk-state-machine → 37/60 (PlugSimp:5, StateComp:7, UserPres:8, ExtSurf:6, BndClarity:7, TestIsol:4)
- [x] Score: sdk-gateway-contract → 34/60 (PlugSimp:6, StateComp:4, UserPres:7, ExtSurf:7, BndClarity:8, TestIsol:2)
- [x] Score: gateway-pipeline → 29/60 (PlugSimp:5, StateComp:4, UserPres:4, ExtSurf:7, BndClarity:7, TestIsol:2)
- [x] Score: codec-negotiation → 22/60 (PlugSimp:4, StateComp:3, UserPres:3, ExtSurf:6, BndClarity:5, TestIsol:1)
- [x] Score: testing-strategy → 33/60 (PlugSimp:7, StateComp:4, UserPres:3, ExtSurf:7, BndClarity:6, TestIsol:6)
- [x] Score: error-ux → 29/60 (PlugSimp:5, StateComp:5, UserPres:6, ExtSurf:6, BndClarity:6, TestIsol:1)
- [x] PoC: client-vad-state-table — build formal transition table and test every reachable state for exits and timeout guards
- [x] PoC: client-vad-test-harness — build sketch test suite testing VAD in complete isolation with mock/synthetic audio inputs
- [x] Explore: client-vad-alternative — explore alternative approach (need 2nd scored approach)
- [x] PoC: sdk-state-machine-consumer-api — build a minimal sketch showing a dev using the state machine in <50 lines with zero internal knowledge
- [x] PoC: sdk-state-machine-test-harness — build sketch test suite testing state machine in complete isolation with mock inputs
- [x] Explore: sdk-state-machine-alternative — explore alternative approach (need 2nd scored approach)
- [x] PoC: sdk-gateway-contract-state-table — build formal transition table and test every reachable state for exits and timeout guards
- [x] PoC: sdk-gateway-contract-test-harness — build sketch test suite testing contract in complete isolation with mock inputs
- [x] Explore: sdk-gateway-contract-alternative — explore alternative approach (need 2nd scored approach)
- [x] PoC: gateway-pipeline-consumer-api — build a minimal sketch showing a dev using the pipeline in <50 lines with zero internal knowledge
- [x] PoC: gateway-pipeline-state-table — build formal transition table and test every reachable state for exits and timeout guards
- [x] Rethink: gateway-pipeline — identify every moment where the user could be left without feedback, propose indicator states
- [x] Explore: gateway-pipeline-presence-gaps — map the timeline from user action to system response, find silent gaps
- [x] PoC: gateway-pipeline-test-harness — build sketch test suite testing pipeline in complete isolation with mock inputs
- [x] Explore: gateway-pipeline-alternative — explore alternative approach (need 2nd scored approach)
- [x] PoC: codec-negotiation-consumer-api — build a minimal sketch showing a dev using this component in <50 lines with zero internal knowledge
- [x] PoC: codec-negotiation-state-table — build formal transition table and test every reachable state for exits and timeout guards
- [x] PoC: codec-negotiation-test-harness — build sketch test suite testing codec negotiation in complete isolation with mock inputs
- [x] Investigate: codec-negotiation-boundary-leaks — find places where component A knows about component B's internals
- [x] Rethink: codec-negotiation — identify every moment where the user could be left without feedback, propose indicator states
- [x] Explore: codec-negotiation-presence-gaps — map the timeline from user action to system response, find silent gaps
- [x] Explore: codec-negotiation-alternative — explore alternative approach (need 2nd scored approach)
- [x] PoC: testing-strategy-state-table — build formal transition table for test layer lifecycle and test every reachable state for exits and timeout guards
- [x] Rethink: testing-strategy — identify every moment where the user could be left without feedback, propose indicator states for test coverage
- [x] Explore: testing-strategy-presence-gaps — map the timeline from user action to system response, find silent gaps in testing feedback
- [x] Explore: testing-strategy-alternative — explore alternative approach (need 2nd scored approach)
- [x] PoC: error-ux-consumer-api — build a minimal sketch showing a dev using the error classifier in <50 lines with zero internal knowledge
- [x] PoC: error-ux-state-table — build formal transition table and test every reachable state for exits and timeout guards
- [x] PoC: error-ux-test-harness — build sketch test suite testing error UX in complete isolation with mock inputs
- [x] Explore: error-ux-alternative — explore alternative approach (need 2nd scored approach)
- [x] Synthesize: update synthesis.md
