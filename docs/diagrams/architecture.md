# Architecture diagram

```mermaid
flowchart LR
    User((User))
    Mic[Mic / Capture Pi5]
    VAD[VAD<br/>20ms frames]
    STT[Streaming STT<br/>partial + final]
    Buf[Conversation buffer<br/>local]
    Hermes[Hermes worker<br/>LLM + agent loop]
    FC[Function-call<br/>dispatcher]
    TTS[Streaming TTS<br/>first-byte ~150ms]
    Speaker[Speaker / Compute Pi5]
    Barge[Barge-in detect]

    User -->|audio| Mic
    Mic -->|PCM 16kHz| VAD
    VAD -->|speech frames| STT
    STT -->|partial transcripts| Buf
    STT -->|final| Hermes
    Buf --> Hermes
    Hermes -->|assistant tokens| TTS
    Hermes -->|tool call| FC
    FC -->|result| Hermes
    TTS -->|PCM stream| Speaker
    Speaker --> User
    Mic -->|new speech| Barge
    Barge -->|cancel| TTS
    Barge -->|cancel| Hermes
    Barge -->|reset| STT
```

Render this to `architecture.svg` (committed alongside) so renderers that
don't speak mermaid still see the picture. Use:

```bash
npx -y @mermaid-js/mermaid-cli -i architecture.md -o architecture.svg
```

The SVG rendering is part of the post-publish backlog (see `ROADMAP.md`)
and not blocking for the initial release.
