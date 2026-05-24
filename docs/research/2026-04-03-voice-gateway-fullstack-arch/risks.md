# Cross-Cutting Risks & Mitigations

> Last updated: 2026-04-04 (second synthesis — post-scoring, post-PoC, post-decomposition)

## Hardware Constraints
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| RPi5 8GB insufficient for local STT + gateway | High | Medium | Cloud STT as primary; whisper.cpp only as offline fallback (Phase 3) | Gateway validated: 60-90MB for 10 sessions (4% of 8GB) |
| Thermal throttling under sustained whisper.cpp inference | Medium | High | Active cooling mandatory; whisper.cpp is fallback-only, not primary path | — |
| SSD I/O bottleneck under concurrent sessions | Low | Low | Memory files are small (<5KB each); audio is streamed not stored | — |
| Bun ARM64 stability under 24/7 operation | Medium | Low | Less production deployment data than Node; migration to Node is bounded | Gateway PoC validated on x86; ARM64 needs prod validation |

## Bun Runtime
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| Outgoing WebSocket binary frame issues with providers | High | Medium | Always use `binaryType = "arraybuffer"`, raw WS instead of SDKs | **RESOLVED** — validated in stt-deepgram-raw-ws + provider-integration-bun-ws PoCs |
| N-API addon incompatibility (onnxruntime-node for Silero VAD) | Medium | Medium | Fallback: WebRTC VAD or energy-based VAD; needs Phase 2 validation | **OPEN** — needs PoC on ARM64 |
| Bun API churn between minor versions | Low | Medium | Pin Bun version; update deliberately | — |
| `ws.ping()` not implemented in Bun | Low | High | Application-level keepalive (Deepgram KeepAlive JSON, Fish Audio heartbeat) | Validated in provider PoC |
| Bun `--hot` losing WebSocket connections | Low | Medium | Irrelevant for production (use process restart); accept for development DX | — |
| paseto-ts addExp short-duration parsing broken | Low | Certain | Use explicit ISO `exp` claims instead of addExp duration strings | **RESOLVED** — workaround validated in security-paseto-bun PoC |

## Security
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| Prompt injection via STT transcription | High | Medium | 6-layer defense: sanitization, heuristic patterns, structural separation, privilege reduction, canary tokens, output filtering | 95.7% detection (22/23), 0% FP (0/24), 1.65μs/call — validated |
| Voice-specific phonetic injection attacks | Medium | Low | STT normalizes homophones; heuristic patterns cover "system colon" variants; privilege reduction is the true defense | 1 miss in 23 tests (4.3%) — acceptable given layered defense |
| Guest token theft/reuse | Medium | Low | Short TTL (4h), single-use PIN, IP binding, no refresh token | Token lifecycle validated in PoC |
| Memory file path traversal | High | Low | Strict user ID sanitization (`[a-zA-Z0-9_-]` only) + resolved path prefix validation | — |
| API key exposure in logs/responses | Critical | Low | Encrypted config → memory-only decryption; output filtering scans for key patterns; audit log sanitization | — |
| Skill code injection via malformed markdown | Medium | Low | Skills are LLM-interpreted, not executed as code; scoped tool lists enforced at ReAct loop level | Sandbox blocks undeclared tools — validated (27/27) |
| Children bypassing role restrictions | Low | Medium | Role encoded in PASETO token (tamper-proof); tool tiers enforced server-side | PASETO tamper resistance validated |
| ByteArray race condition in audio pipeline | Medium | Low | Copy-on-emit in FrameAccumulator (ByteArray.copyOf) | **RESOLVED** — fixed and validated in android-client-audio-pipeline PoC |

## Provider Dependencies
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| Deepgram outage → no STT | High | Low-Medium | Circuit breaker → whisper.cpp fallback (Phase 3); text input always available | Deepgram raw WS validated; circuit breaker pattern validated |
| OpenRouter outage → no LLM | Critical | Low | Retry with exponential backoff; no viable fallback (hard dependency) | — |
| Fish Audio outage → no TTS | Medium | Low | Graceful degradation: text-only response delivery; client shows text | Fish Audio WS+MsgPack validated; barge-in cancel works |
| Deepgram pricing increase | Low | Low | Simple provider interface; raw WS means easy swap to AssemblyAI or other | AsyncGenerator interface makes provider swap clean |
| OpenRouter model deprecation | Medium | Low | Model specified in YAML config; swap is a config change | — |
| Picovoice pricing for 5+ devices | Medium | Medium | Free tier covers 3; contact for personal pricing; worst case ~$50/month or switch to openWakeWord server-side | **OPEN** — pricing unconfirmed |

## Reliability
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| Internet outage → assistant mostly dead | High | Low-Medium | Whisper.cpp STT fallback; Tier 1 regex classifier works offline; but LLM/TTS require internet | — |
| WebSocket connection instability | Medium | Medium | Session persistence (120s suspend), sequence-numbered replay, exponential backoff with jitter | 10 concurrent sessions validated; echo round-trip 0.14ms avg |
| Skill engine crash from malformed skill | Medium | Low | Validation on load (frontmatter schema, tool existence, cycle check); LLM interpretation is resilient | Cycle detection validated: 0.006ms/50-skills |
| Memory extraction producing bad updates | Low | Medium | LLM sees current memory for dedup; section token limits enforced; git tracking enables rollback | — |
| Concurrent memory file writes | Low | Low | Extremely rare at family scale; last-write-wins is acceptable | — |
| AsyncGenerator resource leaks | Medium | Medium | Mandatory `.return()` + AbortSignal + session timeout; generator leak mitigation pattern validated in PoC | Provider PoC validates cancel propagation |

## Privacy
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| Cross-user memory leakage | High | Low | Path-validated memory loading, session isolation, role in token claims | — |
| Guest memory persistence | Medium | Low | In-memory Map only, explicit cleanup at session end, no file writes | — |
| Always-on mic privacy concerns | Medium | Medium | On-device processing only (Porcupine), no cloud until wake word; orange/green dot visible | — |
| Audio sent to cloud STT | Medium | Low | Deepgram is the primary STT; audio leaves home network. Whisper.cpp local is the privacy-preserving fallback. | — |
| LLM sees family conversations | Medium | Low | Inherent to cloud LLM. OpenRouter processes but doesn't retain (per their policy). No local LLM viable on RPi5. | — |

## Platform-Specific
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| iOS background wake word impossible | High | Certain | Accept foreground-first design; PTT when backgrounded; dedicated iPad for always-on | **RESOLVED** — design decision made |
| iOS silent audio workaround breaking | Medium | Medium | Don't rely on it; core UX is foreground-first | **RESOLVED** — not pursuing workaround |
| Android OEM battery killers (Xiaomi, Huawei, Samsung) | Medium | High | In-app guidance to disable; dontkillmyapp.com reference | — |
| Safari MediaRecorder lacks Opus | Low | Certain | opus-media-recorder WASM polyfill (~300KB); WebM parser validated in web-client PoC | Custom EBML parser validated (71/71) |
| TestFlight 90-day build expiry | Low | Certain | Monthly CI uploads via Fastlane or Xcode Cloud | — |
| COOP/COEP headers required for AudioWorklet | Low | Certain | Headers configured on all gateway HTTP endpoints | **RESOLVED** — validated in web-client PoC |
| Android FrameAccumulator ByteArray race | Medium | Low | Copy-on-emit pattern; validated fix | **RESOLVED** — fixed in android-client PoC |

## Cost
| Risk | Impact | Likelihood | Mitigation | PoC Status |
|------|--------|------------|------------|------------|
| Monthly costs exceed budget (~$50/mo target) | Medium | Low | Classifier routes 70% to Haiku (cheap); VAD trims STT silence; $200 Deepgram free credit provides runway | Classifier validated: 0.37μs regex, saves ~$40/month |
| Deepgram free credit exhaustion | Low | Certain (in ~19-24 months) | Budget for ~$7-10/month STT cost | — |
| LLM costs scale with usage | Medium | Medium | Model routing (Haiku for chat, Sonnet for tools); token budget management; monitor OpenRouter billing | — |
| Skill execution LLM cost | Low | Medium | ~$6-15/month at 50 skills/day; acceptable for simplicity gains over deterministic engine | — |
