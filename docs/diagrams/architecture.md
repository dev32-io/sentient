# Architecture diagram

```mermaid
flowchart LR
    subgraph Clients
        Web[Preact web]
        Mobile[Android and iOS]
        Cube[ESP32 cube]
    end

    Edge[inbound-proxy<br/>HTTPS and WSS]

    subgraph Host[Apple-silicon Mac]
        Gateway[Native Bun gateway<br/>ReAct · SessionRuntime · tools]
        Store[(Append-only<br/>SQLite session stores)]

        subgraph Native[Native MLX addons]
            STT[Whisper STT]
            TTS[Qwen3 TTS]
            Memory[Deep Memory]
        end

        Hermes[Hermes CLI<br/>one-shot task]

        subgraph Addons[Supervised Docker addons]
            Ingress[ingress-proxy]
            Research[outbound worker<br/>and SearXNG]
            Egress[egress-proxy]
        end
    end

    Provider[OpenAI-compatible<br/>model provider]
    Tools[Calendar · Home Assistant<br/>Music Assistant · skills]

    Web --> Edge
    Mobile --> Edge
    Cube --> Edge
    Edge --> Gateway

    Gateway <--> Store
    Gateway <--> STT
    Gateway --> TTS
    Gateway <--> Memory
    Gateway <--> Provider
    Gateway --> Tools
    Gateway -. delegateTask .-> Hermes
    Gateway --> Ingress
    Ingress --> Research
    Research --> Egress
```

The gateway is the native agent runtime and host supervisor. `launchd` owns its
production lifecycle; the gateway owns the ReAct loop, durable sessions, tool
authorization, native services, and Docker addon lifecycle. Hermes is optional
one-shot delegation, not a service.

See [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the architecture
contract and [`../../shared/protocol/WIRE.md`](../../shared/protocol/WIRE.md)
for the client wire protocol.
