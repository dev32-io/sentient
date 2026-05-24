import { describe, it, expect } from "bun:test";
import {
  EnergyVadDetector,
  BandpassEnergyVadDetector,
  MockMlVadDetector,
  computeRMS,
  type VadDetector,
  type VadDetectorEvent,
} from "./vad-detector";
import {
  silence,
  noise,
  tone,
  speechLike,
  coughBurst,
  lowFreqRumble,
  scenarioSimpleSpeech,
  scenarioCoughFalseAlarm,
  scenarioSpeechOverNoise,
  scenarioMidSentencePause,
  scenarioDoubleUtterance,
  scenarioLowFreqInterference,
  scenarioWhisper,
} from "./synthetic-audio";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Feed all batches through detector, return all events */
function feedScenario(
  detector: VadDetector,
  batches: Float32Array[]
): VadDetectorEvent[] {
  const events: VadDetectorEvent[] = [];
  for (const batch of batches) {
    events.push(...detector.processBatch(batch));
  }
  return events;
}

/** Extract speech boundary events (start/end) from all events */
function speechEvents(events: VadDetectorEvent[]) {
  return events.filter(
    (e) => e.type === "speech_start" || e.type === "speech_end"
  );
}

/** Count how many speech_start events occurred */
function countStarts(events: VadDetectorEvent[]): number {
  return events.filter((e) => e.type === "speech_start").length;
}

/** Count how many speech_end events occurred */
function countEnds(events: VadDetectorEvent[]): number {
  return events.filter((e) => e.type === "speech_end").length;
}

// ─── 1. computeRMS — Pure Function Tests ─────────────────────────────

describe("computeRMS", () => {
  it("returns 0 for silence", () => {
    expect(computeRMS(silence())).toBe(0);
  });

  it("returns 0 for empty buffer", () => {
    expect(computeRMS(new Float32Array(0))).toBe(0);
  });

  it("returns amplitude/sqrt(2) for a sine wave", () => {
    const amplitude = 0.5;
    // Use enough samples for accurate RMS (full periods)
    const samples = tone(440, amplitude, 0, 48000, 48000);
    const rms = computeRMS(samples);
    const expected = amplitude / Math.SQRT2;
    expect(Math.abs(rms - expected)).toBeLessThan(0.001);
  });

  it("returns amplitude for DC offset", () => {
    const dc = new Float32Array(512).fill(0.3);
    expect(computeRMS(dc)).toBeCloseTo(0.3, 5);
  });

  it("scales linearly with amplitude", () => {
    const rms1 = computeRMS(tone(440, 0.1, 0, 48000, 4800));
    const rms2 = computeRMS(tone(440, 0.5, 0, 48000, 4800));
    expect(rms2 / rms1).toBeCloseTo(5, 1);
  });
});

// ─── 2. EnergyVadDetector — Unit Tests ───────────────────────────────

describe("EnergyVadDetector", () => {
  function createDetector(overrides = {}) {
    return new EnergyVadDetector({
      energyThreshold: 0.01,
      silenceTimeoutMs: 700,
      minSpeechDurationMs: 32,
      sampleRate: 48000,
      batchSize: 512,
      ...overrides,
    });
  }

  it("starts not speaking", () => {
    const d = createDetector();
    expect(d.isSpeaking).toBe(false);
  });

  it("stays silent on silence input", () => {
    const d = createDetector();
    const events = feedScenario(d, Array(20).fill(silence()));
    expect(countStarts(events)).toBe(0);
    expect(d.isSpeaking).toBe(false);
  });

  it("emits energy events for every batch", () => {
    const d = createDetector();
    const events = d.processBatch(silence());
    const energyEvents = events.filter((e) => e.type === "energy");
    expect(energyEvents.length).toBe(1);
    expect(energyEvents[0].type === "energy" && energyEvents[0].rms).toBe(0);
  });

  it("detects speech onset after debounce frames", () => {
    const d = createDetector({ minSpeechDurationMs: 32 });
    // batchDuration = 512/48000 * 1000 = 10.67ms
    // onsetFrames = ceil(32 / 10.67) = 3

    // Frame 1: high energy, no speech_start yet
    let events = d.processBatch(speechLike(0.3));
    expect(countStarts(events)).toBe(0);

    // Frame 2: still debouncing
    events = d.processBatch(speechLike(0.3));
    expect(countStarts(events)).toBe(0);

    // Frame 3: debounce complete → speech_start
    events = d.processBatch(speechLike(0.3));
    expect(countStarts(events)).toBe(1);
    expect(d.isSpeaking).toBe(true);
  });

  it("does NOT trigger on single cough burst", () => {
    const d = createDetector({ minSpeechDurationMs: 32 });
    // One high-energy frame, then silence
    let events = d.processBatch(coughBurst(0.5));
    const startsBefore = countStarts(events);

    events = d.processBatch(silence());
    const startsAfter = countStarts(events);

    expect(startsBefore + startsAfter).toBe(0);
    expect(d.isSpeaking).toBe(false);
  });

  it("detects speech end after silence timeout", () => {
    const d = createDetector({ silenceTimeoutMs: 700 });
    // offsetFrames = ceil(700 / 10.67) = 66

    // Start speech (3 frames for onset)
    feedScenario(d, Array(5).fill(speechLike(0.3)));
    expect(d.isSpeaking).toBe(true);

    // Feed 65 silence frames — not enough for offset
    feedScenario(d, Array(65).fill(silence()));
    expect(d.isSpeaking).toBe(true);

    // One more silence frame → offset triggered
    const events = d.processBatch(silence());
    expect(countEnds(events)).toBe(1);
    expect(d.isSpeaking).toBe(false);
  });

  it("reset clears all state", () => {
    const d = createDetector();
    // Get into speaking state
    feedScenario(d, Array(5).fill(speechLike(0.3)));
    expect(d.isSpeaking).toBe(true);

    d.reset();
    expect(d.isSpeaking).toBe(false);

    // Should need onset debounce again
    const events = d.processBatch(speechLike(0.3));
    expect(countStarts(events)).toBe(0);
  });

  it("does not double-fire speech_start", () => {
    const d = createDetector();
    const allEvents = feedScenario(d, Array(20).fill(speechLike(0.3)));
    expect(countStarts(allEvents)).toBe(1);
  });

  it("does not double-fire speech_end", () => {
    const d = createDetector();
    // Start and then end speech
    feedScenario(d, Array(5).fill(speechLike(0.3)));
    const endEvents = feedScenario(d, Array(100).fill(silence()));
    expect(countEnds(endEvents)).toBe(1);
  });
});

// ─── 3. Scenario Tests — Energy VAD ─────────────────────────────────

describe("EnergyVadDetector scenarios", () => {
  function createDetector() {
    return new EnergyVadDetector({
      energyThreshold: 0.01,
      silenceTimeoutMs: 700,
      minSpeechDurationMs: 32,
    });
  }

  it("simple speech: one start, one end", () => {
    const d = createDetector();
    const events = feedScenario(d, scenarioSimpleSpeech());
    const boundaries = speechEvents(events);

    expect(countStarts(boundaries)).toBe(1);
    expect(countEnds(boundaries)).toBe(1);

    // speech_start comes before speech_end
    const startIdx = boundaries.findIndex((e) => e.type === "speech_start");
    const endIdx = boundaries.findIndex((e) => e.type === "speech_end");
    expect(startIdx).toBeLessThan(endIdx);
  });

  it("cough false alarm: no speech events", () => {
    const d = createDetector();
    const events = feedScenario(d, scenarioCoughFalseAlarm());
    expect(countStarts(speechEvents(events))).toBe(0);
  });

  it("speech over noise: detects speech despite noise floor", () => {
    const d = createDetector();
    const events = feedScenario(d, scenarioSpeechOverNoise());
    const boundaries = speechEvents(events);
    expect(countStarts(boundaries)).toBe(1);
    expect(countEnds(boundaries)).toBe(1);
  });

  it("mid-sentence pause: no premature speech_end (pause < timeout)", () => {
    const d = createDetector();
    const events = feedScenario(d, scenarioMidSentencePause());
    const boundaries = speechEvents(events);

    // Should get exactly one speech_start and one speech_end
    // (the 318ms pause is < 700ms timeout, so no split)
    expect(countStarts(boundaries)).toBe(1);
    expect(countEnds(boundaries)).toBe(1);
  });

  it("double utterance: two start/end pairs", () => {
    const d = createDetector();
    const events = feedScenario(d, scenarioDoubleUtterance());
    const boundaries = speechEvents(events);

    expect(countStarts(boundaries)).toBe(2);
    expect(countEnds(boundaries)).toBe(2);

    // Verify interleaving: start, end, start, end
    const types = boundaries.map((e) => e.type);
    expect(types).toEqual([
      "speech_start",
      "speech_end",
      "speech_start",
      "speech_end",
    ]);
  });

  it("whisper below threshold: no speech detected", () => {
    const d = createDetector();
    const events = feedScenario(d, scenarioWhisper());
    expect(countStarts(speechEvents(events))).toBe(0);
  });

  it("whisper detected with lower threshold", () => {
    const d = new EnergyVadDetector({
      energyThreshold: 0.001, // lower threshold to catch whisper (RMS ~0.0015)
      silenceTimeoutMs: 700,
      minSpeechDurationMs: 32,
    });
    const events = feedScenario(d, scenarioWhisper());
    expect(countStarts(speechEvents(events))).toBe(1);
  });
});

// ─── 4. Bandpass Filter Tests ────────────────────────────────────────

describe("BandpassEnergyVadDetector", () => {
  function createDetector() {
    return new BandpassEnergyVadDetector({
      energyThreshold: 0.005, // lower threshold since filter attenuates
      silenceTimeoutMs: 700,
      minSpeechDurationMs: 32,
    });
  }

  it("attenuates low-frequency rumble energy vs unfiltered", () => {
    // Verify the bandpass filter reduces low-freq energy significantly
    // The 2nd-order IIR won't fully eliminate 60Hz in a few frames,
    // but after filter warmup, RMS should be much lower than unfiltered
    const filtered = createDetector();
    const unfiltered = new EnergyVadDetector({
      energyThreshold: 0.005,
      silenceTimeoutMs: 700,
      minSpeechDurationMs: 32,
    });

    const batches = scenarioLowFreqInterference();

    const filteredEvents = feedScenario(filtered, batches);
    const unfilteredEvents = feedScenario(unfiltered, batches);

    // Compare energy levels: filtered should have lower RMS than unfiltered
    const filteredEnergy = filteredEvents
      .filter((e): e is Extract<typeof e, { type: "energy" }> => e.type === "energy")
      .map((e) => e.rms);
    const unfilteredEnergy = unfilteredEvents
      .filter((e): e is Extract<typeof e, { type: "energy" }> => e.type === "energy")
      .map((e) => e.rms);

    // After filter warmup (first few frames), filtered energy should be lower
    const filteredAvg =
      filteredEnergy.slice(5).reduce((a, b) => a + b, 0) /
      (filteredEnergy.length - 5);
    const unfilteredAvg =
      unfilteredEnergy.slice(5).reduce((a, b) => a + b, 0) /
      (unfilteredEnergy.length - 5);

    // Bandpass should attenuate 60Hz rumble by at least 50%
    expect(filteredAvg).toBeLessThan(unfilteredAvg * 0.5);
  });

  it("still detects voice-band speech", () => {
    // Use a lower threshold since bandpass attenuates even voice-band signals
    const d = new BandpassEnergyVadDetector({
      energyThreshold: 0.002,
      silenceTimeoutMs: 700,
      minSpeechDurationMs: 32,
    });
    const events = feedScenario(d, scenarioSimpleSpeech());
    const boundaries = speechEvents(events);
    expect(countStarts(boundaries)).toBe(1);
    expect(countEnds(boundaries)).toBe(1);
  });

  it("reset clears filter state", () => {
    const d = createDetector();
    feedScenario(d, Array(5).fill(speechLike(0.3)));
    d.reset();
    expect(d.isSpeaking).toBe(false);
  });
});

// ─── 5. Mock ML VAD Tests ────────────────────────────────────────────

describe("MockMlVadDetector", () => {
  it("triggers based on injected probability function", () => {
    let currentProb = 0;
    const d = new MockMlVadDetector(
      () => currentProb,
      0.5, // threshold
      { minSpeechDurationMs: 32 }
    );

    // Low probability — no trigger
    currentProb = 0.1;
    feedScenario(d, Array(10).fill(silence()));
    expect(d.isSpeaking).toBe(false);

    // High probability — triggers after debounce
    currentProb = 0.9;
    const events = feedScenario(d, Array(5).fill(silence()));
    expect(d.isSpeaking).toBe(true);
    expect(countStarts(speechEvents(events))).toBe(1);
  });

  it("simulates ML correctly classifying cough as non-speech", () => {
    // ML model says: cough burst = 0.2 probability (non-speech)
    // vs energy VAD which can't tell
    let batchIndex = 0;
    const probabilities = [
      // 10 silence frames: 0.01 each
      ...Array(10).fill(0.01),
      // 1 cough frame: energy-based would see high RMS, but ML says 0.2
      0.2,
      // 10 more silence frames
      ...Array(10).fill(0.01),
    ];

    const d = new MockMlVadDetector(
      () => probabilities[batchIndex++] ?? 0,
      0.5,
      { minSpeechDurationMs: 32 }
    );

    const batches = scenarioCoughFalseAlarm();
    const events = feedScenario(d, batches);

    expect(countStarts(speechEvents(events))).toBe(0);
  });

  it("runtime probability update changes behavior", () => {
    let prob = 0;
    const d = new MockMlVadDetector(
      () => prob,
      0.5,
      { minSpeechDurationMs: 10, silenceTimeoutMs: 100 }
    );

    // Start with no speech
    prob = 0.1;
    feedScenario(d, Array(5).fill(silence()));
    expect(d.isSpeaking).toBe(false);

    // Dynamically change to speech
    prob = 0.9;
    feedScenario(d, Array(5).fill(silence()));
    expect(d.isSpeaking).toBe(true);

    // Change back
    prob = 0.1;
    feedScenario(d, Array(20).fill(silence()));
    expect(d.isSpeaking).toBe(false);
  });
});

// ─── 6. Pluggable Interface Contract Tests ───────────────────────────

describe("VadDetector interface contract", () => {
  const detectors: [string, () => VadDetector][] = [
    ["EnergyVadDetector", () => new EnergyVadDetector()],
    ["BandpassEnergyVadDetector", () => new BandpassEnergyVadDetector()],
    [
      "MockMlVadDetector",
      () => new MockMlVadDetector(() => 0, 0.5),
    ],
  ];

  for (const [name, factory] of detectors) {
    describe(name, () => {
      it("starts not speaking", () => {
        expect(factory().isSpeaking).toBe(false);
      });

      it("processBatch returns array of events", () => {
        const d = factory();
        const events = d.processBatch(silence());
        expect(Array.isArray(events)).toBe(true);
      });

      it("every event has a valid type", () => {
        const d = factory();
        const events = d.processBatch(speechLike(0.3));
        for (const e of events) {
          expect(["speech_start", "speech_end", "energy"]).toContain(e.type);
        }
      });

      it("emits at least one energy event per batch", () => {
        const d = factory();
        const events = d.processBatch(silence());
        expect(events.filter((e) => e.type === "energy").length).toBe(1);
      });

      it("reset makes isSpeaking false", () => {
        const d = factory();
        d.reset();
        expect(d.isSpeaking).toBe(false);
      });

      it("never emits speech_end before speech_start", () => {
        const d = factory();
        // Feed 100 batches of random content
        const allEvents: VadDetectorEvent[] = [];
        for (let i = 0; i < 100; i++) {
          const batch = i % 3 === 0 ? speechLike(0.3) : silence();
          allEvents.push(...d.processBatch(batch));
        }

        let speaking = false;
        for (const e of allEvents) {
          if (e.type === "speech_start") {
            expect(speaking).toBe(false); // no double starts
            speaking = true;
          }
          if (e.type === "speech_end") {
            expect(speaking).toBe(true); // must be speaking to end
            speaking = false;
          }
        }
      });
    });
  }
});

// ─── 7. Edge Cases ───────────────────────────────────────────────────

describe("edge cases", () => {
  it("processes empty batch without error", () => {
    const d = new EnergyVadDetector();
    const events = d.processBatch(new Float32Array(0));
    expect(events.length).toBeGreaterThanOrEqual(1); // at least energy event
    expect(d.isSpeaking).toBe(false);
  });

  it("handles very large amplitude (clipping) without crash", () => {
    const d = new EnergyVadDetector();
    const loud = new Float32Array(512).fill(1.0);
    const events = d.processBatch(loud);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("handles NaN samples gracefully", () => {
    const d = new EnergyVadDetector();
    const bad = new Float32Array(512).fill(NaN);
    const events = d.processBatch(bad);
    // Should not crash — RMS will be NaN, treated as not above threshold
    expect(d.isSpeaking).toBe(false);
  });

  it("onset debounce with minSpeechDuration=0 triggers immediately", () => {
    const d = new EnergyVadDetector({
      minSpeechDurationMs: 0,
      energyThreshold: 0.01,
    });
    const events = d.processBatch(speechLike(0.3));
    expect(countStarts(speechEvents(events))).toBe(1);
  });

  it("very short silence timeout triggers quickly", () => {
    const d = new EnergyVadDetector({
      silenceTimeoutMs: 11, // ceil(11/10.67) = 2 batches needed
      minSpeechDurationMs: 0,
    });

    // Start speech
    d.processBatch(speechLike(0.3));
    expect(d.isSpeaking).toBe(true);

    // First silence frame — not yet
    d.processBatch(silence());
    // Second silence frame — triggers offset
    const events = d.processBatch(silence());
    expect(countEnds(speechEvents(events))).toBe(1);
  });

  it("alternating speech/silence at onset boundary resets debounce", () => {
    const d = new EnergyVadDetector({
      minSpeechDurationMs: 32, // needs 3 consecutive frames
    });

    // Two high, one low, two high, one low — never hits 3 consecutive
    for (let cycle = 0; cycle < 5; cycle++) {
      d.processBatch(speechLike(0.3));
      d.processBatch(speechLike(0.3));
      d.processBatch(silence());
    }
    expect(d.isSpeaking).toBe(false);
  });
});

// ─── 8. Timing / Latency Budget ──────────────────────────────────────

describe("performance", () => {
  it("processes 1000 batches in under 50ms", () => {
    const d = new EnergyVadDetector();
    const batch = speechLike(0.3);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      d.processBatch(batch);
    }
    const elapsed = performance.now() - start;

    // 1000 batches × 10.6ms = 10.6 seconds of audio in < 50ms
    expect(elapsed).toBeLessThan(50);
  });

  it("bandpass filter processes 1000 batches in under 100ms", () => {
    const d = new BandpassEnergyVadDetector();
    const batch = speechLike(0.3);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      d.processBatch(batch);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});
