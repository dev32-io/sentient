package io.sentient.mobilesdk.voice.talk

/**
 * The mobile talk-mode FSM (design spec §3), owned by [TalkModeController]. Three states,
 * flat + exhaustive so it maps cleanly to a Swift enum (coroutines-flow-surface rule):
 *
 *  - [Idle]       — no capture. Media playback arms on demand when proactive TTS arrives.
 *  - [Hold]       — hold-to-talk (manual turn). Mic capture ON; downlink TTS is DEFERRED
 *                   (buffered, never armed) until the hold ends.
 *  - [Continuous] — toggle-to-talk (semantic turn). Full-duplex VPIO + AEC — today's path.
 *
 * Maps from the UI gesture: `.hold` ⇒ [Hold], `.locked` ⇒ [Continuous], `.idle` ⇒ [Idle].
 * The gesture layer only translates gestures → intents; ALL semantics live in the controller.
 */
enum class TalkMode { Idle, Hold, Continuous }
