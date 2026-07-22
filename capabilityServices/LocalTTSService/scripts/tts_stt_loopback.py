#!/usr/bin/env python
"""TTS -> STT loop-back evaluator for the text frontend.

Synthesizes each case through local-tts under several frontend
configurations, feeds the audio straight back into the local Whisper STT
service, and records what was actually SPOKEN. This lets a change to the
text frontend be judged without a human listening to every clip.

WHY THIS EXISTS
    Every claim about "how does this sound" was previously unfalsifiable by
    the agent making the change. Symbol handling in particular ("does the
    model say 'vertical bar'?") is cheap to answer with a round trip and
    expensive to answer by ear across dozens of clips.

WHAT IT CAN AND CANNOT TELL YOU
    Whisper emits WRITTEN form, so "fifty dollars" transcribes back as
    "$50". The harness therefore CANNOT rank two differently-worded but
    equally correct renderings. It CAN reliably expose a wrong one --
    "vertical bar", "one s t", "twenty twenty six to oh seven", a leaked
    mask sentinel, or code being read aloud. Use it to detect failure, not
    to pick a winner between two acceptable outputs.

PRECONDITIONS
    The local-tts service must be running with:
        text_frontend.enabled: false   -- this script sends pre-processed
                                          text and needs it passed through
                                          verbatim
        default_lang: <the language under test>
    The whisper-stt service must be running.
    Restore the operator's config when finished -- back it up first.

USAGE
    python scripts/tts_stt_loopback.py --lang en --suite prose
    python scripts/tts_stt_loopback.py --lang zh --suite markdown \
        --variants strip,tn --out /tmp/my-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import re
import sys
import wave

_SRC = pathlib.Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(_SRC))

import websockets  # noqa: E402

from local_tts.text_frontend.emoji_clean import strip_emoji, strip_pause_tags  # noqa: E402
from local_tts.text_frontend.markdown import strip_markdown  # noqa: E402
from local_tts.text_frontend.normalize import Normalizer  # noqa: E402
from local_tts.text_frontend.policy import SpeechPolicy  # noqa: E402
from local_tts.text_frontend.residual import sweep_residual_symbols  # noqa: E402

TTS_PORT = 8770
STT_PORT = 8768
RATE = 16_000  # STT's required rate; ask TTS for it directly, no resampling
CHUNK = RATE * 2 // 25  # 40 ms of PCM16
SILENCE = b"\x00\x00" * (RATE // 2)  # 500 ms padding so VAD sees onset/offset

POLICY = SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True)

# A transcript containing any of these means markup or a symbol was read
# aloud instead of being rendered as speech.
LEAK_WORDS = [
    "vertical bar", "asterisk", "circumflex", "tilde", "underscore",
    "backslash", "backtick", "zqxmask", "zqxtoken",
]

# (name, source, must_contain_any, must_not_contain)
Case = tuple[str, str, list[str], list[str]]


def prose_cases(lang: str) -> list[Case]:
    if lang == "zh":
        return [
            ("zh_currency_usd", "这个价格是 $50。", ["50"], []),
            ("zh_currency_rmb", "这个价格是 ￥88。", ["88"], []),
            ("zh_percent", "湿度是 71%。", ["71"], []),
            ("zh_time", "会议在 7:30 开始。", ["7"], []),
            ("zh_pipe", "多云 | 湿度 71% | 有风", ["71"], ["竖线"]),
        ]
    return [
        ("ordinal", "She finished 1st and he was 23rd.", ["1st", "first"], []),
        ("fraction", "The tank is 3/4 full.", ["3/4", "quarter"], []),
        ("ratio", "They agreed on a 50/50 split.", ["50"], ["fiftieth"]),
        ("currency", "It costs $50 today.", ["50"], []),
        ("abbrev", "Dr. Smith met Mr. Lee.", ["Smith"], []),
        ("pipe", "Cloudy | Humidity 71% | Windy", ["71"], ["vertical bar"]),
        ("underscore", "The snake_case_word appears here.", ["snake"], ["underscore"]),
        ("asterisk", "The area is 2 * 3 meters.", ["2"], []),
        ("tilde", "Restarting takes ~5 minutes.", ["minute"], []),
    ]


def markdown_cases(lang: str) -> list[Case]:
    if lang == "zh":
        return [
            ("zh_heading", "## 天气预报\n\n今天多云。", ["多云"], []),
            ("zh_table", "| 服务 | 端口 |\n|---|---|\n| 网关 | 8080 |", ["8080"], ["竖线"]),
            ("zh_code", "运行这个：\n\n```python\nprint(1)\n```\n\n然后重启。", ["重启"], ["print"]),
        ]
    return [
        ("heading", "## Weather Report\n\nPartly cloudy today.", ["cloudy"], []),
        ("emphasis", "This is **very important** and *worth noting*.", ["important"], []),
        ("code_block", "Run this:\n\n```python\ndef foo(x):\n    return x ** 2\n```\n\nThen restart.",
         ["restart"], ["def", "return", "python"]),
        ("inline_code", "Call the `flush` method, then run `npm install --save-dev pkg`.",
         ["flush"], ["save-dev"]),
        ("many_spans", "Set `timeout`, `retries` and `verbose` in `config.yaml` before `flush`.",
         ["timeout", "retries"], []),
        ("table", "| Service | Port |\n|---|---|\n| gateway | 8080 |\n| tts | 8888 |",
         ["gateway"], ["vertical bar"]),
        ("bullets", "Shopping:\n\n- milk\n- eggs\n- bread", ["milk", "eggs"], []),
        ("blockquote", "She wrote:\n\n> The sky was clear.\n\nAnd left.", ["clear"], []),
        ("link", "See [the setup guide](https://example.com/docs) for details.",
         ["guide"], ["http", "example.com"]),
        ("bare_url", "Docs live at https://example.com/a/b and update weekly.",
         ["weekly"], ["http", "example.com"]),
        ("image", "Look at ![a red barn](barn.png) closely.", ["look"], ["png"]),
        ("task_list", "Today:\n\n- [ ] laundry\n- [x] dishes", ["laundry", "dishes"], []),
        ("footnote", "The claim holds[^1].\n\n[^1]: Source omitted.", ["claim"], ["omitted"]),
        ("mixed_readme",
         "# Setup\n\nInstall with `bun install`, then see [docs](https://x.io).\n\n"
         "| Step | Time |\n|---|---|\n| build | 2m |\n\n```sh\nbun run dev\n```\n\nDone.",
         ["setup", "done"], ["http", "vertical bar"]),
        ("prose_mixed",
         "Chapter 3 — **The Return**\n\nHe walked ~200 metres, then stopped...\n\n*She never came back.*",
         ["walked"], []),
    ]


def build_variants(doc: str, lang: str, normalizer: Normalizer, wanted: list[str]) -> dict[str, str]:
    """Mirror TextFrontend.process stage-for-stage, per configuration.

    Stage order is load-bearing and matches frontend.py exactly:
      strip (spans masked) -> emoji/pause -> [sweep] -> [TN] -> UNMASK
    Skipping the unmask step makes the model read sentinels aloud
    ("zqxmaskaa"), which is a harness bug, not a product one -- it bit an
    earlier revision of this script.
    """
    stripped = strip_markdown(doc, POLICY, lang)
    base = strip_pause_tags(strip_emoji(stripped.text))

    def normalize(text: str) -> str:
        return "\n\n".join(
            normalizer.normalize(b, lang) if b.strip() else b for b in text.split("\n\n")
        )

    out: dict[str, str] = {}
    if "none" in wanted:
        out["none"] = doc  # raw markdown, no frontend at all
    if "strip" in wanted:
        out["strip"] = stripped.masks.restore(base)
    if "tn" in wanted:
        out["tn"] = stripped.masks.restore(normalize(base))
    if "sweep" in wanted:
        out["sweep"] = stripped.masks.restore(normalize(sweep_residual_symbols(base)))
    return out


async def synthesize(text: str, path: pathlib.Path, voice: str) -> bytes:
    url = f"ws://127.0.0.1:{TTS_PORT}/?format=pcm&sample_rate={RATE}&voice={voice}"
    async with websockets.connect(url, max_size=None) as ws:
        hello = json.loads(await ws.recv())
        if hello.get("voice") != voice:
            raise RuntimeError(f"voice not pinned, got {hello.get('voice')!r}: {hello}")
        await ws.send(json.dumps({"type": "text", "text": text}))
        await ws.send(json.dumps({"type": "end"}))
        pcm = bytearray()
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                pcm.extend(msg)
                continue
            frame = json.loads(msg)
            if frame["type"] == "done":
                break
            if frame["type"] == "error":
                raise RuntimeError(frame)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(bytes(pcm))
    return bytes(pcm)


async def transcribe(pcm: bytes, lang: str) -> str:
    url = f"ws://127.0.0.1:{STT_PORT}/?language={lang}&audioFormat=pcm16"
    async with websockets.connect(url, max_size=None) as ws:
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            raise RuntimeError(ready)
        payload = SILENCE + pcm + SILENCE
        for offset in range(0, len(payload), CHUNK):
            await ws.send(payload[offset : offset + CHUNK])
            await asyncio.sleep(0.003)
        await ws.send(json.dumps({"type": "flush"}))
        texts: list[str] = []
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=25)
                if isinstance(msg, bytes):
                    continue
                event = json.loads(msg)
                if event["type"] == "transcript_ready":
                    texts.append(event["text"])
                elif event["type"] == "turn_rejected":
                    texts.append("<REJECTED>")
        except asyncio.TimeoutError:
            pass
    return re.sub(r"\[pause\.\d+\]", "", " ".join(texts)).strip() or "<NONE>"


def grade(heard: str, must: list[str], must_not: list[str]) -> str:
    low = heard.lower()
    flags = sorted({w for w in LEAK_WORDS if w in low} | {w for w in must_not if w.lower() in low})
    if flags:
        return "LEAK(" + ",".join(flags[:3]) + ")"
    if must and not any(m.lower() in low for m in must):
        return "MISS"
    return "ok"


async def run(args: argparse.Namespace) -> None:
    out_dir = pathlib.Path(args.out or f"/tmp/tts-loopback-{args.suite}-{args.lang}")
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = [v.strip() for v in args.variants.split(",") if v.strip()]
    cases = prose_cases(args.lang) if args.suite == "prose" else markdown_cases(args.lang)
    if args.only:
        keep = {n.strip() for n in args.only.split(",")}
        cases = [c for c in cases if c[0] in keep]
    normalizer = Normalizer()

    rows: list[str] = []
    report: list[str] = [
        f"# TTS->STT loop-back — suite={args.suite} lang={args.lang} voice={args.voice}\n"
    ]
    for name, doc, must, must_not in cases:
        report.append(f"\n## {name}\n\nSOURCE:\n```\n{doc}\n```\n")
        for vname, text in build_variants(doc, args.lang, normalizer, wanted).items():
            pcm = await synthesize(text, out_dir / f"{name}__{vname}.wav", args.voice)
            heard = await transcribe(pcm, args.lang)
            verdict = grade(heard, must, must_not)
            report.append(f"- **{vname}** `{verdict}`\n  - sent : `{text!r}`\n  - heard: `{heard}`")
            rows.append(f"{name:16s} {vname:6s} {verdict:24s} {heard[:110]}")
            print(rows[-1], flush=True)

    (out_dir / "REPORT.md").write_text("\n".join(report), encoding="utf-8")
    (out_dir / "SUMMARY.txt").write_text("\n".join(rows), encoding="utf-8")
    print(f"\nwrote {out_dir}/REPORT.md and SUMMARY.txt")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lang", default="en", choices=["en", "zh"])
    parser.add_argument("--suite", default="prose", choices=["prose", "markdown"])
    parser.add_argument("--voice", default="nova", help="voice pack id; MUST be pinned for a fair A/B")
    parser.add_argument("--variants", default="none,strip,tn,sweep")
    parser.add_argument("--only", default="", help="comma-separated case names to run")
    parser.add_argument("--out", default="", help="output directory")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
