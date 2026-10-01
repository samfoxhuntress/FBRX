/** Sliding one-minute window limiter for tool calls. */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(private limitPerMinute: () => number) {}

  tryAcquire(now = Date.now()): boolean {
    const windowStart = now - 60_000;
    while (this.hits.length && this.hits[0] < windowStart) this.hits.shift();
    if (this.hits.length >= this.limitPerMinute()) return false;
    this.hits.push(now);
    return true;
  }
}
