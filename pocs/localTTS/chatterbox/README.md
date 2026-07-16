# chatterbox — localTTS PoC

Chatterbox-TTS (Resemble AI) via mlx-audio. **Quality king**: 0.5B, MIT, zero-shot voice
cloning from a 10–15s clip, and in Resemble's blind test the Turbo variant was preferred
65% over ElevenLabs. This is the primary Fish-replacement candidate.

## Run

```bash
./run.sh            # no args; built-in default voice (no cloning in the speed test)
```

Speed uses the default speaker. **Cloning** = pass a reference clip once, cache the
conditioning, reuse (one-time cost, not per-utterance). That's a follow-up POC step.

Variants: `mlx-community/Chatterbox-TTS-{fp16,8bit,4bit}`, `chatterbox-turbo-*` (quality
leader). Quantized runs faster on the mini's weak GPU.
