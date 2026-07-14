# Built-in voice pack licenses & provenance

> **Voice QUALITY has NOT been listen-tested by the agent** — the operator
> should audition each built-in and replace any that sound poor by
> re-running `scripts/build_builtin_voices.py` (edit `_ENTRIES`, then
> re-run; it overwrites in place).

Every pack in this directory (`<slug>/{conds.safetensors,meta.json}`) was
produced by `scripts/build_builtin_voices.py` against model:

```
mlx-community/Chatterbox-Turbo-TTS-8bit
```

**Built-in conds are model-version-tied.** `conds.safetensors` pickles a
`Conditionals` object (`t3`/`gen` fields) computed against this exact
model's weights (see `voice_store.py`'s module docstring). Bumping
`config.yaml`'s `model` to a different checkpoint means every pack below
should be regenerated — re-run the generator after the bump.

---

## `nova` — model-default (no external clip)

- **Source**: `ChatterboxEngine.default_conditionals()` — the model's own
  built-in reference voice, shipped inside the
  `mlx-community/Chatterbox-Turbo-TTS-8bit` weights repo itself (loaded
  from that repo's own `conds.safetensors` at model-load time; see
  `chatterbox_mlx.py`'s module docstring).
- **License basis**: none needed — this is the model's own conditioning,
  redistributed as part of the model weights we already depend on. No
  external clip was fetched, recorded, or used.
- **Why "guaranteed baseline"**: license-bulletproof by construction, and
  always available as long as the configured model loads — the built-in
  discovery path (`BuiltinLibrary._scan_slugs`) is never empty.

---

## Best-effort diversity packs — LibriVox (US public domain)

The four packs below are 15–20s single-speaker segments cut from
individual chapter/poem tracks of one LibriVox collection:

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
| `wren` | Wren | `miscellaneouspoe_02_poe` | Helen Taylor (<https://librivox.org/reader/9136>) | "The Bells" | 5:17 | 0:25–0:45 (20s) | `miscellaneouspoe_02_poe_128kb.mp3` |
| `flint` | Flint | `miscellaneouspoe_06_poe` | "Olivereading" (<https://librivox.org/reader/8686>) | "Alone" | 1:51 | 0:15–0:30 (15s) | `miscellaneouspoe_06_poe_128kb.mp3` |
| `briar` | Briar | `miscellaneouspoe_11_poe` | Bryony Ford (<https://librivox.org/reader/9558>) | "The Pit and the Pendulum" | 36:46 | 1:00–1:20 (20s) | `miscellaneouspoe_11_poe_128kb.mp3` |
| `ember` | Ember | `miscellaneouspoe_12_poe` | Roseanne Hoffman (<https://librivox.org/reader/9452>) | "The Raven" | 9:11 | 0:30–0:50 (20s) | `miscellaneouspoe_12_poe_128kb.mp3` |

Download URL pattern for each row:
`https://www.archive.org/download/miscellaneouspoe_1501_librivox/<Archive.org mp3>`

Each clip window was volume-checked (`ffmpeg -af volumedetect`) before use
to confirm it landed on continuous speech, not a silent gap between
stanzas (mean volume −25 to −27 dB, max −4 to −7 dB across all four — no
silence). Trimmed with `ffmpeg -ss <start> -t <seconds> -ac 1 -ar 24000`
to mono 24 kHz PCM16 wav, then run through
`ChatterboxEngine.prepare_conditionals`. Raw source mp3s and trimmed wavs
were kept only in `scripts/clips/` (git-ignored, never committed) for the
duration of the generation run.

### A note on scope, for the operator

LibriVox's public-domain dedication covers *reuse of the recording* —
including, per their own policy text above, commercial reuse. Using a
short segment of it as TTS voice-cloning conditioning (rather than, say,
redistributing the audiobook itself) is a different kind of reuse than
most LibriVox listeners have in mind, even though it is within the
letter of the stated policy. If that distinction matters for your
deployment, treat `wren`/`flint`/`briar`/`ember` as removable — delete
their `voices_library/<slug>/` directories (or drop their `VoiceEntry`
from `scripts/build_builtin_voices.py` and stop shipping them) with no
effect on `nova`, which has no such dependency.
