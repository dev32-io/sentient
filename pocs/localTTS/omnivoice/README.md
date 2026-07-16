# omnivoice — localTTS PoC

OmniVoice via mlx-audio. **New community find** (k2-fsa, Daniel Povey lineage, Mar 2026):
Apache-2.0, zero-shot voice cloning, ~40× realtime, 600+ languages. If the speed holds on
Apple Silicon, this is a fast *and* cloneable alternative to Chatterbox.

## Run

```bash
./run.sh            # no args; attempts default voice
```

Cloning model — if generation needs a reference clip (no built-in default), the run will
error; that becomes a follow-up (supply a 10-15s reference, cache conditioning).
