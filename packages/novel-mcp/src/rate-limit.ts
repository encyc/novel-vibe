interface WindowState { startedAt: number; count: number }

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now = () => Date.now()) {}

  check(key: string): void {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= this.limit) throw new Error("RATE_LIMITED");
    current.count += 1;
  }
}
