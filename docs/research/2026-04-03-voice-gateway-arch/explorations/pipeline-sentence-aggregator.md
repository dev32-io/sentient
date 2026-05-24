# Pipeline Sub-Decision: Sentence Aggregator

## Parent Decision Area
`pipeline-architecture` — this is a sub-decision extracted during decomposition.

## Decision Area
How the SentenceAggregator processor detects sentence boundaries in streaming LLM token output to enable TTS overlap. This is the critical component that enables the 50-70% perceived latency reduction.

## Key Questions

1. **Boundary detection rules**: How to handle abbreviations ("Dr.", "U.S.A."), ellipsis ("..."), decimal numbers ("3.14"), URLs, and quoted speech within streaming tokens?
2. **Minimum chunk size**: What's the minimum word count before emitting a sentence? Too small = TTS stitching artifacts. Too large = latency regression.
3. **Timeout / force-break**: If no punctuation appears after N tokens, when and where to force a sentence break?
4. **Fragment buffering**: How to handle very short fragments (e.g., "Yes." or "No.") — emit immediately or buffer with the next sentence?
5. **Configurability**: Should thresholds (min words, max words before force-break, timeout) be runtime-configurable or compile-time constants?
6. **TTS-specific preprocessing**: Should the aggregator also handle text normalization (numbers → words, abbreviations → expansions) or is that a separate processor?

---

## Prior Art: stream2sentence

The `stream2sentence` library (MIT, KoljaB) is the most mature solution for this exact problem. Key design decisions worth learning from:

### Delimiter Sets
- **Full sentence delimiters**: `.?!\n…。` — trigger a sentence yield
- **Fragment delimiters**: `.?!;:,\n…)]}。-` — used for force-break and quick-yield modes

### Abbreviation Handling
A set of ~64 known prefixes (`Mr.`, `Mrs.`, `Dr.`, `Prof.`, `Inc.`, `Ltd.`, `Ph.D.`, `a.m.`, `p.m.`, `U.S.A.`, `U.K.`, months `Jan.`–`Dec.`, military ranks `Sgt.`/`Col.`, etc.). When a period is preceded by one of these, it is NOT treated as a sentence boundary.

### Pause-Word Avoidance
A set of ~95 function words (conjunctions, prepositions, articles, auxiliaries, pronouns). The library avoids breaking at points where the last word is one of these, preventing unnatural TTS pauses like "The weather today is | sunny" → "The weather today is sunny. |"

### Configurable Parameters
| Parameter | Default | Purpose |
|-----------|---------|---------|
| `minimum_sentence_length` | 10 chars | Floor before emitting |
| `minimum_first_fragment_length` | 10 chars | Floor for first chunk (latency-sensitive) |
| `force_first_fragment_after_words` | 30 words | Force-break if no punctuation on first chunk |
| `context_size` | 12 chars | Lookahead for delimiter context |
| `cleanup_text_links` | False | Strip URLs |
| `cleanup_text_emojis` | False | Strip emojis |
| `quick_yield_single_sentence_fragment` | False | Yield partial sentences at fragment delimiters |
| `quick_yield_every_fragment` | False | Aggressive: yield at every fragment delimiter |

### Known Gaps in stream2sentence
- **Decimal numbers**: `3.14` triggers a false sentence break — no digit-dot-digit detection
- **Three-dot ellipsis**: `...` (three chars) may trigger on the first dot; only `…` (U+2026) is handled as a unit
- **CJK**: Only `。` recognized — missing `？`, `！`, `；`
- **Markdown**: No stripping — code blocks, bold, headers passed through verbatim
- **Force-break only on first fragment**: Subsequent sentences have no word-count force-break
- **No quoted speech handling**: `"Hello," she said.` can break at the comma

---

## TTS Behavior with Short Inputs

TTS engines generally handle short inputs poorly:
- **Under ~3 words**: Unnatural prosody — the engine can't infer rhythm from too little context
- **Single words**: Risk of abrupt onset/offset, garbled output, or silence padding
- **Fish Audio**: WebSocket streaming with `latency: "balanced"` mode; short inputs get less context for prosody modeling
- **Cartesia**: Better at short inputs due to State Space Model architecture, but still suboptimal under 3 words
- **Industry consensus**: Buffer to at least 15-20 characters (~3-4 words) before sending to TTS

**Implication**: "Yes." or "OK." should either be buffered with the next sentence OR handled via a minimum-length gate. For a voice assistant, very short affirmative responses are common enough that they need a fast path, not buffering — the user expects an immediate "Yes."

**Resolution**: Two-tier minimum:
- **Ultra-short affirmatives** (single-word responses that ARE the complete LLM output): emit immediately — TTS can handle isolated "Yes." acceptably, and the alternative (silence while waiting for more tokens that never come) is worse
- **Mid-response short fragments** (e.g., "Yes." followed by more text): buffer with the next sentence to improve prosody

---

## Markdown and Non-Speech Content

LLM output often contains markdown that TTS cannot meaningfully speak:

| Content Type | Strategy |
|-------------|----------|
| `**bold**`, `*italic*` | Strip markers, keep text |
| `` `inline code` `` | Strip backticks, keep text |
| ```` ```code blocks``` ```` | Skip entirely, or say "Here's a code example" |
| `# Headers` | Strip `#`, keep text |
| `- Bullet lists` | Strip `-`, optionally prefix with "First,", "Next," |
| `[links](url)` | Keep link text, strip URL |
| Emojis | Strip (TTS reads emoji names aloud otherwise) |
| `> Blockquotes` | Strip `>`, keep text |

**Design decision**: Markdown stripping belongs in a **separate TextPreprocessor** stage between LLM output and SentenceAggregator. Reasons:
1. **Separation of concerns**: Aggregator deals with boundaries; preprocessor deals with content normalization
2. **Testability**: Each processor is independently testable
3. **Pipeline ordering**: Strip markdown first, THEN detect sentence boundaries — otherwise code blocks with periods cause false breaks

---

## Approaches Evaluated

### A. Simple Punctuation + Minimum Length

**Rules:**
- Split on `.!?\n` when followed by a space or end of buffer
- Minimum 15 characters (~3 words) before emitting
- Force break at 35 words at the next comma, semicolon, or conjunction
- No abbreviation handling — accept occasional false breaks

**Pros:**
- ~20 lines of code. Trivially testable
- Zero dependencies, zero maintenance burden
- Covers ~90% of conversational LLM output (which uses simple punctuation)
- Latency: <0.01ms per token

**Cons:**
- False breaks on "Dr. Smith" (emits "Dr." as a sentence) — but in practice LLMs rarely use these in voice assistant contexts
- No decimal protection — "The value is 3.14" breaks to "The value is 3." + "14"
- No ellipsis handling — "Well..." breaks early
- No force-break for long unpunctuated runs except at 35-word threshold

**When this fails**: Scientific/numeric content, formal writing with titles, code explanations with decimal numbers. For a family voice assistant, these cases are rare (~5-10% of interactions).

### B. Regex-Based with Abbreviation Allowlist

**Rules:**
- Regex: sentence boundary = `[.!?]` NOT preceded by known abbreviation, NOT in digit-dot-digit pattern, followed by whitespace or EOF
- Abbreviation allowlist: ~40 common prefixes (Dr., Mr., Mrs., Ms., Prof., Jr., Sr., St., U.S., U.K., a.m., p.m., etc.)
- Decimal protection: negative lookbehind for `\d\.` followed by `\d`
- Ellipsis: `\.{3}` or `…` treated as non-terminal (accumulate, don't break)
- Minimum 15 characters before emitting
- Force break at 35 words at next clause boundary (comma, semicolon, dash, conjunction)
- Force break at 50 words unconditionally (mid-word if necessary — prevents unbounded buffering)

**Regex pattern (core):**
```python
# Sentence-ending punctuation NOT preceded by abbreviation or decimal
ABBREV = r'(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|Jr|Sr|St|Inc|Ltd|etc|vs|approx|dept|est|govt|min|max|avg|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|U\.S|U\.K|a\.m|p\.m))'
DECIMAL = r'(?<!\d)'
SENTENCE_END = rf'{ABBREV}{DECIMAL}\.\s|[!?]\s|[!?]$|\.\s*$|\n'
```

**Pros:**
- Handles 95%+ of real-world LLM output correctly
- Decimal numbers survive intact
- Abbreviations don't cause false breaks
- Ellipsis handled cleanly
- Still very fast (<0.1ms per token)
- ~60 lines of code — moderate complexity

**Cons:**
- Abbreviation list needs curation — missing entries cause false breaks, over-inclusion causes missed breaks
- Regex complexity grows with edge cases (quoted speech, parentheticals, numbered lists like "1. First item")
- Quoted speech still problematic: `"Hello," she said.` — the period after "said" is the real break, but the comma inside quotes could confuse fragment boundaries
- No CJK support without extending the pattern

**Maintenance burden**: Low-medium. The abbreviation list is the main maintenance surface — add entries as false breaks are discovered in production.

### C. stream2sentence-Inspired Adaptive Aggregator

**Rules:**
- Port core logic from stream2sentence (MIT license), adapted for async frame pipeline
- Two-tier delimiters: full (`.!?\n…。？！`) and fragment (`.!?;:,\n…)]-。`)
- Abbreviation allowlist (~64 entries from stream2sentence)
- Pause-word avoidance: don't break when last word is a function word
- Adaptive chunk sizing:
  - First chunk: force yield after 25 words (latency-optimized — get audio to user fast)
  - Subsequent chunks: force yield after 40 words
- Timeout: if no full delimiter within 2 seconds of accumulated tokens, force break at next fragment delimiter
- Minimum 10 characters for first chunk, 15 characters for subsequent
- CJK support: `。？！；` as full delimiters
- Configurable via dataclass:

```python
@dataclass
class AggregatorConfig:
    min_chars: int = 15
    min_first_chars: int = 10
    force_first_after_words: int = 25
    force_after_words: int = 40
    timeout_seconds: float = 2.0
    abbreviations: frozenset[str] = COMMON_ABBREVIATIONS
    pause_words: frozenset[str] = COMMON_PAUSE_WORDS
    cjk_delimiters: str = "。？！；"
```

**Pros:**
- Most accurate boundary detection — handles abbreviations, decimals, ellipsis, pause words, CJK
- Adaptive: latency-optimized first chunk, quality-optimized subsequent chunks
- Timeout prevents unbounded buffering for pathological LLM output
- Configurable without code changes
- Proven approach (stream2sentence is used in RealtimeTTS, widely adopted)
- Pause-word avoidance produces more natural TTS prosody

**Cons:**
- ~150-200 lines of code — meaningfully more complex than A or B
- More test surface area (abbreviation list, pause words, timeout, adaptive thresholds all need testing)
- Configurable parameters create a tuning burden — defaults must be well-chosen
- Pause-word set needs validation against actual TTS quality (do unnatural breaks actually produce audible artifacts?)
- Diminishing returns: the difference between B and C may be inaudible for 90%+ of family assistant conversations

**Risk**: Over-engineering for a 5-user family assistant where most queries are "what's the weather" and "set a timer."

---

## Analysis & Recommendation

### Decision Matrix

| Factor | A. Simple | B. Regex + Allowlist | C. Adaptive |
|--------|:-:|:-:|:-:|
| Accuracy (conversational) | ~90% | ~95% | ~98% |
| Accuracy (formal/numeric) | ~70% | ~90% | ~95% |
| Implementation complexity | ~20 lines | ~60 lines | ~150-200 lines |
| Latency per token | <0.01ms | <0.1ms | <0.1ms |
| Maintenance burden | Negligible | Low (abbreviation list) | Medium (config + lists) |
| TTS prosody quality | Good | Good-Very Good | Very Good |
| Configurability | Hardcoded | Partially configurable | Fully configurable |
| CJK support | None | None | Yes |
| Edge case coverage | Low | Medium-High | High |

### Recommendation: Approach B (Regex + Abbreviation Allowlist)

**Why B over A**: The decimal number and abbreviation problems in A produce audible TTS artifacts that will hit real usage. "The value is 3." + "14 degrees" sounds broken. "Dr." + "Smith says hello" is jarring. The ~40 extra lines of code for B eliminate these common failures.

**Why B over C**: The marginal accuracy gain (95% → 98%) doesn't justify tripling the codebase. Pause-word avoidance and adaptive chunk sizing are nice-to-haves whose impact on TTS prosody is unvalidated. The timeout mechanism in C is genuinely useful but can be added to B as a simple `asyncio.wait_for()` wrapper without the full adaptive framework. CJK support can be added to B's regex with one additional character class if needed.

**Migration path**: Start with B. If TTS quality complaints surface in practice, add pause-word avoidance (upgrade toward C). The regex-based approach is easily extended without rewriting.

### Key Design Decisions

1. **Separate TextPreprocessor before SentenceAggregator**: Markdown stripping, emoji removal, and text normalization happen in a dedicated upstream processor. The aggregator receives clean text only.
2. **Pipeline ordering**: LLM → TextPreprocessor → SentenceAggregator → TTS
3. **Minimum 15 chars before emit**: Prevents TTS artifacts from ultra-short fragments
4. **Ultra-short complete-response fast path**: If LLM output is done and buffer is <15 chars, emit immediately (don't wait for more tokens that won't come)
5. **Force break at 35 words / hard break at 50 words**: Prevents unbounded buffering
6. **Abbreviation allowlist as a frozen set**: Configurable but not runtime-mutable. Start with ~40 entries.
7. **Decimal protection via lookbehind**: `(?<!\d)\.\s` — periods after digits are not boundaries
8. **Timeout via asyncio**: If 2 seconds pass without a sentence yield, force break at next clause boundary. Implemented as a timer reset on each token, not as part of the regex.

### Open Questions for Scoring

- Should the abbreviation allowlist be user-editable (config file) or code-only?
- Does the separate TextPreprocessor need its own exploration, or is it straightforward enough to spec inline?
- Should the aggregator emit metadata (character count, word count, time-since-last-emit) for downstream observability?
- How does force-break interact with UninterruptibleFrame? If a tool result is being spoken and we force-break mid-result, is that acceptable?
