# State Management — Details & Examples

## Signal Pattern (Preact Signals)

```tsx
import { signal, computed } from "@preact/signals";

const messages = signal<Message[]>([]);
const unreadCount = computed(() => messages.value.filter(m => !m.read).length);

// Update immutably
messages.value = [...messages.value, newMessage];
```

## Never Duplicate Server State

```tsx
// BAD — duplicating WebSocket data into local state
const [messages, setMessages] = useState<Message[]>([]);
ws.onmessage = (e) => setMessages(prev => [...prev, parse(e.data)]);

// GOOD — single source of truth from hook
const { messages } = useWebSocket();
```
