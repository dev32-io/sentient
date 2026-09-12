const ALLOWED_BROKER_STAGES = [
  "tool-broker.dispatch.native.invalid-args",
  "tool-broker.dispatch.denied",
  "tool-broker.dispatch.native.done",
] as const;

/** Reduce local gateway logs to content-free stage names for one known call. */
export function safeLogStages(text: string, toolCallId: string | null): string[] {
  if (!toolCallId) return [];
  const stages = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes(toolCallId)) continue;
    for (const stage of ALLOWED_BROKER_STAGES) if (line.includes(stage)) stages.add(stage);
  }
  return [...stages];
}
