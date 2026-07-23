# Architecture Rules

- Dependencies flow inward only: domain → application → infrastructure.
- One module per file. File name matches primary export. One public UI component per file; co-locate its previews and private helpers.
- Feature-based organization. Group by domain, not by type. One screen per package; split a crowded package into concept sub-packages so location predicts contents.
- The app entry point does setup only, then delegates to a state-driven navigation gate; the gate and each screen's host live in their own files.
- Define interfaces at boundaries. Concrete implementations behind interfaces.
- Split a unit the moment its responsibilities diverge; let logical cohesion, not size, drive the boundary.
- Conversation content (user/assistant/tool/trigger entries) lives in ConversationMirror. ShortTermContext is ambient/working memory only — sensor events, task table, task results, tonic state. Never inject user text or assistant output into ShortTermContext. AttentionGate wakes on `conversationMirror.onAppend` for user/trigger entries.
- AttentionGate owns salience accumulation. Two accumulators (`conversationSalience`, `ambientSalience`) bump on each wake signal via a salience-key lookup; merge + threshold check at dispatch time. Salience map keys are source-neutral (`conversation.user.text`, `conversation.trigger`, future `sensor.*`) — decoupled from ShortTermContext event kinds.
- Interrupt clears the conversation salience accumulator only. Ambient salience (sensor events, future triggers) stays in AttentionGate; the next cycle can still dispatch on ambient backlog. Never drop all pending signals on interrupt — user intent targets the conversation, not ambient world state.

> When a rule is unclear, read `agents/docs/architecture-details.md`.
