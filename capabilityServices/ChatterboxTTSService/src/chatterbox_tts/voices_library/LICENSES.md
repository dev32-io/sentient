# Built-in voice pack licenses & provenance

> **Voice QUALITY has NOT been listen-tested by the agent** — the operator
> should audition each built-in and replace any that sound poor by
> re-running `scripts/build_builtin_voices.py` (edit `_ENTRIES`, then
> re-run; it overwrites in place).

Every pack in this directory (`<slug>/{ref.wav,meta.json}`) was produced
by `scripts/build_builtin_voices.py`. Qwen3-TTS (the local TTS engine,
`qwen_engine.py`) clones a voice directly from `ref.wav` at synth
time — there is no offline "prepare conditioning" step and no
model-tied artifact to regenerate on a model bump. `ref.wav` **is** the
pack: a small (<1MB), 24 kHz mono PCM16, public-domain reference clip,
committed to the repo intentionally (unlike the old Chatterbox-era
`conds.safetensors` scheme, the raw audio itself is what the engine
needs, so shipping anything less wouldn't work).

---

## LibriVox (US public domain) — all five packs

All five built-ins are 15–20s single-speaker segments cut from
individual chapter/poem tracks of one LibriVox collection.

**Project**: *Miscellaneous Poe: Poems and Short Stories*, by Edgar Allan
Poe — LibriVox catalog id `miscellaneouspoe_1501_librivox`
Project page: <https://librivox.org/miscellaneous-poe-poems-and-short-stories-by-edgar-allan-poe/>
Archive.org item: <https://archive.org/details/miscellaneouspoe_1501_librivox>

**License basis** (verified 2026-07-14 against LibriVox's own policy
page, <https://librivox.org/pages/public-domain/>):

> "LibriVox records only texts that are in the public domain (in the
> USA)... and all our recordings are public domain (definitely in the
> USA...). This means anyone can use all our recordings however they
> wish (even to sell them)."

Each track below is a single narrator reading a public-domain poem/story
solo (no dialogue, no music, no sound effects) — confirmed per-track
reader attribution from the project's own chapter table (`Read by:`
column on the project page above), not just the collection-level
"LibriVox Volunteers" credit.

| Slug | Name | Source track | Reader (LibriVox credit) | Poem/story | Track length | Clip window used | Archive.org mp3 |
|------|------|---------------|---------------------------|------------|---------------|-------------------|-------------------|
| `nova` | Nova | `miscellaneouspoe_06_poe` | "Olivereading" (<https://librivox.org/reader/8686>) | "Alone" | 1:51 | 0:40.5–0:58.5 (18s) | `miscellaneouspoe_06_poe_128kb.mp3` |
| `wren` | Wren | `miscellaneouspoe_02_poe` | Helen Taylor (<https://librivox.org/reader/9136>) | "The Bells" | 5:17 | 0:25–0:45 (20s) | `miscellaneouspoe_02_poe_128kb.mp3` |
| `flint` | Flint | `miscellaneouspoe_06_poe` | "Olivereading" (<https://librivox.org/reader/8686>) | "Alone" | 1:51 | 0:15–0:30 (15s) | `miscellaneouspoe_06_poe_128kb.mp3` |
| `briar` | Briar | `miscellaneouspoe_11_poe` | Bryony Ford (<https://librivox.org/reader/9558>) | "The Pit and the Pendulum" | 36:46 | 1:00–1:20 (20s) | `miscellaneouspoe_11_poe_128kb.mp3` |
| `ember` | Ember | `miscellaneouspoe_12_poe` | Roseanne Hoffman (<https://librivox.org/reader/9452>) | "The Raven" | 9:11 | 0:30–0:50 (20s) | `miscellaneouspoe_12_poe_128kb.mp3` |

Download URL pattern for each row:
`https://www.archive.org/download/miscellaneouspoe_1501_librivox/<Archive.org mp3>`

> **Note on `nova`**: only four distinct raw source tracks/readers exist
> in `scripts/clips/` on this host (`02`/`06`/`11`/`12`, one per
> non-`nova` slug above). `nova` therefore reuses the `06` track
> (`flint`'s source) at a disjoint, non-overlapping offset
> (`0:40.5–0:58.5` vs. `flint`'s `0:15–0:30`) rather than a genuinely
> distinct reader — flagged here for the operator; swap in a fresh
> fifth-reader clip via `scripts/build_builtin_voices.py`'s `_ENTRIES`
> if voice diversity between `nova` and `flint` matters for your
> deployment.

Each clip window was volume-checked (`ffmpeg -af volumedetect` /
`silencedetect`) before use to confirm it landed on continuous speech,
not a silent gap between stanzas (mean volume −24 to −27 dB, max −1 to
−7 dB across all five — no silence, no clipping). The four non-`nova`
clips were historically trimmed by hand with `ffmpeg -ss <start> -t
<seconds> -ac 1 -ar 24000` to mono 24 kHz PCM16 wav and are checked
into `scripts/clips/` as pre-cut source files (git-ignored); `nova`'s
window is instead cut directly from the raw `06` mp3 by
`build_builtin_voices.py` itself (`soundfile` decode at an offset +
`soxr` resample to 24 kHz — no `ffmpeg` step). Raw source mp3s live
only in `scripts/clips/` (git-ignored, never committed) — only the
derived `ref.wav` for each slug is committed, under
`voices_library/<slug>/`.

### A note on scope, for the operator

LibriVox's public-domain dedication covers *reuse of the recording* —
including, per their own policy text above, commercial reuse. Using a
short segment of it as TTS voice-cloning reference audio (rather than,
say, redistributing the audiobook itself) is a different kind of reuse
than most LibriVox listeners have in mind, even though it is within the
letter of the stated policy. If that distinction matters for your
deployment, treat any of `nova`/`wren`/`flint`/`briar`/`ember` as
removable — delete their `voices_library/<slug>/` directories (or drop
their `VoiceEntry` from `scripts/build_builtin_voices.py` and stop
shipping them). `BuiltinLibrary` requires at least one discoverable
`<slug>/ref.wav` pack for `list()`/`get()` callers that assume a
built-in exists; removing all five removes that guarantee for callers
who rely on it.
