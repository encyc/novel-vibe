interface RuntimeEntry<T> {
  token: string;
  runtime: T;
  lastUsedAt: number;
}

export interface UserRuntimeRegistryOptions {
  maxEntries: number;
}

/**
 * Keeps at most one credential-bound runtime per verified user identity.
 * A rotated access token replaces that user's runtime, while an LRU bound
 * prevents a stream of distinct identities from growing process memory forever.
 */
export class UserRuntimeRegistry<T> {
  private readonly entries = new Map<string, RuntimeEntry<T>>();

  constructor(
    private readonly createRuntime: (token: string, userId: string) => T,
    private readonly options: UserRuntimeRegistryOptions,
  ) {
    if (options.maxEntries <= 0) throw new Error("Runtime registry maxEntries must be positive");
  }

  get(userId: string, token: string, now = Date.now()): T {
    const existing = this.entries.get(userId);
    if (existing?.token === token) {
      existing.lastUsedAt = now;
      return existing.runtime;
    }

    const runtime = this.createRuntime(token, userId);
    this.entries.set(userId, { token, runtime, lastUsedAt: now });
    this.enforceCapacity();
    return runtime;
  }

  get size(): number {
    return this.entries.size;
  }

  has(userId: string): boolean {
    return this.entries.has(userId);
  }

  values(): IterableIterator<T> {
    return Array.from(this.entries.values(), ({ runtime }) => runtime).values();
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.options.maxEntries) {
      let oldestUserId: string | undefined;
      let oldestLastUsed = Number.POSITIVE_INFINITY;
      for (const [userId, entry] of this.entries) {
        if (entry.lastUsedAt < oldestLastUsed) {
          oldestUserId = userId;
          oldestLastUsed = entry.lastUsedAt;
        }
      }
      if (!oldestUserId) return;
      this.entries.delete(oldestUserId);
    }
  }
}
