# kokoro — localTTS PoC

Kokoro-82M via mlx-audio. The **speed reference**: tiny (82M), blazing RTF, 54 voice
presets — but **no voice cloning** (fixed packs only). If a cloning model can't beat
Kokoro's latency by a usable margin, Kokoro is the fallback for canned voices.

## Run

```bash
./run.sh            # no args; default voice af_heart
```

First run downloads the model from HF. Output → `out/metrics.json` + `out/sample.wav`.

If it fails on a missing phonemizer, add `misaki[en]` to `requirements.txt` and rerun.
