# Third Party Notices

This file lists the licenses and attributions for third-party software that
ships as part of Sentient or is consumed at runtime. The firmware tree has
its own notices file at `esp32/cube/firmware/THIRD_PARTY_NOTICES.md`.

## npm / Bun runtime dependencies

### Apache-2.0

- [dockerode](https://github.com/apocas/dockerode) — Apache-2.0
- [openai](https://github.com/openai/openai-node) — Apache-2.0
- [@jitsi/rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm) (wrapper) — Apache-2.0

For each Apache-2.0 dependency, the upstream `NOTICE` file (where present)
is preserved in the installed `node_modules/<pkg>/NOTICE` and reproduced in
container distributions.

### BSD-2-Clause / BSD-3-Clause

- [RNNoise](https://github.com/xiph/rnnoise) C source (bundled inside
  `@jitsi/rnnoise-wasm` as compiled wasm) — BSD-3-Clause, © Xiph.Org Foundation
- [libopus](https://www.opus-codec.org/) (bundled inside `opus-decoder` and
  `ogg-opus-decoder` wasm) — BSD-3-Clause, © Xiph.Org Foundation

### MPL-2.0

- [DOMPurify](https://github.com/cure53/DOMPurify) (consumed via
  `isomorphic-dompurify`, unmodified) — MPL-2.0 / Apache-2.0 dual-licensed

  Sentient does not fork or modify DOMPurify source. Consumed as a published
  npm dependency. Only triggers MPL file-level copyleft if the source were
  modified, which it is not.

### MIT / ISC / permissive (selected)

The following ship under permissive licenses (MIT, ISC, or equivalent) and
require no special notice beyond preservation of their `LICENSE` file:
`@logtape/logtape`, `@logtape/file`, `@msgpack/msgpack`, `@preact/signals`,
`cockatiel`, `emoji-regex`, `marked`, `ogg-opus-decoder`, `opus-decoder`,
`paseto-ts`, `preact`, `qrcode`, `streaming-markdown`, `yaml`, `zod`.

## Python / STT Service runtime dependencies

### Apache-2.0

- [transformers](https://github.com/huggingface/transformers) — Apache-2.0
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — Apache-2.0
- [huggingface_hub](https://github.com/huggingface/huggingface_hub) — Apache-2.0

### BSD-3-Clause

- [websockets](https://github.com/python-websockets/websockets) — BSD-3-Clause
- [soundfile](https://github.com/bastibe/python-soundfile) — BSD-3-Clause
- [psutil](https://github.com/giampaolo/psutil) — BSD-3-Clause
- [opuslib](https://github.com/orion-labs/opuslib) — BSD-3-Clause
- [numpy](https://github.com/numpy/numpy) — primarily BSD-3-Clause with
  bundled components under 0BSD / MIT / Zlib / CC0

### MIT

- [silero-vad](https://github.com/snakers4/silero-vad) — MIT (package and
  bundled VAD model weights, v5.1+)
- [onnxruntime](https://github.com/microsoft/onnxruntime) — MIT
- [pyyaml](https://github.com/yaml/pyyaml) — MIT

### System / native

- `libopus0` (Debian package, system-installed at Docker build time) —
  BSD-3-Clause, © Xiph.Org Foundation

## Machine learning model weights

Model weights download at Docker build time via
`capabilityServices/STTService/scripts/download_models.py`. They are not
vendored in this repository. Each model carries its own license, separate
from the wrapping code.

### Smart-Turn v3.2 ONNX weights — BSD-2-Clause

Source: [pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3)
© Pipecat AI. BSD-2-Clause — see upstream `LICENSE`.

### Silero VAD model — MIT

Source: bundled with the `silero-vad` Python package. © Silero Team.

### SenseVoice-Small ONNX weights — FunASR Model Open Source License v1.1

Source: [FunAudioLLM/SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall),
distributed via [csukuangfj's sherpa-onnx ONNX mirror](https://github.com/k2-fsa/sherpa-onnx).
© Alibaba (FunAudioLLM Team).

**Important:** SenseVoice-Small weights are licensed under the custom
**FunASR Model Open Source License v1.1**, not under MIT or another
OSI-approved license. The terms permit commercial use, but require
attribution to the upstream model + retention of the model name. They
also include a non-standard termination clause if the user "denigrates or
insults" the upstream software. Downstream redistributors of the model
file (including those who ship built Docker images) inherit these
obligations. See the upstream model card for the full license text.

This repository ships only the download script, not the model weights
themselves, so the obligation only attaches to built images that bundle
the downloaded weights.
