import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebAudioPlayback } from "./web-audio-playback.ts";

// ---------------------------------------------------------------------------
// AudioBufferSource mock — captures onended so tests can trigger it manually
// ---------------------------------------------------------------------------

interface MockSource {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  triggerEnded: () => void;
}

function makeMockSource(): MockSource {
  const src: MockSource = {
    buffer: null,
    onended: null,
    connect: vi.fn(),
    start: vi.fn(),
    triggerEnded() {
      src.onended?.();
    },
  };
  return src;
}

// ---------------------------------------------------------------------------
// AudioContext + AudioBuffer mocks
// ---------------------------------------------------------------------------

function makeMockAudioBuffer(length: number): AudioBuffer {
  return {
    length,
    duration: length / 44100,
    sampleRate: 44100,
    numberOfChannels: 1,
    copyToChannel: vi.fn(),
    getChannelData: vi.fn(() => new Float32Array(length)),
    copyFromChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function makeMockDestination(stream: MediaStream): MediaStreamAudioDestinationNode {
  return {
    stream,
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as MediaStreamAudioDestinationNode;
}

// ---------------------------------------------------------------------------
// RTCPeerConnection mock — minimal stub to avoid JSDOM errors
// ---------------------------------------------------------------------------

function makeMockPeer() {
  return {
    onicecandidate: null as ((e: RTCPeerConnectionIceEvent) => void) | null,
    ontrack: null as ((e: RTCTrackEvent) => void) | null,
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    addTrack: vi.fn().mockReturnValue({ replaceTrack: vi.fn().mockResolvedValue(undefined) }),
    createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "" }),
    createAnswer: vi.fn().mockResolvedValue({ type: "answer", sdp: "" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    getReceivers: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let createdSources: MockSource[] = [];
function makeMockGainNode() {
  return {
    gain: {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as GainNode;
}

type StateChangeListener = () => void;

let mockAudioContext: {
  state: string;
  currentTime: number;
  sampleRate: number;
  close: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  createMediaStreamDestination: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  /** Test helper: simulate a `statechange` event. */
  fireStateChange: () => void;
};

beforeEach(() => {
  createdSources = [];

  const mockStream = {
    getAudioTracks: vi.fn().mockReturnValue([{ kind: "audio" }]),
  } as unknown as MediaStream;

  const stateChangeListeners: StateChangeListener[] = [];
  mockAudioContext = {
    state: "running",
    currentTime: 0,
    sampleRate: 44100,
    close: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    createBuffer: vi.fn((_channels: number, length: number, _rate: number) => makeMockAudioBuffer(length)),
    createBufferSource: vi.fn(() => {
      const src = makeMockSource();
      createdSources.push(src);
      return src;
    }),
    createMediaStreamDestination: vi.fn(() => makeMockDestination(mockStream)),
    createGain: vi.fn(() => makeMockGainNode()),
    addEventListener: vi.fn((evt: string, fn: StateChangeListener) => {
      if (evt === "statechange") stateChangeListeners.push(fn);
    }),
    removeEventListener: vi.fn(),
    fireStateChange: () => {
      for (const fn of stateChangeListeners) fn();
    },
  };

  vi.stubGlobal(
    "AudioContext",
    vi.fn(() => mockAudioContext),
  );
  vi.stubGlobal(
    "MediaStream",
    vi.fn().mockImplementation(() => ({ getAudioTracks: vi.fn().mockReturnValue([]) })),
  );
  vi.stubGlobal(
    "RTCPeerConnection",
    vi.fn(() => makeMockPeer()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Interface shape tests
// ---------------------------------------------------------------------------

describe("createWebAudioPlayback — interface", () => {
  it("returns an object with the AudioPlaybackAdapter interface", () => {
    const adapter = createWebAudioPlayback();
    expect(typeof adapter.init).toBe("function");
    expect(typeof adapter.enqueue).toBe("function");
    expect(typeof adapter.clear).toBe("function");
    expect(typeof adapter.destroy).toBe("function");
    expect(typeof adapter.onStateChange).toBe("function");
    expect(typeof adapter.onDrain).toBe("function");
  });

  it("onStateChange returns unsubscribe function", () => {
    const adapter = createWebAudioPlayback();
    const unsub = adapter.onStateChange(() => {});
    expect(typeof unsub).toBe("function");
  });

  it("onDrain returns unsubscribe function", () => {
    const adapter = createWebAudioPlayback();
    const unsub = adapter.onDrain(() => {});
    expect(typeof unsub).toBe("function");
  });

  it("onStateChange unsubscribe stops handler receiving events", () => {
    const adapter = createWebAudioPlayback();
    let callCount = 0;
    const unsub = adapter.onStateChange(() => {
      callCount++;
    });
    unsub();
    expect(() => unsub()).not.toThrow();
    expect(callCount).toBe(0);
  });

  it("onStateChange unsubscribe is idempotent", () => {
    const adapter = createWebAudioPlayback();
    const unsub = adapter.onStateChange(() => {});
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });

  it("onDrain unsubscribe is idempotent", () => {
    const adapter = createWebAudioPlayback();
    const unsub = adapter.onDrain(() => {});
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });

  it("accepts custom sampleRate option", () => {
    expect(() => createWebAudioPlayback({ sampleRate: 22050 })).not.toThrow();
  });

  it("multiple adapters are independent instances", () => {
    const a = createWebAudioPlayback();
    const b = createWebAudioPlayback();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Guard tests — safe to call before init
// ---------------------------------------------------------------------------

describe("createWebAudioPlayback — AEC setup lifecycle", () => {
  it("cancels an in-flight setup and waits for it to unwind before creating a replacement pair", async () => {
    let finishOffer: ((offer: RTCSessionDescriptionInit) => void) | undefined;
    const firstLocal = makeMockPeer();
    firstLocal.createOffer = vi.fn(
      () =>
        new Promise<RTCSessionDescriptionInit>((resolve) => {
          finishOffer = resolve;
        }),
    );
    const peers = [firstLocal, makeMockPeer(), makeMockPeer(), makeMockPeer()];
    let peerIndex = 0;
    const PeerConnectionMock = vi.fn(() => peers[peerIndex++]);
    vi.stubGlobal("RTCPeerConnection", PeerConnectionMock);

    const adapter = createWebAudioPlayback();
    adapter.unlock();
    adapter.setAecEnabled(true);
    expect(PeerConnectionMock).toHaveBeenCalledTimes(2);

    adapter.setAecEnabled(false);
    expect(peers[0]?.close).toHaveBeenCalledOnce();
    expect(peers[1]?.close).toHaveBeenCalledOnce();

    adapter.setAecEnabled(true);
    // The cancelled setup still owns its asynchronous continuation. A second
    // pair must not start until that continuation observes cancellation.
    expect(PeerConnectionMock).toHaveBeenCalledTimes(2);

    finishOffer?.({ type: "offer", sdp: "" });
    await vi.waitFor(() => expect(PeerConnectionMock).toHaveBeenCalledTimes(4));
    adapter.destroy();
  });
});

describe("createWebAudioPlayback — pre-init guards", () => {
  it("enqueue does not throw when called before init", () => {
    // No AudioContext mock needed — adapter won't have ctx before init
    vi.unstubAllGlobals(); // remove mocks so audioContext stays null
    const adapter = createWebAudioPlayback();
    expect(() => adapter.enqueue(new Float32Array(512))).not.toThrow();
  });

  it("clear does not throw when called before init", () => {
    vi.unstubAllGlobals();
    const adapter = createWebAudioPlayback();
    expect(() => adapter.clear()).not.toThrow();
  });

  it("destroy does not throw when called before init", () => {
    vi.unstubAllGlobals();
    const adapter = createWebAudioPlayback();
    expect(() => adapter.destroy()).not.toThrow();
  });

  it("destroy does not throw when called multiple times", () => {
    vi.unstubAllGlobals();
    const adapter = createWebAudioPlayback();
    expect(() => {
      adapter.destroy();
      adapter.destroy();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Drain logic tests — core behaviour under Task 1
// ---------------------------------------------------------------------------

describe("createWebAudioPlayback — suspended-context buffering", () => {
  it("does not schedule sources while context is suspended; flushes them on statechange→running", async () => {
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    // Reset the source counter so we ignore the warm-pipeline source created
    // during init().
    const sourcesBeforeSuspend = createdSources.length;
    mockAudioContext.state = "suspended";

    adapter.enqueue(new Float32Array(512));
    adapter.enqueue(new Float32Array(512));
    adapter.enqueue(new Float32Array(512));

    // None of the three frames should have been scheduled — the player MUST
    // wait for the context to reach `running`. iOS Safari leaks
    // pendingSourceCount otherwise (see web-audio-playback.ts header comment).
    expect(createdSources.length).toBe(sourcesBeforeSuspend);
    // resume() should have been requested at least once.
    expect(mockAudioContext.resume).toHaveBeenCalled();

    // Simulate context resume.
    mockAudioContext.state = "running";
    mockAudioContext.fireStateChange();

    // All three buffered frames should now be scheduled in order.
    expect(createdSources.length).toBe(sourcesBeforeSuspend + 3);
  });

  it("does NOT report isPlaying=true while suspended — flag must reflect real playback", async () => {
    // Pre-fix bug: the suspended-context branch fired notifyState(true) so
    // the speaking-wave UI showed even though no audio actually played.
    // On iOS Safari with a locked AudioContext that meant the speaking ring
    // animated while frames silently piled up in preResumeBuffer — UI lied
    // about whether sound was reaching the user.
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    mockAudioContext.state = "suspended";
    let playing = false;
    adapter.onStateChange((p) => {
      playing = p;
    });

    adapter.enqueue(new Float32Array(512));
    expect(playing).toBe(false);
  });
});

describe("createWebAudioPlayback — drain tracking", () => {
  it("isPlaying becomes true after first enqueue", async () => {
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    let playing = false;
    adapter.onStateChange((p) => {
      playing = p;
    });

    adapter.enqueue(new Float32Array(512));
    expect(playing).toBe(true);
  });

  it("isPlaying stays true while multiple sources are still pending", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    const states: boolean[] = [];
    adapter.onStateChange((p) => states.push(p));

    adapter.enqueue(new Float32Array(512));
    adapter.enqueue(new Float32Array(512));
    adapter.enqueue(new Float32Array(512));

    // End only the first source — two still pending. With AEC off (default)
    // there is no warm-pipeline source at index 0, so the first real chunk
    // sits at createdSources[0].
    createdSources[0]?.triggerEnded();
    await vi.runAllTimersAsync();

    // Should not have gone to false yet
    expect(states.filter((s) => s === false)).toHaveLength(0);
  });

  it("onDrain fires only after all enqueued sources have ended", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    let drainCount = 0;
    adapter.onDrain(() => {
      drainCount++;
    });

    adapter.enqueue(new Float32Array(256));
    adapter.enqueue(new Float32Array(256));
    adapter.enqueue(new Float32Array(256));

    // AEC is off by default — no warm-pipeline source. The 3 chunks land
    // at createdSources[0..2].
    const [s1, s2, s3] = createdSources;

    // End first two — drain should NOT fire yet
    s1?.triggerEnded();
    s2?.triggerEnded();
    await vi.runAllTimersAsync();
    expect(drainCount).toBe(0);

    // End the last one — drain fires after debounce
    s3?.triggerEnded();
    await vi.runAllTimersAsync();
    expect(drainCount).toBe(1);
  });

  it("isPlaying becomes false after all sources drained (via onDrain debounce)", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    const states: boolean[] = [];
    adapter.onStateChange((p) => states.push(p));

    adapter.enqueue(new Float32Array(256));
    adapter.enqueue(new Float32Array(256));

    const [s1, s2] = createdSources;
    s1?.triggerEnded();
    s2?.triggerEnded();
    await vi.runAllTimersAsync();

    expect(states).toContain(true); // went to true on first enqueue
    expect(states[states.length - 1]).toBe(false); // ended at false
  });

  it("clear() resets isPlaying to false immediately, without waiting for drain", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    const states: boolean[] = [];
    adapter.onStateChange((p) => states.push(p));

    adapter.enqueue(new Float32Array(512));
    adapter.enqueue(new Float32Array(512));
    expect(states[states.length - 1]).toBe(true);

    // clear() before sources end — should go to false immediately
    adapter.clear();
    expect(states[states.length - 1]).toBe(false);

    // Drain timer should be cancelled — no spurious drain after clear
    let drainFired = false;
    adapter.onDrain(() => {
      drainFired = true;
    });
    await vi.runAllTimersAsync();
    expect(drainFired).toBe(false);
  });

  it("new enqueue during drain debounce cancels the drain", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    let drainCount = 0;
    adapter.onDrain(() => {
      drainCount++;
    });

    adapter.enqueue(new Float32Array(256));
    const [, s1] = createdSources;

    // End the source — debounce timer starts
    s1?.triggerEnded();

    // Enqueue a new chunk before debounce fires — should cancel drain
    adapter.enqueue(new Float32Array(256));

    await vi.runAllTimersAsync();
    // Drain should NOT have fired because a new enqueue arrived
    expect(drainCount).toBe(0);
  });

  it("onDrain does not fire if unsubscribed before it triggers", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    let drainCount = 0;
    const unsub = adapter.onDrain(() => {
      drainCount++;
    });

    adapter.enqueue(new Float32Array(256));
    const [, s1] = createdSources;

    unsub(); // unsubscribe before drain fires
    s1?.triggerEnded();
    await vi.runAllTimersAsync();

    expect(drainCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FadeOutAndClear — ramp gain to 0, then clear
// ---------------------------------------------------------------------------

describe("createWebAudioPlayback — fadeOutAndClear", () => {
  it("ramps gain to 0 over the specified duration and clears", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    const states: boolean[] = [];
    adapter.onStateChange((p) => states.push(p));

    // Enqueue audio so there is scheduled content
    adapter.enqueue(new Float32Array(512));
    adapter.enqueue(new Float32Array(512));
    expect(states[states.length - 1]).toBe(true);

    // Count GainNode creations before fade
    const gainNodeCallCountBefore = mockAudioContext.createGain.mock.calls.length;

    // Start fade-out (30ms) but do NOT await yet
    const durationMs = 30;
    const fadePromise = adapter.fadeOutAndClear(durationMs);

    // Advance timers partially (10ms) — gain ramp should be scheduled but not complete
    await vi.advanceTimersByTimeAsync(10);

    // Verify that linearRampToValueAtTime was called with target 0
    const gainNodeMock = mockAudioContext.createGain.mock.results[0];
    expect(gainNodeMock).toBeDefined();
    const gainNode = gainNodeMock?.value as GainNode;
    const linearRampFn = gainNode.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>;
    expect(linearRampFn).toHaveBeenCalled();

    // Get the last call and verify target is 0
    const calls = linearRampFn.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    expect(lastCall?.[0]).toBe(0); // target value is 0

    // clear() should NOT have been called yet (no new GainNode created)
    const gainNodeCallCountAfterPartial = mockAudioContext.createGain.mock.calls.length;
    expect(gainNodeCallCountAfterPartial).toBe(gainNodeCallCountBefore);

    // Advance the rest of the way (past 30ms total)
    await vi.advanceTimersByTimeAsync(30);

    // Await the fade promise
    await fadePromise;

    // Verify that clear() was called (evidenced by new GainNode creation)
    const gainNodeCallCountAfterClear = mockAudioContext.createGain.mock.calls.length;
    expect(gainNodeCallCountAfterClear).toBeGreaterThan(gainNodeCallCountAfterPartial);

    // Verify isPlaying was flipped to false
    expect(states[states.length - 1]).toBe(false);
  });

  it("fadeOutAndClear resolves immediately if no context", async () => {
    vi.useFakeTimers();
    vi.unstubAllGlobals(); // no mocks, so adapter has no context
    const adapter = createWebAudioPlayback();

    const startTime = Date.now();
    await adapter.fadeOutAndClear(100);
    const elapsed = Date.now() - startTime;

    // Should resolve without timeout (or minimal delay)
    expect(elapsed).toBeLessThan(50);
  });

  it("fadeOutAndClear with 0ms duration fades and clears immediately", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    adapter.enqueue(new Float32Array(512));

    const done = adapter.fadeOutAndClear(0);
    // Even 0ms duration should schedule the setTimeout(0) and then clear
    await vi.runAllTimersAsync();
    await done;

    // Verify clear was invoked
    const gainNodeCallCount = mockAudioContext.createGain.mock.calls.length;
    expect(gainNodeCallCount).toBeGreaterThan(1); // at least one from init, one from clear
  });
});

// ---------------------------------------------------------------------------
// Generation counter — stale onended after clear() must not fire drain
// ---------------------------------------------------------------------------

describe("createWebAudioPlayback — generation counter", () => {
  it("stale onended callbacks after clear() do not fire drain or flip isPlaying", async () => {
    vi.useFakeTimers();
    const adapter = createWebAudioPlayback();
    await adapter.init();
    adapter.unlock();

    let drainCount = 0;
    const states: boolean[] = [];
    adapter.onDrain(() => drainCount++);
    adapter.onStateChange((p) => states.push(p));

    // Schedule 2 real chunks and capture their source handles before clear()
    adapter.enqueue(new Float32Array(256));
    adapter.enqueue(new Float32Array(256));

    // AEC off — no warm-pipeline source. Our 2 chunks sit at indices [0,1].
    const staleS1 = createdSources[0];
    const staleS2 = createdSources[1];

    // clear() increments the generation — these sources are now stale
    adapter.clear();
    expect(states[states.length - 1]).toBe(false); // clear sets state to false

    // Simulate browser firing onended on the old (stale) sources after context close
    staleS1?.triggerEnded();
    staleS2?.triggerEnded();
    await vi.runAllTimersAsync();

    // Drain must NOT have fired — stale onended are discarded
    expect(drainCount).toBe(0);
    // State must remain false — no spurious true→false oscillation
    const postClearStates = states.slice(states.indexOf(false));
    expect(postClearStates.every((s) => s === false)).toBe(true);
  });
});
