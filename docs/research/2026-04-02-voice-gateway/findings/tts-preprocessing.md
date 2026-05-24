# TTS Preprocessing & Chunking — Findings

> **Sources**: [PySBD Paper (arXiv:2010.09657)](https://arxiv.org/pdf/2010.09657) — 97.92% accuracy on Golden Rule Set, [PySBD GitHub](https://github.com/nipunsadvilkar/pySBD), [Pipecat TTS Guide](https://docs.pipecat.ai/guides/learn/text-to-speech) — PatternPairAggregator, TextAggregationMode.SENTENCE, [Pipecat GitHub](https://github.com/pipecat-ai/pipecat), [LiveKit Agents](https://github.com/livekit/agents), [LiveKit Voice Agent Architecture](https://livekit.com/blog/voice-agent-architecture-stt-llm-tts-pipelines-explained), [Deepgram Text Chunking for TTS](https://developers.deepgram.com/docs/tts-text-chunking) — sentence-boundary vs character-based chunking, [Deepgram E2E TTS Architecture](https://deepgram.com/learn/end-to-end-text-to-speech-architecture) — 50-70% latency reduction with streaming chunking, [ElevenLabs TTS Best Practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices) — prose-level tone cues over SSML, [Fish Audio emotion tags](https://docs.fish.audio/), [TTS Queue Overflow Strategies (Medium, Feb 2026)](https://medium.com/@paraschhugani/strategies-for-preventing-tts-queue-overflows-realtime-voice-agents-9567b24dbb90), [PolyNorm LLM Normalization (arXiv:2511.03080)](https://arxiv.org/html/2511.03080), [TartuNLP TTS Preprocess](https://github.com/TartuNLP/tts_preprocess_et), [CallStack Production STT/TTS Lessons](https://callstack.tech/blog/building-production-ready-stt-tts-implementations-with-llms-lessons-learned), [num2words](https://github.com/savoirfairelinux/num2words), [SBD for Text Chunking (safjan.com)](https://safjan.com/implementing-sentence-boundary-detection-in-python-for-improved-text-chunkin/)

## Chunking Strategies

### Sentence-Level Streaming
Send each complete sentence to TTS immediately as it's detected from the LLM stream.

- **Pros**: Fastest time-to-first-audio (TTFA); user hears something within 500ms-1s of LLM starting
- **Cons**: Prosody breaks at chunk boundaries — TTS can't anticipate the next sentence's tone; potential awkward pauses between chunks if TTS processing is variable
- **Latency**: TTFA = LLM TTFT + time to first sentence (~200-500ms of tokens) + TTS TTFA (~40-200ms)
- **Best for**: Conversational voice assistants where responsiveness matters most

### Paragraph-Level Buffering
Wait for a natural paragraph break (double newline or significant pause) before sending to TTS.

- **Pros**: Better prosody — TTS has full context for intonation planning; fewer API calls
- **Cons**: Significantly longer wait — user may wait 3-10s before hearing anything
- **Latency**: TTFA = LLM time to complete paragraph (2-10s) + TTS TTFA
- **Best for**: Narration, long-form content, non-interactive playback

### Hybrid/Adaptive Strategy (Recommended)
First sentence ships immediately, subsequent chunks are larger.

```
Chunk 1: First complete sentence → TTS immediately (minimize TTFA)
Chunk 2: Next 2-3 sentences grouped → TTS (better prosody)
Chunk 3+: Paragraph-level or 3-5 sentence groups → TTS
```

- **Pros**: Best of both worlds — fast first response, improving quality as conversation continues
- **Implementation**: Track chunk index; apply different grouping rules per index
- **What Pipecat does**: Sentence-level by default with configurable aggregation
- **What LiveKit does**: Sentence-level with their `SentenceTokenizer`

### Optimal Chunk Sizes by Provider
| Provider | Min Chunk | Optimal Chunk | Max Before Quality Loss |
|----------|-----------|---------------|------------------------|
| Cartesia | 1 word | 1-2 sentences | No limit |
| ElevenLabs | 1 sentence | 2-3 sentences | ~500 chars |
| Fish Audio | 1 sentence | 1-3 sentences | No limit |
| Kokoro | 1 sentence | 1-2 sentences | ~200 chars |

## Sentence Boundary Detection

### Library Comparison

| Library | Language | Accuracy | Speed | LLM Edge Cases | Best For |
|---------|----------|----------|-------|-----------------|----------|
| PySBD | Python | High | Fast | Good (abbreviations) | General use |
| spaCy sentencizer | Python | Medium | Very fast | Poor (no abbrev handling) | When speed > accuracy |
| NLTK Punkt | Python | High | Medium | Good | Established projects |
| pragmatic_segmenter | Ruby/ports | Highest | Medium | Excellent | Maximum accuracy |
| Custom regex | Any | Variable | Fastest | Configurable | Streaming pipelines |

### Recommended: PySBD + Custom Rules
```python
import pysbd

segmenter = pysbd.Segmenter(language="en", clean=False)

def detect_sentences(text: str) -> list[str]:
    return segmenter.segment(text)
```

### Streaming-Aware Sentence Detection
For streaming LLM output, you can't use libraries that expect complete text. Instead:

```python
import re

class StreamingSentenceDetector:
    SENTENCE_END = re.compile(
        r'(?<=[.!?])'           # After sentence-ending punctuation
        r'(?<![A-Z]\.)'          # Not after abbreviation like "Dr."
        r'(?<!\d\.)'             # Not after decimal like "3."
        r'(?<![A-Z]\.[A-Z]\.)'   # Not after "U.S."
        r'\s+'                   # Followed by whitespace
        r'(?=[A-Z"\'])'          # Next word starts with capital or quote
    )
    
    def __init__(self):
        self.buffer = ""
    
    def feed(self, token: str) -> list[str]:
        self.buffer += token
        sentences = []
        
        # Look for sentence boundaries
        matches = list(self.SENTENCE_END.finditer(self.buffer))
        if matches:
            last_match = matches[-1]
            complete = self.buffer[:last_match.end()]
            self.buffer = self.buffer[last_match.end():]
            # Split complete text into individual sentences
            parts = self.SENTENCE_END.split(complete)
            sentences = [s.strip() for s in parts if s.strip()]
        
        return sentences
    
    def flush(self) -> str | None:
        remaining = self.buffer.strip()
        self.buffer = ""
        return remaining if remaining else None
```

### Edge Cases to Handle
- **Abbreviations**: "Dr.", "Mr.", "U.S.", "etc." — not sentence endings
- **Decimal numbers**: "The price is 3.50" — not a sentence ending
- **Ellipsis**: "Well..." — may or may not be a sentence ending
- **URLs**: "Visit example.com" — not a sentence ending
- **Quotes**: 'She said "Hello." Then left.' — sentence ends after quote
- **Lists**: "1. First item" — LLM may generate numbered lists despite instructions

## Text Normalization

### Number-to-Word Conversion
Essential for TTS — numbers spoken as digits sound robotic.

```python
import num2words

def normalize_numbers(text: str) -> str:
    # Currency: "$1,234.56" → "one thousand two hundred thirty-four dollars and fifty-six cents"
    text = re.sub(r'\$[\d,]+\.?\d*', lambda m: dollars_to_words(m.group()), text)
    
    # Ordinals: "3rd" → "third"
    text = re.sub(r'\b(\d+)(st|nd|rd|th)\b', lambda m: num2words.num2words(int(m.group(1)), to='ordinal'), text)
    
    # Cardinals: "42" → "forty-two"
    text = re.sub(r'\b\d+\b', lambda m: num2words.num2words(int(m.group())), text)
    
    # Phone numbers: "555-1234" → "five five five, one two three four"
    text = re.sub(r'\b\d{3}[-.]?\d{4}\b', lambda m: digits_to_words(m.group()), text)
    
    return text
```

### Abbreviation Expansion
```python
ABBREVIATIONS = {
    "API": "A P I",
    "URL": "U R L",
    "HTML": "H T M L",
    "AI": "A I",
    "LLM": "L L M",
    "GPU": "G P U",
    "CPU": "C P U",
    "etc": "et cetera",
    "vs": "versus",
    "e.g.": "for example",
    "i.e.": "that is",
}
```

### Unit Pronunciation
```python
UNITS = {
    "km": "kilometers", "kg": "kilograms", "ms": "milliseconds",
    "GB": "gigabytes", "MB": "megabytes", "kHz": "kilohertz",
    "%": "percent", "°C": "degrees Celsius", "°F": "degrees Fahrenheit",
}
```

## Markdown Stripping

### Conversion Rules
```python
def strip_markdown_for_speech(text: str) -> str:
    # Headers: "## Title" → "Title"
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    
    # Bold/italic: **bold** *italic* → just the text
    text = re.sub(r'\*{1,3}(.*?)\*{1,3}', r'\1', text)
    text = re.sub(r'_{1,3}(.*?)_{1,3}', r'\1', text)
    
    # Links: [text](url) → "text"
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    
    # Inline code: `code` → "code"
    text = re.sub(r'`([^`]+)`', r'\1', text)
    
    # Code blocks: ```...``` → skip entirely or say "code block omitted"
    text = re.sub(r'```[\s\S]*?```', ' (code block omitted) ', text)
    
    # Lists: "- item" or "1. item" → "item"
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\d+\.\s+', '', text, flags=re.MULTILINE)
    
    # Horizontal rules
    text = re.sub(r'^---+$', '', text, flags=re.MULTILINE)
    
    # Multiple newlines → single space
    text = re.sub(r'\n{2,}', '. ', text)
    text = re.sub(r'\n', ' ', text)
    
    return text.strip()
```

### Code Block Handling
- **Skip entirely**: Best for voice — "I've included a code example" is better than reading code aloud
- **Describe**: "Here's a Python function that does X" — requires LLM cooperation
- **Best approach**: System prompt instructs LLM to never output code blocks in voice mode

## SSML & Emotion Tags

### Provider SSML Support
| Provider | SSML | Emotion Tags | Break/Pause | Emphasis | Rate/Pitch |
|----------|------|-------------|-------------|----------|------------|
| Cartesia | Partial | Style parameter | Yes | No | Speed param |
| ElevenLabs | Partial | Stability/similarity params | SSML break | No | Via settings |
| Fish Audio | Custom | 50+ emotion tags | Yes | Yes | Yes |
| Azure Neural | Full SSML | Via SSML mstts:express-as | Yes | Yes | Yes |
| Google Cloud | Full SSML | Limited | Yes | Yes | Yes |

### Fish Audio Emotion Tags
Fish Audio supports the richest emotion control: `happy`, `sad`, `angry`, `fearful`, `surprised`, `disgusted`, `neutral`, `calm`, `excited`, `whisper`, `shouting`, and many more.

### Practical SSML Usage
Most voice gateways skip SSML complexity and instead:
1. Use provider-specific API parameters for overall style (e.g., stability, speed)
2. Let TTS model infer emotion from text content
3. Only use `<break>` tags for deliberate pauses

## Backpressure Handling

### The Problem
LLM generates tokens at 30-100 tokens/sec. Each sentence → TTS API call → audio generation → delivery. If TTS is slower than LLM output, sentences queue up.

### Solution: Bounded Queue with Monitoring
```python
import asyncio

class TTSPipeline:
    def __init__(self, max_queue=10):
        self.queue = asyncio.Queue(maxsize=max_queue)
        self.metrics = {"queue_depth": 0, "dropped": 0}
    
    async def enqueue_sentence(self, text: str):
        if self.queue.full():
            # Strategy: drop oldest OR block LLM consumer
            # For voice: blocking is usually better (natural pacing)
            pass
        await self.queue.put(text)
        self.metrics["queue_depth"] = self.queue.qsize()
    
    async def tts_worker(self):
        while True:
            text = await self.queue.get()
            audio = await self.tts_provider.synthesize(text)
            await self.audio_output.send(audio)
            self.queue.task_done()
```

### Strategies
1. **Block LLM consumer**: Queue fills → LLM tokens buffer in memory → natural pacing. Simple, recommended
2. **Drop old chunks**: Discard queued sentences, only speak latest. Aggressive but responsive for interruptions
3. **Adaptive chunking**: When queue > threshold, merge queued sentences into larger chunks for fewer TTS calls

## Pronunciation Dictionaries

### Provider Support
- **ElevenLabs**: Pronunciation dictionaries via API, IPA or CMU format
- **Cartesia**: Custom vocabulary via API
- **Azure**: Custom lexicon in SSML `<lexicon>` tag
- **Google**: `<phoneme>` SSML tag with IPA
- **Self-hosted**: Most models support phoneme input or fine-tuning

### Implementation
```python
CUSTOM_PRONUNCIATIONS = {
    "kubectl": "cube cuddle",
    "Kubernetes": "koo-ber-net-eez",
    "nginx": "engine X",
    "PostgreSQL": "post-gres-Q-L",
    "IEEE": "I triple E",
}

def apply_pronunciations(text: str, custom: dict) -> str:
    for word, pronunciation in custom.items():
        text = re.sub(rf'\b{re.escape(word)}\b', pronunciation, text, flags=re.IGNORECASE)
    return text
```

## Full Preprocessing Pipeline

```python
class TTSPreprocessor:
    def __init__(self, config):
        self.sentence_detector = StreamingSentenceDetector()
        self.chunk_index = 0
        self.config = config  # chunking_strategy, normalize_numbers, etc.
    
    def process_token(self, token: str) -> list[str]:
        """Process a single LLM token, return TTS-ready chunks."""
        sentences = self.sentence_detector.feed(token)
        
        if not sentences:
            return []
        
        # Apply text normalization
        processed = []
        for s in sentences:
            s = strip_markdown_for_speech(s)
            s = normalize_numbers(s)
            s = expand_abbreviations(s)
            s = apply_pronunciations(s, self.config.pronunciations)
            if s.strip():
                processed.append(s)
        
        # Apply chunking strategy
        if self.config.chunking == "hybrid":
            return self._hybrid_chunk(processed)
        elif self.config.chunking == "sentence":
            return processed
        elif self.config.chunking == "paragraph":
            self._paragraph_buffer.extend(processed)
            return []  # Flush on paragraph break
        
        return processed
    
    def _hybrid_chunk(self, sentences: list[str]) -> list[str]:
        if self.chunk_index == 0:
            self.chunk_index += 1
            return sentences  # Ship first sentence immediately
        else:
            # Group into larger chunks
            # ... aggregation logic
            pass
```
