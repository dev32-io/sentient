# localTTS results

M3 Pro (dev box). `mini_ttfa_ms` = base-M4 estimate (×1.3). `rtf` < 1 = faster than real time; `xrt` = audio-sec per compute-sec.

| option | variant | ttfa_ms | rtf | xrt | rss_mb | mini_ttfa_ms |
|---|---|---|---|---|---|---|
| chatterbox | 8bit | 9263.5 | 1.7 | 0.59 | 2107.0 | 12043 |
| chatterbox | fp16 | 4718.1 | 0.85 | 1.17 | 3139.6 | 6134 |
| chatterbox | turbo-8bit | 1415.2 | 0.28 | 3.58 | 1426.3 | 1840 |
| chatterbox | turbo-fp16 | 3597.3 | 0.73 | 1.36 | 1450.7 | 4676 |
| kokoro | 8bit | 296.7 | 0.06 | 17.59 | 745.0 | 386 |
| kokoro | bf16 | 298.6 | 0.06 | 17.4 | 808.7 | 388 |
| omnivoice | bf16 | 4757.4 | 0.74 | 1.35 | 2081.0 | 6185 |
| qwen3tts | 8bit | 1677.2 | 0.36 | 2.81 | 2514.4 | 2180 |
| qwen3tts | bf16 | 2538.5 | 0.55 | 1.84 | 2289.9 | 3300 |
| voxtral | bf16 | 18536.5 | 3.38 | 0.3 | 8219.0 | 24097 |
