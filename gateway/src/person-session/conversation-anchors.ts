// surfaceId → conversationId map, owned per-PersonSession. Extracted from
// SessionRouter: the anchor's lifetime is the surface's lifetime WITHIN one
// user's scope (never a process-global map). Pure wrapper — no logging (the
// owning PersonSession logs with its profile context).
export interface ConversationAnchors {
  get(surfaceId: string): string | null;
  set(surfaceId: string, conversationId: string): void;
  drop(surfaceId: string): boolean;
  clear(): void;
  size(): number;
}

export function createConversationAnchors(): ConversationAnchors {
  const anchors = new Map<string, string>();
  return {
    get: (surfaceId) => anchors.get(surfaceId) ?? null,
    set: (surfaceId, conversationId) => {
      anchors.set(surfaceId, conversationId);
    },
    drop: (surfaceId) => anchors.delete(surfaceId),
    clear: () => anchors.clear(),
    size: () => anchors.size,
  };
}
