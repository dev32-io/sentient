/** WebSocket reconnect timing */
export const WS_RECONNECT_BASE_MS = 1_000;
export const WS_RECONNECT_MAX_MS = 30_000;
export const WS_RECONNECT_JITTER_MS = 500;

/**
 * Audio capture sample rate. 48 kHz is the browser/hardware-native rate;
 * AudioContext + getUserMedia + WebRTC AEC are tuned around it. Forcing
 * 16 kHz here broke AEC and produced silent mic frames (W2 regression).
 * The opus encoder runs at this rate; server-side libopus.Decoder(fs=16000)
 * resamples 48k→16k on decode (standard libopus path, negligible CPU per
 * Xiph). STT pipeline (Silero/Smart-Turn/SenseVoice) stays hardcoded 16k.
 */
export const CAPTURE_SAMPLE_RATE = 48_000;

/**
 * Mic gain boost. 1.0 = no boost — send at NATURAL device level so the browser
 * and mobile clients arrive at comparable loudness and one server-side rms floor
 * fits all (no per-client calibration, no server volume normalizer). A boost >1
 * also clips at the worklet's [-1,1] clamp AND amplifies noise, so keep it at 1.
 */
export const CAPTURE_GAIN = 1.0;

/**
 * Bypass RNNoise denoising (keep its speech-prob for the gate, send RAW audio to
 * Whisper). 2025 research says denoise-before-Whisper can hurt WER — BUT here
 * RNNoise also serves as the second-pass echo suppressor for TTS leak the
 * getUserMedia AEC misses. Bypassing it re-introduced echo (assistant speech
 * transcribed as a user turn). Kept OFF until echo is handled by AEC alone; the
 * toggle stays for when that's fixed.
 */
export const DENOISE_BYPASS = false;

/**
 * Opus encoder bitrate (bps) for mic uplink. Speech sits in the 16-32 kbps
 * range; 24 kbps balances intelligibility and bandwidth for STT input.
 */
export const OPUS_UPLINK_BITRATE_BPS = 24_000;

/** Audio playback sample rate. local-tts emits OGG-Opus @ 48k; the opus decoder downsamples to this rate. */
export const AUDIO_SAMPLE_RATE = 44_100;

/**
 * Playback gain (multiplier on the AudioContext gainNode). Desktop sounds
 * fine at unity (1.0). iOS Safari's WebAudio output is well-known to be
 * roughly 50% the loudness of HTMLAudioElement playback at the same system
 * volume, and Android Chrome shows a milder version of the same effect.
 * The right long-term fix is to route TTS through a hidden `<audio>` sink
 * fed by a MediaStreamAudioDestinationNode (uses the platform media-volume
 * path); until then this multiplier compensates on touch devices. Tunable
 * to taste — push higher only if you also confirm no clipping at peak.
 */
export const PLAYBACK_GAIN_DESKTOP = 1.0;
export const PLAYBACK_GAIN_MOBILE = 2.0;

/**
 * Ms after the playback drains before we tear down the AEC loopback peer
 * (if active). The AC is suspended immediately on drain (no timer) to let
 * the audio hardware power down between utterances. The peer holds a WebRTC
 * connection and hidden <audio> element; tearing it down releases those
 * resources during extended idle. Re-armed automatically on the next enqueue,
 * which rebuilds the peer if AEC is enabled.
 */
export const IDLE_SUSPEND_MS = 30_000;

/** AudioWorklet playback ring buffer (used by ring-buffer.ts for testing). */
export const RING_BUFFER_BYTES = 88_200 * 4; // 2s @ 44.1kHz mono float32 = 352,800 bytes
export const RING_BUFFER_SAMPLES = RING_BUFFER_BYTES / 4; // 88,200 samples

/** Auth */
export const AUTH_TOKEN_PARAM = "token";
export const AUTH_TIMEOUT_MS = 10_000;
export const AUTH_STORAGE_KEY = "sentient:auth";

/** Ping/keepalive */
export const PING_INTERVAL_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;

/** UI */
export const MAX_VISIBLE_MESSAGES = 200;
export const SCROLL_THRESHOLD_PX = 100;

/**
 * Memory editor caps — must match Hermes upstream defaults
 * (gateway/src/profile-store/memory-constants.ts mirrors these). The
 * hermes-config.yaml.tmpl writes the same numbers; raising here without
 * raising upstream would let the user write past what Hermes' agent
 * pruner expects to keep.
 */
export const MEMORY_MD_CHAR_LIMIT = 2200;
export const USER_MD_CHAR_LIMIT = 1375;

/**
 * Maximum time the Interrupt button stays visible after the gateway reports
 * `turn.completed` but before audio playback has started. Covers text-only
 * replies (no TTS) where we'd otherwise linger forever waiting for audio.
 */
export const AWAITING_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Client presence contract (see docs/superpowers/plans/client-presence-contract)
//
// After this much untouched inactivity the web client closes its WebSocket
// with code 1000 "idle-timeout". The SDK's PresenceCoordinator reopens the
// socket on presence return (visibility/focus/pointer/key). Composed with the
// gateway's ~30-min PersonSession archive, total memory window is ~1.5h.
//
// Active playback, active turns, and `sdk.demandStay()` suppress the close;
// see `shared/web-sdk/src/presence/idle-detector.ts` for the suppression set.
// ---------------------------------------------------------------------------

/** Ms of client inactivity before the SDK closes the WebSocket (plan: 1 hr). */
export const IDLE_THRESHOLD_MS = 60 * 60 * 1_000;
/** How often the presence source polls for idle — 30s is fine for an hour-scale threshold. */
export const IDLE_TICK_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Client-side echo gate (see @sentient/web-sdk/echo-gate.ts).
//
// The browser owns the authoritative "assistant is speaking" signal because
// it schedules every TTS frame into WebAudio and sees the real drain event
// from the loopback pipeline. The gate ramps a mic energy threshold so
// residual TTS echo doesn't cross into STT as phantom user speech.
// ---------------------------------------------------------------------------

/** RMS (0..1) above which a mic frame is considered real speech when no TTS is active. */
export const ECHO_GATE_BASELINE_THRESHOLD = 0.03;
/** RMS (0..1) above which a mic frame is considered real speech while TTS is playing. */
export const ECHO_GATE_PLAYBACK_THRESHOLD = 0.2;
/** Ms to hold the elevated threshold after the playback adapter drains. Covers DAC + WebRTC loopback + speaker tail. */
export const ECHO_GATE_TAIL_HOLD_MS = 800;

// ---------------------------------------------------------------------------
// RNNoise speech-prob gate (see audio/rnnoise-denoiser.ts).
//
// RNNoise emits a per-frame [0, 1] speech probability. Frames below the
// cutoff are dropped client-side — they never reach the opus encoder, the
// WS, or server-side STT. This replaces the legacy energy-only check that
// EchoGate.acceptFrame() used to perform: RNNoise's neural classifier
// rejects "fridge hum at 0.04 RMS" while still accepting "soft speech at
// 0.04 RMS", which the dumb RMS threshold can't distinguish.
//
// Dual-threshold matches the EchoGate pattern: when TTS is playing (or in
// the post-drain tail), residual TTS leak through the AEC + speaker can
// register non-trivial speech_prob, so we require a higher cutoff to
// avoid phantom barge-in. Tunable per N5 smoke results.
// ---------------------------------------------------------------------------

/**
 * RNNoise speech probability cutoff when no TTS is playing (gate state
 * `baseline`). Frames at or above this prob are treated as real speech;
 * below this they are dropped. 0.6 matches Jitsi's `VAD_AVG_THRESHOLD`
 * in lib-jitsi-meet's `VADTalkMutedDetection.ts` — the production-tested
 * threshold for "is the user actually talking?". Real speech peaks
 * 0.7-0.99 and easily clears; borderline transients (breath, cough,
 * mumble, hum) typically sit 0.2-0.5 and get rejected. Combined with the
 * 1500 ms post-speech hold below, brief speech bursts keep the gate open
 * through trailing-silence so Silero VAD sees the speech→silence
 * transition.
 *
 * Tuning history:
 *   0.5 — RNNoise stated midpoint, dropped legit speech at 0.47 in smoke
 *   0.3 — caught weak mumbles, false "yeah"/"okay" transcripts
 *   0.4 — still too sensitive; borderline ambient slipped through
 *   0.6 — Jitsi production value (current)
 */
export const RNNOISE_BASELINE_SPEECH_PROB = 0.6;
/**
 * RNNoise speech probability cutoff while TTS is playing or the gate is in
 * tail-hold (states `playback` / `tail`). Matches Jitsi's `VAD_VOICE_LEVEL`
 * (0.9) — only a clear, full-confidence speech signal should interrupt
 * the assistant during TTS. Suppresses phantom barge-in from residual
 * TTS leak through the AEC + speaker tail. Quiet user speech during
 * playback is intentionally dropped.
 */
export const RNNOISE_PLAYBACK_SPEECH_PROB = 0.85;

// SpeechGate latch (client mic gate). Opens only after speech is sustained
// for SPEECH_GATE_OPEN_DEBOUNCE_MS, so short transients (coughs, keyboard
// knocks) never open it. One-word commands ("no"/"yes"/"stop") survive
// because the debounce-window frames are buffered in the composed
// AudioPreRollRing and flushed on open. Research range 200–300ms; 200
// catches fast one-word commands while rejecting sub-200ms noise.
export const SPEECH_GATE_OPEN_DEBOUNCE_MS = 200;
// RNNoise emits one frame per 10ms @ 48kHz (480 samples) — fixed by the model.
export const SPEECH_GATE_FRAME_MS = 10;
// Consecutive sub-threshold frames tolerated before the sustain counter
// resets, so a brief RNNoise probability flicker doesn't drop a real utterance.
export const SPEECH_GATE_GAP_TOLERANCE_FRAMES = 3;
// Pre-roll frames the composed ring retains. MUST exceed the debounce window
// (SPEECH_GATE_OPEN_DEBOUNCE_MS / SPEECH_GATE_FRAME_MS = 20) so the onset
// buffered during the debounce is flushed intact on open. 24 ≈ 240ms.
export const SPEECH_GATE_PREROLL_FRAMES = 24;
// Failsafe: if connector.transcript.final never arrives (server hiccup),
// force the latch closed after this long so it can't stream forever.
export const SPEECH_GATE_MAX_OPEN_MS = 20_000;
