/**
 * In-memory registry of pending Signal pair operations, keyed by userId.
 * One pending link per user at a time. TTL-bound; expired entries are
 * cleaned lazily on lookup.
 */
export interface PendingLink {
  readonly userId: string;
  readonly uri: string;
  readonly expiresAt: number; // epoch ms
  readonly nonce: string;
}

export class PendingLinks {
  private readonly byUser = new Map<string, PendingLink>();

  put(link: PendingLink): void {
    this.byUser.set(link.userId, link);
  }

  get(userId: string): PendingLink | undefined {
    const entry = this.byUser.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.byUser.delete(userId);
      return undefined;
    }
    return entry;
  }

  has(userId: string): boolean {
    return this.get(userId) !== undefined;
  }

  clear(userId: string): boolean {
    return this.byUser.delete(userId);
  }
}
