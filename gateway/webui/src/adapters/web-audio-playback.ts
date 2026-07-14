import { type AudioPlaybackAdapter, createLogger } from "@sentient/web-sdk";
import { AUDIO_SAMPLE_RATE, IDLE_SUSPEND_MS, PLAYBACK_GAIN_DESKTOP, PLAYBACK_GAIN_MOBILE } from "../constants.ts";
import { createAudioLoopbackPeer } from "./web-audio-playback-peer.ts";

/**
 * Touch-device detection — same heuristic the composer uses for
 * blur-after-send. iOS Safari + Android Chrome match `(hover: none) and
 * (pointer: coarse)`. Used here to pick the gainNode's initial value, since
 * mobile WebAudio output is consistently quieter than desktop at unity
 * gain. Ignored in non-browser runtimes (tests).
 */
function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches
  );
}

/**
 * Extended playback adapter that supports fade-out before clear, plus the
 * web-specific AEC-routing + gesture-unlock affordances.
 */
export interface FadeablePlaybackAdapter extends AudioPlaybackAdapter {
  fadeOutAndClear(durationMs: number): Promise<void>;
  /**
   * Toggle the WebRTC loopback that routes TTS through the browser's AEC
   * engine. When `false` (default), audio goes straight to
   * `audioContext.destination` — no PC overhead, no extra audio session
   * claim. When `true`, the loopback is brought up so getUserMedia AEC
   * can subtract TTS from mic. Call with `true` on voice-mode start, `false`
   * on stop.
   */
  setAecEnabled(on: boolean): void;
  /**
   * Synchronously resume the AudioContext. Must be called inside a user
   * gesture handler on iOS Safari to unlock audio for the rest of the page.
   */
  unlock(): void;
}

/** One audio frame at 44.1kHz ≈ 23ms — drain debounce window. */
const DRAIN_DEBOUNCE_MS = 23;

/**
 * Initial jitter-buffer headroom — schedule the very first frame of a
 * playback session this many ms in the future. Absorbs sub-INITIAL_BUFFER_MS
 * local-tts stream jitter without stuttering.
 */
const INITIAL_BUFFER_MS = 250;

const log = createLogger(["sentient", "webui", "audio-playback"]);

export interface WebAudioPlaybackOptions {
  sampleRate?: number;
}

export function createWebAudioPlayback(options?: WebAudioPlaybackOptions): FadeablePlaybackAdapter {
  const sampleRate = options?.sampleRate ?? AUDIO_SAMPLE_RATE;
  const peer = createAudioLoopbackPeer();

  let audioContext: AudioContext | null = null;
  let destinationNode: MediaStreamAudioDestinationNode | null = null;
  let gainNode: GainNode | null = null;
  let aecEnabled = false;
  let peerReady = false;
  let generation = 0;
  let isPlaying = false;
  let nextStartTime = 0;
  let pendingSourceCount = 0;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSuspendTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Frames whose scheduling was deferred because the AudioContext was not
   * yet `running` at enqueue time, OR (in AEC mode) the loopback peer is
   * not yet wired. Drained by `flushPreResume` when both conditions clear.
   */
  let preResumeBuffer: Float32Array[] = [];

  const stateHandlers = new Set<(playing: boolean) => void>();
  const drainHandlers = new Set<() => void>();

  function notifyState(playing: boolean): void {
    if (isPlaying === playing) return;
    isPlaying = playing;
    log.debug("state-change", { playing });
    for (const h of stateHandlers) h(playing);
  }

  function cancelDrainTimer(): void {
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
  }

  function cancelIdleSuspendTimer(): void {
    if (idleSuspendTimer !== null) {
      clearTimeout(idleSuspendTimer);
      idleSuspendTimer = null;
    }
  }

  /**
   * Suspend the AudioContext to let the audio hardware power down between
   * utterances. The AEC peer stays alive for fast resume (~5ms). On iOS
   * Safari the audio session stays claimed while the AC is `running` —
   * suspending releases the hardware claim, reducing heat and battery drain.
   */
  function suspendForUtterance(): void {
    if (!audioContext) return;
    if (audioContext.state !== "running") return;
    log.info("utterance-suspend: suspending AC between utterances", { aecEnabled, peerReady });
    audioContext.suspend().catch((err) => {
      log.debug("utterance-suspend: AC.suspend rejected", { err: (err as Error)?.message ?? err });
    });
  }

  /**
   * Tear down the AEC loopback peer after extended idle. The peer holds a
   * WebRTC connection and hidden <audio> element — releasing those resources
   * during long pauses saves battery. The peer is rebuilt on next enqueue if
   * AEC is enabled.
   */
  function teardownPeerForIdle(): void {
    if (!peerReady) return;
    log.info("idle-teardown: destroying AEC peer", { aecEnabled });
    peer.destroy();
    peerReady = false;
  }

  function scheduleIdleSuspend(): void {
    cancelIdleSuspendTimer();
    idleSuspendTimer = setTimeout(() => {
      idleSuspendTimer = null;
      teardownPeerForIdle();
    }, IDLE_SUSPEND_MS);
  }

  function scheduleDrain(): void {
    cancelDrainTimer();
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (pendingSourceCount > 0) return;
      log.debug("drain: all sources ended, firing onDrain handlers", {
        handlerCount: drainHandlers.size,
      });
      notifyState(false);
      for (const h of drainHandlers) h();
      // Suspend AC immediately so the audio hardware can power down between
      // utterances. The peer stays alive for fast resume on next enqueue.
      suspendForUtterance();
      // Schedule deep-idle peer teardown for extended silence.
      scheduleIdleSuspend();
    }, DRAIN_DEBOUNCE_MS);
  }

  function onSourceEnded(g: number): void {
    if (g !== generation) {
      log.debug("source-ended-stale", { reason: "post-clear" });
      return;
    }
    pendingSourceCount = Math.max(0, pendingSourceCount - 1);
    log.debug("source-ended", { pendingSourceCount });
    if (pendingSourceCount === 0) {
      scheduleDrain();
    }
  }

  /** Wire gainNode to whichever sink matches the current AEC mode. */
  function connectGainSink(): void {
    if (!audioContext || !gainNode) return;
    gainNode.disconnect();
    if (aecEnabled) {
      if (!destinationNode) {
        destinationNode = audioContext.createMediaStreamDestination();
      }
      gainNode.connect(destinationNode);
    } else {
      gainNode.connect(audioContext.destination);
    }
  }

  function buildGainNode(): void {
    if (!audioContext) return;
    gainNode = audioContext.createGain();
    const initialGain = isTouchDevice() ? PLAYBACK_GAIN_MOBILE : PLAYBACK_GAIN_DESKTOP;
    gainNode.gain.setValueAtTime(initialGain, audioContext.currentTime);
    log.debug("buildGainNode: initial gain", { gain: initialGain });
    connectGainSink();
  }

  /** Play 50ms of silence to warm the active route (eliminates cold-start jitter). */
  function warmPipeline(): void {
    if (!audioContext || !gainNode) return;
    const silentBuffer = audioContext.createBuffer(1, sampleRate * 0.05, sampleRate);
    const source = audioContext.createBufferSource();
    source.buffer = silentBuffer;
    source.connect(gainNode);
    source.start();
  }

  /**
   * Bring up the AEC loopback peer if missing. Async; flushPreResume awaits
   * the result by checking `peerReady` before scheduling.
   */
  function ensurePeerReady(): void {
    if (!aecEnabled || peerReady) return;
    if (!audioContext || !destinationNode) return;
    peer
      .setup(destinationNode)
      .then(() => {
        peerReady = true;
        warmPipeline();
        flushPreResume();
      })
      .catch((err) => {
        log.error("ensurePeerReady: peer.setup failed", { err });
      });
  }

  function isReadyToSchedule(): boolean {
    if (!audioContext || audioContext.state !== "running") return false;
    if (aecEnabled && !peerReady) return false;
    return true;
  }

  function flushPreResume(): void {
    if (preResumeBuffer.length === 0) return;
    if (!isReadyToSchedule()) return;
    log.debug("flushPreResume", { count: preResumeBuffer.length });
    const drained = preResumeBuffer;
    preResumeBuffer = [];
    for (const s of drained) scheduleSource(s);
  }

  function attachStateChangeListener(ctx: AudioContext): void {
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "running") flushPreResume();
    });
  }

  function scheduleSource(samples: Float32Array): void {
    if (!audioContext || !gainNode || samples.length === 0) return;
    const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);

    const now = audioContext.currentTime;
    const isInitialFrame = nextStartTime === 0;
    const earliestStart = isInitialFrame ? now + INITIAL_BUFFER_MS / 1000 : now;
    const startTime = Math.max(earliestStart, nextStartTime);
    source.start(startTime);
    nextStartTime = startTime + buffer.duration;

    pendingSourceCount++;
    cancelDrainTimer();
    cancelIdleSuspendTimer();
    log.debug("source-scheduled", {
      samples: samples.length,
      startTime: startTime.toFixed(3),
      nextStartTime: nextStartTime.toFixed(3),
      pendingSourceCount,
      isInitialFrame,
      bufferAheadMs: Math.max(0, (nextStartTime - now) * 1000).toFixed(0),
    });

    const g = generation;
    source.onended = () => onSourceEnded(g);
    notifyState(true);
  }

  return {
    async init() {
      log.info("init: ENTER (AC creation deferred until first user gesture)");
      if (typeof RTCPeerConnection === "undefined") {
        log.warn("init: WebRTC not supported — AEC mode will be unavailable");
      }
      // iOS Safari requires the AudioContext to be CREATED inside a user
      // gesture, not just resumed. Creating on mount yields a context that
      // looks "running" after gesture-resume but routes audio to nowhere
      // and never fires `onended`. We defer to the first unlock() call,
      // which is wired ONLY to TTS-expecting actions in use-voice-client
      // (`sendText`, `startVoiceMode`). Both run inside `click` event
      // handlers — the only DOM events that grant transient activation on
      // iOS. Frames that arrive before unlock are buffered.
      return true;
    },

    enqueue(samples: Float32Array) {
      // Pre-unlock: no AudioContext yet. Buffer the frame; the next
      // TTS-expecting gesture's unlock() will create the AC and flush.
      if (!audioContext || !gainNode) {
        log.debug("enqueue: pre-unlock — buffering until first gesture", {
          bufferedFrames: preResumeBuffer.length + 1,
        });
        preResumeBuffer.push(samples);
        return;
      }
      cancelIdleSuspendTimer();

      // AC was idle-suspended (or never gesture-resumed). Buffer + kick
      // resume; the statechange listener will flush. Don't claim "playing"
      // until a source actually starts — the UI must reflect real audio.
      if (audioContext.state !== "running") {
        log.debug("enqueue: context not running — buffering", {
          state: audioContext.state,
          bufferedFrames: preResumeBuffer.length + 1,
        });
        preResumeBuffer.push(samples);
        audioContext.resume().catch((err) => {
          log.debug("enqueue: resume rejected (will retry on next enqueue)", {
            err: (err as Error)?.message ?? err,
          });
        });
        // If idle-suspend tore down the peer, restart it.
        ensurePeerReady();
        return;
      }
      // AEC mode and peer not yet ready (e.g. mid-setup after an AEC toggle):
      // buffer until peer.setup completes.
      if (aecEnabled && !peerReady) {
        log.debug("enqueue: AEC peer not ready — buffering");
        preResumeBuffer.push(samples);
        ensurePeerReady();
        return;
      }
      if (preResumeBuffer.length > 0) flushPreResume();
      log.debug("enqueue: scheduling", {
        samples: samples.length,
        ctxState: audioContext.state,
        ctxTime: audioContext.currentTime.toFixed(3),
        nextStart: nextStartTime.toFixed(3),
      });
      scheduleSource(samples);
    },

    clear() {
      if (!audioContext) return;

      generation += 1;
      log.debug("clear: flushing all scheduled sources and drain state", { generation });

      cancelDrainTimer();
      cancelIdleSuspendTimer();
      pendingSourceCount = 0;
      preResumeBuffer = [];

      // Tear down the loopback peer (if any) so its receiver buffer can't
      // replay already-delivered audio after barge-in.
      if (peerReady) {
        peer.destroy();
        peerReady = false;
      }

      const rate = audioContext.sampleRate;
      audioContext.close().catch(() => {});
      audioContext = new AudioContext({ sampleRate: rate });
      attachStateChangeListener(audioContext);
      destinationNode = null;
      gainNode = null;
      buildGainNode();
      nextStartTime = 0;
      notifyState(false);

      // If AEC was active, bring the peer back for the next cycle.
      if (aecEnabled) {
        ensurePeerReady();
      }
    },

    destroy() {
      cancelDrainTimer();
      cancelIdleSuspendTimer();
      if (peerReady) {
        peer.destroy();
        peerReady = false;
      }
      audioContext?.close().catch(() => {});
      audioContext = null;
      destinationNode = null;
      gainNode = null;
      isPlaying = false;
      nextStartTime = 0;
      pendingSourceCount = 0;
      preResumeBuffer = [];
    },

    async fadeOutAndClear(durationMs: number): Promise<void> {
      if (!audioContext || !gainNode) {
        log.debug("fadeOutAndClear: no context, falling back to clear()");
        this.clear();
        return;
      }
      const gn = gainNode;
      const now = audioContext.currentTime;
      const durationSec = Math.max(0, durationMs) / 1000;

      log.debug("fadeOutAndClear: ramping gain to 0", { durationMs });
      gn.gain.cancelScheduledValues(now);
      gn.gain.setValueAtTime(gn.gain.value, now);
      gn.gain.linearRampToValueAtTime(0, now + durationSec);

      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
      log.debug("fadeOutAndClear: fade complete, calling clear()");
      this.clear();
    },

    setAecEnabled(on: boolean): void {
      if (aecEnabled === on) return;
      log.info("setAecEnabled", { from: aecEnabled, to: on });
      aecEnabled = on;
      if (!audioContext || !gainNode) return; // pre-init — flag remembered for init time

      if (on) {
        if (!destinationNode) {
          destinationNode = audioContext.createMediaStreamDestination();
        }
        connectGainSink();
        ensurePeerReady();
      } else {
        if (peerReady) {
          peer.destroy();
          peerReady = false;
        }
        connectGainSink();
      }
    },

    unlock(): void {
      // Caller MUST be a TTS-expecting onClick handler (`sendText`,
      // `startVoiceMode`). iOS Safari refuses to route audio through a
      // context constructed outside an activation-granting event, and once
      // a context is ghosted that way it cannot be revived by a later
      // resume(). Calling unlock() from any non-`click` path (passive
      // touchstart, document-wide listeners) corrupts the context for the
      // session — see use-voice-client header for the rule.
      if (!audioContext) {
        try {
          audioContext = new AudioContext({ sampleRate });
          attachStateChangeListener(audioContext);
          destinationNode = null;
          buildGainNode();
          // If voice mode was toggled on before unlock, peer needs to come up too.
          if (aecEnabled) ensurePeerReady();
          log.info("unlock: AudioContext created in gesture", {
            state: audioContext.state,
            aecEnabled,
            bufferedFrames: preResumeBuffer.length,
          });
          // AC may already be "running" on creation in a gesture stack —
          // flush whatever buffered up before the gesture.
          flushPreResume();
        } catch (err) {
          log.error("unlock: AC creation failed", { err });
          return;
        }
      }
      if (audioContext.state !== "running") {
        // Sync inside gesture — resolution is async but the call itself
        // is what unlocks iOS audio.
        audioContext.resume().catch((err) => {
          log.debug("unlock: resume rejected", { err: (err as Error)?.message ?? err });
        });
      }
    },

    onStateChange(handler) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },

    onDrain(handler) {
      drainHandlers.add(handler);
      return () => drainHandlers.delete(handler);
    },
  };
}
