# Whisper Hallucination Hardening — super-segment decode + safety-net gate (design)

**Date:** 2026-07-01
**Branch:** `feature/whisper-stt-native` (hardening slice on the same branch — Whisper is not merge-ready until this lands)
**Status:** approved design → implementation planning

## 1. Problem

The native Whisper-STT (`capabilityServices/WhisperSTTService/`) emits phantom transcripts —
canonical Whisper short-audio hallucinations: `"Thank you."`, `"Yeah."`, `"Hmm."`, `"See ya."`,
`"All right."` — on turns the user never spoke. Observed live: three phantom `"Thank you."` turns
(0.6–1.1 s each) plus several other filler phantoms, all single-segment sub-second clips.

**Root cause (research-grounded):**
- Whisper is a 30-second **batch** model built for complete utterances. It hallucinates on
  silence / background noise / short isolated clips (measured 1–80% of segments).
- Our pipeline is **SenseVoice-era**: it decodes each Silero VAD micro-segment **separately**
  (`decode_segments_and_stitch`, N decodes) to place `[pause.N]`. SenseVoice (non-autoregressive)
  returned empty on non-speech; Whisper *fills* short/noise clips with plausible filler.
- The stock guards don't catch it: Whisper's built-in no-speech drop is an **AND**
  (`no_speech_prob > 0.6` **AND** `avg_logprob < −1.0`); a *confident* hallucination like
  `"Thank you"` has high `avg_logprob`, so the AND never fires.

**What research says to do (sources below):** keep VAD (it's mandatory — external Silero is what
every production Whisper system uses; Whisper's internal no-speech signal is a weak post-hoc
byproduct, not a VAD), but (a) give Whisper **whole-utterance context** instead of micro-clips,
and (b) add an explicit **safety-net gate** that reads Whisper's own signals + audio energy.

**Sources:** [whisper_streaming](https://github.com/ufal/whisper_streaming),
[faster-whisper vad_filter](https://github.com/SYSTRAN/faster-whisper),
[Whisper hallucination on silence](https://dev.to/nareshipme/whisper-hallucination-on-silence-why-your-transcript-loops-the-same-phrase-2pg4),
[Non-speech hallucination study (arXiv 2501.11378)](https://arxiv.org/html/2501.11378v1),
[Calm-Whisper (arXiv 2505.12969)](https://arxiv.org/html/2505.12969v1).

## 2. Approach — super-segment decode

Stop decoding per Silero micro-segment. Instead group micro-segments into **super-segments**,
split **only** at pauses ≥ `min_pause_ms` (~2 s), decode each super-segment (context-rich phrase),
gate it, and stitch with `[pause.N]` between super-segments.

Why this shape (vs single-decode + word-timestamps): pauses land **between separate decode calls**,
so a `[pause.N]` boundary **can never land mid-word** — the edge case is designed out, no
word-timestamp alignment / tie-break heuristics needed. Cost is 1 decode per turn in the common
case (0 long pauses), 2–3 only when there are real "thinking" pauses.

### Data flow
```
VAD micro-segments  s0 s1 s2 s3        gaps  g01 g12 g23   (ms, from PauseTracker)
group by min_pause_ms=2000:
  g01=500 (<2s → merge)  g12=2500 (≥2s → SPLIT)  g23=300 (<2s → merge)
  → super0 = concat(s0,s1)      super1 = concat(s2,s3)      pauses = [2500]
decode each super-segment (Whisper, whole phrase):
  super0 → {text, no_speech_prob, avg_logprob}  + rms(super0.audio)
  super1 → {text, no_speech_prob, avg_logprob}  + rms(super1.audio)
gate each (keep/drop) → stitch kept:  "super0 [pause.0] super1"   pauses=[2500]
all dropped → empty text → finalizer emits TurnRejected (no phantom)
```

- **Merging micro-segments within a super-segment:** micro-segments are already speech-only
  (VAD-extracted, padded by `speech_pad_ms`); concatenate back-to-back → continuous speech, no
  long internal silence, Whisper re-joins any mid-word VAD over-splits. No inserted silence needed.
- **Start/end pauses dropped by construction:** super-segments are speech-bounded; leading /
  trailing silence is not *between* two super-segments, so it can never produce a `[pause]`.
- **`pauses[]` on the wire** now contains only the ≥ `min_pause_ms` durations (one per kept
  inter-super-segment boundary), 1:1 with the `[pause.N]` markers. Shorter gaps are merged silently.

## 3. Safety-net gate (still required)

Super-segments fix *context*, but a whole turn can be pure noise (VAD false-fires **and** Smart-Turn
is fooled) — no real speech to contextualize, so Whisper still hallucinates. Gate **each
super-segment**; drop it when ANY of:

1. **`rms < rms_energy_floor`** — near-silence noise. Phrase-agnostic catch (kills `"Yeah"`/`"Hmm"`/
   `"Thank you"`-from-noise regardless of the words). RMS computed on the super-segment audio.
2. **`no_speech_prob > no_speech_threshold` AND `avg_logprob < logprob_threshold`** — Whisper's own
   signal, now actually **read from the result** (we currently ignore it).
3. **normalized(text) ∈ `hallucination_phrases` AND (duration < `hallucination_max_duration_ms`
   OR rms < `rms_energy_floor` × `phrase_energy_multiplier`)** — the confident-hallucination case
   the AND-rule misses, guarded by short/quiet so a *real* clearly-spoken "thank you" survives.

Normalization: lowercase, strip surrounding punctuation/whitespace. If **every** super-segment
drops → stitched text empty → existing content gate emits `TurnRejected` (`reason="hallucination"`).

Diagnostics: log `rms`, `no_speech_prob`, `avg_logprob`, `duration_ms`, `text`, and the drop
`reason` per super-segment (so the floors can be tuned from real logs).

## 4. Files changed

| File | Change |
|------|--------|
| `whisper_mlx.py` | `TranscriptResult` gains `no_speech_prob: float`, `avg_logprob: float`. `transcribe` extracts them from `result["segments"]` — `no_speech_prob = max(seg.no_speech_prob)` (worst), `avg_logprob = min(seg.avg_logprob)` (worst); empty segments → `no_speech_prob=1.0`, `avg_logprob=-10.0` (treat as no-speech). `word_timestamps` stays `False`. Keep `emotion`/`event=""` for wire-compat. |
| `super_segment.py` (new) | `group_super_segments(segments: list[np.ndarray], gaps_ms: list[int], min_pause_ms: int) -> tuple[list[np.ndarray], list[int]]` — returns (super-segment audios, pause durations between them). Pure function. |
| `hallucination_gate.py` (new) | `evaluate(text: str, *, rms: float, no_speech_prob: float, avg_logprob: float, duration_ms: float, cfg: WhisperConfig) -> GateResult(drop: bool, reason: str)`. Pure function. `rms_of(audio: np.ndarray) -> float` helper. |
| `segment_decoder.py` → `turn_decoder.py` | Replace `decode_segments_and_stitch` with `decode_turn(stt, segments, gaps_ms, *, cfg, logger, turn_idx) -> StitchedResult`: group → per-super-segment decode + gate → stitch kept with `[pause.N]`. Middle-drop rule: a dropped super-segment collapses its bounding pauses into one (duration = sum of spanned gaps); leading/trailing dropped super-segment drops its outer pause. |
| `turn_finalizer.py` | Call `decode_turn(...)`; pass the raw `gaps_ms` (from `pauses.durations_ms()`); keep the whole-turn min-duration gate (Step 0) + the empty-text content gate as backstop; `TurnRejected.reason` extended with `"hallucination"`. |
| `turn_pipeline.py` | Pass `gaps_ms=self._pauses.durations_ms()` to the finalizer alongside `speech_segments`. (PauseTracker unchanged — it already records every gap; the grouper filters by `min_pause_ms`.) |
| `config.py` + `config.example.yaml` | `WhisperConfig` gains: `min_pause_ms: int`, `rms_energy_floor: float`, `hallucination_phrases: list[str]`, `hallucination_max_duration_ms: int`, `phrase_energy_multiplier: float`. Inline-documented with ranges. |

## 5. Config additions (config.yaml `whisper:`)

```yaml
  # Minimum silence (ms) that counts as a mid-turn [pause.N]. Gaps shorter than
  # this merge into one super-segment (continuous speech). Prevents "pauses
  # everywhere". Whisper decodes one super-segment per span between >= this gap.
  min_pause_ms: 2000
  # RMS amplitude floor (0.0-1.0, float32 audio). A super-segment quieter than
  # this is treated as non-speech noise and dropped (phrase-agnostic anti-
  # hallucination). Tune from logged per-segment rms; start conservative (low).
  rms_energy_floor: 0.008
  # Known Whisper filler-hallucination phrases (normalized: lowercase, no
  # surrounding punctuation). Dropped ONLY when the segment is also short or
  # quiet, so a real clearly-spoken phrase survives.
  hallucination_phrases:
    - "thank you"
    - "thanks for watching"
    - "you"
    - "bye"
    - "see ya"
    - "okay"
  # Phrase gate applies only to super-segments shorter than this (ms).
  hallucination_max_duration_ms: 1500
  # Phrase gate's low-energy branch: rms < rms_energy_floor * this multiplier.
  phrase_energy_multiplier: 2.0
```

Floors (`rms_energy_floor`, thresholds) are **measured, not guessed**: a first pass enables
`recordings` + the per-segment diagnostic logging, captures a handful of real + phantom turns,
and the floor is chosen between the two RMS clusters. Ship a conservative default; tune from logs.

## 6. Edge cases

| Case | Handling |
|------|----------|
| 1 micro-segment, no gaps | 1 super-segment, no pauses. Gate decides keep/drop. |
| All gaps < min_pause_ms | All merged → 1 super-segment, no pauses. |
| One ≥ min_pause_ms gap | 2 super-segments, `[pause.0]`. |
| Leading/trailing silence | Not between super-segments → never a pause (dropped by construction). |
| Middle super-segment dropped (noise between two real, ≥2s both sides) | Collapse its two bounding pauses into one between the surviving neighbors (duration = sum). Rare. |
| All super-segments dropped | Empty text → `TurnRejected reason="hallucination"`, no transcript emitted. |
| Super-segment > 30 s (no ≥2s pause for >30s) | `mlx_whisper` chunks internally; acceptable. |
| Real short command ("yes", loud) | rms above floor → kept. Its noise twin ("Yeah", quiet) → dropped by energy floor. |

## 7. Test / verification matrix (inline)

Pure functions are the source of truth here (grouper + gate = documented invariant logic), so they
carry unit tests; the WS smoke is the integration gate.

| Case | Type | Input | Expected |
|------|------|-------|----------|
| group-merge | unit `test_super_segment` | segs=[s0,s1,s2,s3], gaps=[500,2500,300], min=2000 | super=[concat(s0,s1), concat(s2,s3)], pauses=[2500] |
| group-none | unit | segs=[s0], gaps=[], min=2000 | super=[s0], pauses=[] |
| group-all-merge | unit | gaps=[300,400], min=2000 | 1 super, pauses=[] |
| gate-low-energy | unit `test_hallucination_gate` | rms=0.001, text="Yeah" | drop, reason=low_energy |
| gate-no-speech | unit | no_speech_prob=0.9, avg_logprob=-2.0 | drop, reason=no_speech |
| gate-phrase-short | unit | text="Thank you.", dur=800ms, rms=0.01 | drop, reason=hallucination_phrase |
| gate-phrase-real | unit | text="thank you", dur=1800ms, rms=0.05 | keep (long + loud) |
| gate-real | unit | text="how about tomorrow", rms=0.05, no_speech=0.1 | keep |
| smoke-happy | integration `ws_smoke` | record-weather.mp3 | transcript ≈ "weather", PASS (regression) |
| smoke-silence | integration | trailing silence / short noise | no phantom transcript (TurnRejected) |
| pause-marker | integration (synthetic) | speech, 3s pause, speech | `[pause.0]` present in transcript, pauses=[~3000] |
| webui-live | manual (**user**) | speak; also stay silent after a reply | correct transcript; NO phantom "Thank you" |

Pre-handover gate: unit tests green; `ws_smoke` happy + silence green; service boots; then user webui
voice test confirms no phantoms.

## 8. Risks

- **Floor tuning:** `rms_energy_floor` too high drops quiet real speech; too low lets noise through.
  Mitigated by measuring from logs before committing a default.
- **Phrase list is English-biased;** zh hallucinations differ. Start with the common EN set; the
  energy floor is the language-agnostic backstop. Extend the list as observed.
- **Middle-drop pause collapse** is a rare path — covered by design + one unit test, but low real
  traffic.
- Still a Whisper-only service (emotion/event stay `""`); no behavior change there.
