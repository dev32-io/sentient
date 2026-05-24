# Testing Rules — Details & Examples

## Keep-test bar

A test only earns its place by pinning one of:

1. **Wire contract** — message shape across a process boundary.
2. **FSM invariant** with a documented learning.
3. **Security boundary** — auth, injection defense, sanitization.
4. **`@live` flow** — vitest test against a real service (STT, TTS, Hermes), gated on credentials, run separately.

Anything else is dead weight. Borderline → delete.

Browser / end-to-end smoke is a separate discipline owned by the agent
and driven by Playwright MCP. See `.claude/rules/e2e-testing.md` and
`agents/docs/e2e-testing-details.md`.

## Examples — keep

### Wire-protocol contract (`shared/protocol/src/messages.test.ts`)

```typescript
describe("session.configure", () => {
  it("parses with explicit language", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      language: "zh",
      capabilities: { supports: ["audio", "text"] },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe("zh");
  });

  it("rejects missing capabilities", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      language: "en",
    });
    expect(result.success).toBe(false);
  });
});
```

This catches silent drift if a model rewrites the schema without updating the consumer's expectations.

### FSM invariant (`gateway/src/cerebrum/attention-gate.test.ts`)

The salience accumulator pins the documented invariant from `architecture.md`: interrupt clears the conversation accumulator only, not ambient. If a model rewrites the gate and breaks that, the test fires.

### Security boundary (`gateway/src/security/injection-scanner.test.ts`)

Six-layer prompt injection defense — each layer has its own contract.

## Examples — delete

### Render assertion / copy-string pinning

```typescript
// DELETE — any copy edit breaks the test, no real defense
it("renders title text", () => {
  const { getByText } = render(<VoicesPanel />);
  expect(getByText("Voice profiles")).toBeTruthy();
});
```

### CSS class pinning

```typescript
// DELETE — any restyle breaks the test, the component still works
it("applies pending class when message.pending is true", () => {
  expect(container.querySelector(".message-bubble--pending")).toBeTruthy();
});
```

### Pure-utility tautology

```typescript
// DELETE — the consumer would surface this immediately
it("returns undefined for unknown key", () => {
  expect(cache.get("missing")).toBeUndefined();
});
```

### Type / constant tests

```typescript
// DELETE — TypeScript already enforces this
it("ChatMessage has required fields", () => { ... });
```

## Test naming (when you do write one)

Pattern: `it('returns/throws/emits X when Y')`

```typescript
it("returns empty array when input is empty");
it("throws timeout error when provider exceeds 5 seconds");
it("emits transcript.final when speech ends");
```

## Mock providers, not internals

When a test needs to simulate an external service (STTService, Hermes, Fish Audio, an MCP server), use a mock provider that mirrors the wire protocol — never mock the unit's own collaborators. Mocking internals re-encodes the structure you wanted freedom to refactor.
