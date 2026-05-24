# Preact Components — Details & Examples

## Component File Pattern

```tsx
// src/components/connection-status.tsx

export interface ConnectionStatusProps {
  state: "connecting" | "connected" | "disconnected";
}

export function ConnectionStatus({ state }: ConnectionStatusProps) {
  const label = {
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected",
  }[state];

  return <span class={`status status--${state}`}>{label}</span>;
}
```

## Container vs Presentational

```tsx
// Container — owns data, passes to presentational
export function ChatScreen() {
  const { messages, send } = useWebSocket();
  return <MessageList messages={messages} onSend={send} />;
}

// Presentational — pure, receives props
export function MessageList({ messages, onSend }: MessageListProps) {
  return (
    <section>
      {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
      <InputBar onSend={onSend} />
    </section>
  );
}
```
