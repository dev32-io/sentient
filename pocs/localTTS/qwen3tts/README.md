# qwen3tts — localTTS PoC

Qwen3-TTS-12Hz-0.6B via mlx-audio. **Streaming wildcard** — Apache-2.0, 3-second-reference
voice cloning, description-based voice design, streaming-oriented architecture.

## Run

```bash
./run.sh            # no args; default voice "Chelsie"
```

Variants: `0.6B` (fastest) and `1.7B` (higher quality) `-Base-bf16/-4bit`; `CustomVoice`
repos for the cloning path. Base uses named preset voices (Chelsie, Ethan).
