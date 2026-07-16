# voxtral — localTTS PoC

Voxtral-TTS (Mistral, Mar 2026) via mlx-audio. Beat ElevenLabs Flash v2.5 on 68% of
zero-shot cloning comparisons — top quality. **Caveat: 4B params** — expect slow
generation on the mini's base-M4 GPU (the same size wall that shelved the 8B LLM). Here to
quantify the quality-vs-speed tradeoff. Only bf16 + 4bit exist (no 8bit) for the TTS build.

## Run

```bash
./run.sh
```
