// @sentient/web-sdk — Public API

// ---------------------------------------------------------------------------
// Browser-side tagged logger
// ---------------------------------------------------------------------------

export { createLogger } from "./logger.ts";
export type { Log } from "./logger.ts";

// ---------------------------------------------------------------------------
// Connector-based SDK
// ---------------------------------------------------------------------------

export type {
  Connector,
  IdlePresenceConfig,
  PresenceWiring,
  PresenceWiringFactory,
  PresenceWiringHooks,
  ReconnectConfig,
  SentientSDKConfig,
  SentientSDKInternal,
  SDKStatus,
  SessionReadyPayload,
} from "./connector-types.ts";
export { SentientSDK } from "./sentient-sdk.ts";

export { UserAudioInputConnector } from "./connectors/user-audio-input-connector.ts";
export type { UserAudioInputConfig } from "./connectors/user-audio-input-connector.ts";

export { UserTextInputConnector } from "./connectors/user-text-input-connector.ts";

export { PreferencesConnector } from "./connectors/preferences-connector.ts";
export type {
  AudioPreferences,
  AudioPreferencesPatch,
  PreferencesConnectorConfig,
} from "./connectors/preferences-connector.ts";

export { AssistantAudioResponseConnector } from "./connectors/assistant-audio-response-connector.ts";
export type {
  AssistantAudioFormat,
  AssistantAudioResponseConfig,
} from "./connectors/assistant-audio-response-connector.ts";

export { CognitionStatusConnector } from "./connectors/cognition-status-connector.ts";
export type {
  CognitionStatusConfig,
  CognitionState,
} from "./connectors/cognition-status-connector.ts";

export { ConversationHistoryConnector } from "./connectors/conversation-history-connector.ts";
export type { CommittedFeedItem, ConversationHistoryConfig } from "./connectors/conversation-history-connector.ts";

export { InFlightMessageConnector } from "./connectors/inflight-message-connector.ts";
export type {
  InFlightMessage,
  InFlightMessageConnectorConfig,
} from "./connectors/inflight-message-connector.ts";

export { ToolStatusConnector } from "./connectors/tool-status-connector.ts";
export type { ToolCallSnapshotItem, ToolStatusConnectorConfig } from "./connectors/tool-status-connector.ts";

export { PermissionConfirmConnector } from "./connectors/permission-confirm-connector.ts";
export type {
  PermissionConfirmConnectorConfig,
  PermissionRequestItem,
} from "./connectors/permission-confirm-connector.ts";

export { DelegationProgressConnector } from "./connectors/delegation-progress-connector.ts";
export type {
  DelegationProgressConnectorConfig,
  DelegationProgressItem,
} from "./connectors/delegation-progress-connector.ts";

export { SessionsConnector } from "./connectors/sessions-connector.ts";
export type {
  SessionsChangeEvent,
  SessionsConnectorConfig,
} from "./connectors/sessions-connector.ts";

export { createSessionsRest, deriveRestBaseUrl, SessionsRestError } from "./sessions-rest.ts";
export type { SessionsRest, SessionsRestConfig, SessionsListResult } from "./sessions-rest.ts";

export { createCrossTabSync } from "./cross-tab-sync.ts";
export type { CrossTabSync, CrossTabSyncConfig } from "./cross-tab-sync.ts";

// ---------------------------------------------------------------------------
// Audio utilities
// ---------------------------------------------------------------------------

export { createEmitter, type TypedEmitter } from "./event-emitter.ts";
export { pcm16ToFloat32, float32ToPcm16 } from "./audio-codec.ts";
export type { AudioCaptureAdapter } from "./audio-capture-adapter.ts";
export type { AudioPlaybackAdapter } from "./audio-playback-adapter.ts";

// ---------------------------------------------------------------------------
// Turn-keyed TTS audio queue — strict sequential FIFO (spec §7.2). A new turn
// NEVER preempts, fades, or replaces in-flight audio; `cancelAll()` is the ONLY
// flush path and is driven exclusively by barge-in / interrupt.
// ---------------------------------------------------------------------------

export { createTurnAudioQueue } from "./turn-audio-queue.ts";
export type { TurnAudioPlayback, TurnAudioQueue, TurnAudioQueueOptions } from "./turn-audio-queue.ts";

// ---------------------------------------------------------------------------
// Echo gate — client-side mic pre-filter that suppresses frames while the
// assistant's voice is playing back. Pure state machine; portable to native
// platforms verbatim (see echo-gate.ts for porter notes).
// ---------------------------------------------------------------------------

export {
  createEchoGate,
  computeRms,
  defaultEchoGateScheduler,
} from "./echo-gate.ts";
export type {
  EchoGate,
  EchoGateConfig,
  EchoGateDeps,
  EchoGateScheduler,
  EchoGateSnapshot,
  EchoGateState,
  EchoGateTimerHandle,
} from "./echo-gate.ts";

// ---------------------------------------------------------------------------
// Pre-roll + hangover ring — capture-side recovery for frames the EchoGate
// would drop on the speech onset / offset boundaries. Pure state machine;
// see audio-pre-roll-ring.ts for the FSM description.
// ---------------------------------------------------------------------------

export { createAudioPreRollRing } from "./audio-pre-roll-ring.ts";
export type { AudioPreRollRing, AudioPreRollRingConfig } from "./audio-pre-roll-ring.ts";

// ---------------------------------------------------------------------------
// Speech gate — client-side mic latch that debounces sustained speech before
// opening the stream, suppressing transient noise / cough / knock.
// ---------------------------------------------------------------------------

export { createSpeechGate } from "./speech-gate.ts";
export type {
  SpeechGate,
  SpeechGateConfig,
  SpeechGateResult,
  SpeechGateState,
} from "./speech-gate.ts";

// ---------------------------------------------------------------------------
// Voice UI types
// ---------------------------------------------------------------------------

export type { VoiceState, VoiceStatus, ChatMessage } from "./voice-types.ts";
