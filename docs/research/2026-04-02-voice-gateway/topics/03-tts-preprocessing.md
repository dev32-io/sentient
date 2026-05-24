# TTS Preprocessing & Chunking

## Original Scope
- Sentence-level streaming: send each sentence to TTS as it completes
- Paragraph-level buffering: wait for natural breaks
- Hybrid/adaptive: first sentence ships fast, then switch to larger chunks
- Markdown stripping — converting LLM output to clean spoken text
- Emotion/tone tag injection — mapping LLM context to SSML or provider-specific tags
- Sentence boundary detection — libraries, heuristics, edge cases
- Handling edge cases: code blocks, lists, URLs, special characters
- Configurable chunking strategy — how to expose as a gateway setting

## Expanded Sub-Topics
- **Text normalization**: Number-to-word conversion, abbreviation expansion, unit pronunciation (e.g., "kg" → "kilograms")
- **Prosody preservation across chunks**: How splitting text affects intonation, and techniques to maintain natural flow
- **SSML generation**: Converting LLM hints to SSML tags for providers that support it (pitch, rate, emphasis, breaks)
- **Sentence boundary detection libraries**: PySBD, spaCy sentencizer, pragmatic_segmenter, custom regex — accuracy comparison
- **Backpressure handling**: What happens when TTS is slower than LLM output — buffering strategies
- **Chunk size optimization**: Empirical data on optimal chunk sizes for different TTS providers
- **Pronunciation dictionaries / lexicons**: Custom word pronunciation for brand names, technical terms
- **Multi-language detection**: Handling mixed-language LLM output for correct TTS routing

## Adjacent Areas
- LLM output formatting: Constraining model output to be TTS-friendly upstream vs cleaning downstream
- Caching: Identical text chunks producing identical audio — cache opportunities
- Latency budget: How preprocessing time fits into the overall pipeline latency budget

## Research Questions
1. What is the optimal chunking strategy that minimizes time-to-first-audio while maintaining natural prosody?
2. Which sentence boundary detection approach handles LLM output edge cases best (partial sentences, lists, code)?
3. How much latency does text normalization add, and can it be pipelined with TTS requests?
4. What are the practical SSML capabilities across major TTS providers, and is there a common subset?
5. How should the system handle backpressure when TTS processing is slower than LLM token generation?
