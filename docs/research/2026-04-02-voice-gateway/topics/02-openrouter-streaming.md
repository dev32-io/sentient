# OpenRouter Streaming Integration

## Original Scope
- OpenRouter streaming API — SSE format, token-level delivery
- Latency characteristics: time-to-first-token across different models
- Model compatibility matrix — which models stream well through OpenRouter
- Rate limits, pricing pass-through, reliability
- How to consume the stream and forward partial text to the TTS preprocessing layer
- Comparison with direct provider APIs (does the OpenRouter hop add meaningful latency?)
- Error handling and fallback strategies for stream interruptions

## Expanded Sub-Topics
- **Token-by-token vs chunk-based streaming**: How OpenRouter batches tokens, effect on downstream preprocessing
- **Model routing**: How OpenRouter selects providers, impact on latency consistency
- **Streaming with tool use / function calling**: Can the gateway handle structured tool-call responses mid-stream?
- **Context window management**: Strategies for conversation history in a voice context (shorter turns, summarization)
- **System prompt optimization**: Voice-specific system prompts — conciseness, spoken-word formatting, avoiding markdown
- **Model selection for voice**: Which models produce the most "speakable" output (short sentences, no markdown, natural phrasing)
- **Cost tracking**: Extracting token counts from streaming responses for billing

## Adjacent Areas
- Direct API comparison: calling Anthropic, OpenAI, Google directly vs through OpenRouter
- Local LLM serving: llama.cpp, vLLM, Ollama as alternatives for self-hosted LLM layer
- Prompt engineering for voice: crafting prompts that produce TTS-friendly output

## Research Questions
1. What is the measured latency overhead of OpenRouter vs direct API calls for streaming (TTFT comparison)?
2. Which models via OpenRouter produce the most natural spoken-word output without heavy post-processing?
3. How should the gateway handle OpenRouter rate limits and provider fallbacks transparently?
4. What is the optimal way to consume SSE streams and feed partial text to sentence boundary detection?
5. How do you handle mid-stream errors (provider switch, timeout) without audible disruption?
