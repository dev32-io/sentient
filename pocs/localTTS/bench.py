"""Shared TTS speed harness for the localTTS PoCs.

One measurement path for every option (Kokoro / Chatterbox / Qwen3-TTS / …) so the
numbers are comparable. Each option's `run.sh` invokes this with its own model id
(and default voice) inside that option's isolated uv env.

Metrics (the ones that decide voice-assistant fit):
  - ttfa_ms   : time-to-first-audio — wall time from generate() to the first audio
                chunk actually computed (mx.eval forced). THE voice-latency KPI.
  - total_ms  : wall time to finish the whole utterance.
  - audio_sec : duration of generated audio.
  - rtf       : total_ms / audio_sec (÷1000). < 1.0 = faster than real time.
  - xrt       : 1 / rtf = seconds of audio produced per second of compute (headroom).
  - rss_mb    : peak process RSS during generation.

All runs are on THIS box (M3 Pro). For the base-M4 mini estimate: ttfa ×~1.3, xrt ÷~1.3.

Usage:
  python bench.py --model <hf-id> [--voice V] [--text T] [--runs N] [--out DIR] [--sr SR]
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
import psutil
import soundfile as sf

from mlx_audio.tts.utils import load_model

DEFAULT_TEXT = (
    "Sure, I've added milk and eggs to your shopping list. "
    "Anything else you'd like me to remember?"
)


def _to_np(audio) -> np.ndarray:
    mx.eval(audio)
    return np.asarray(audio).reshape(-1)


def one_run(model, text: str, gen_kwargs: dict, sr_fallback: int):
    kw = dict(gen_kwargs)
    proc = psutil.Process()
    rss_peak = proc.memory_info().rss
    sr = sr_fallback
    chunks: list[np.ndarray] = []
    ttfa = None

    start = time.perf_counter()
    for result in model.generate(text, **kw):
        a = _to_np(result.audio)  # forces mx.eval -> real compute captured
        if ttfa is None:
            ttfa = (time.perf_counter() - start) * 1000.0
        chunks.append(a)
        sr = getattr(result, "sample_rate", None) or sr
        rss_peak = max(rss_peak, proc.memory_info().rss)
    total = (time.perf_counter() - start) * 1000.0

    audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    audio_sec = len(audio) / sr
    rtf = (total / 1000.0) / audio_sec if audio_sec else float("inf")
    return {
        "ttfa_ms": round(ttfa or total, 1),
        "total_ms": round(total, 1),
        "audio_sec": round(audio_sec, 3),
        "rtf": round(rtf, 4),
        "xrt": round(1.0 / rtf, 2) if rtf else 0,
        "rss_mb": round(rss_peak / (1024 * 1024), 1),
        "sr": sr,
    }, audio


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--voice", default=None)
    ap.add_argument("--gen-file", default=None,
                    help="JSON file of extra generate() kwargs (ref_audio, ref_text, audio_prompt, voice, ...)")
    ap.add_argument("--text", default=DEFAULT_TEXT)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--warmup", type=int, default=1)
    ap.add_argument("--out", default="out")
    ap.add_argument("--sr", type=int, default=24000, help="fallback sample rate")
    args = ap.parse_args()

    gen_kwargs: dict = {}
    if args.voice:
        gen_kwargs["voice"] = args.voice
    if args.gen_file:
        gen_kwargs.update(json.loads(Path(args.gen_file).read_text()))
    # Chatterbox: keep audio_prompt as the PATH (it librosa-loads internally) but it only
    # runs prepare_conditionals when audio_prompt_sr is also set — so populate the sr.
    ap = gen_kwargs.get("audio_prompt")
    if isinstance(ap, str) and ap.endswith(".wav"):
        gen_kwargs.setdefault("audio_prompt_sr", int(sf.info(ap).samplerate))
    # qwen3tts (Base) wants ref_audio as an ARRAY, not a path (omnivoice took a path).
    # Opt in per-POC with "_ref_audio_array": true in gen.json.
    if gen_kwargs.pop("_ref_audio_array", False):
        ra = gen_kwargs.get("ref_audio")
        if isinstance(ra, str) and ra.endswith(".wav"):
            gen_kwargs["ref_audio"] = mx.array(sf.read(ra, dtype="float32")[0])
    print(f"[bench] generate kwargs: {list(gen_kwargs)}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"[bench] loading {args.model} ...")
    t = time.perf_counter()
    model = load_model(args.model)
    load_ms = (time.perf_counter() - t) * 1000.0
    print(f"[bench] loaded in {load_ms:.0f} ms")

    for i in range(args.warmup):
        print(f"[bench] warmup {i + 1}/{args.warmup}")
        one_run(model, args.text, gen_kwargs, args.sr)

    samples = []
    last_audio = None
    for i in range(args.runs):
        m, audio = one_run(model, args.text, gen_kwargs, args.sr)
        last_audio = audio
        samples.append(m)
        print(f"[bench] run {i + 1}/{args.runs}: {m}")

    def med(k):
        return round(statistics.median(s[k] for s in samples), 2)

    summary = {
        "model": args.model,
        "gen_keys": list(gen_kwargs),
        "runs": args.runs,
        "load_ms": round(load_ms, 1),
        "ttfa_ms_median": med("ttfa_ms"),
        "total_ms_median": med("total_ms"),
        "audio_sec": samples[0]["audio_sec"],
        "rtf_median": med("rtf"),
        "xrt_median": med("xrt"),
        "rss_mb_peak": max(s["rss_mb"] for s in samples),
        "sr": samples[0]["sr"],
    }

    if last_audio is not None:
        wav = out / "sample.wav"
        sf.write(str(wav), last_audio, summary["sr"])
        print(f"[bench] wrote {wav}")

    (out / "metrics.json").write_text(json.dumps(summary, indent=2))
    print("\n=== SUMMARY ===")
    print(json.dumps(summary, indent=2))
    print(f"\nmini (base-M4) est: ttfa ~{summary['ttfa_ms_median'] * 1.3:.0f} ms, "
          f"xrt ~{summary['xrt_median'] / 1.3:.2f}")


if __name__ == "__main__":
    main()
