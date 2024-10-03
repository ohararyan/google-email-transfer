import { promisify } from 'util';

const sleep = promisify(setTimeout);

export class RateLimiter {
  private tokensPerSecond: number;
  private tokens: number;
  private lastRefill: number;

  constructor(tokensPerSecond: number) {
    this.tokensPerSecond = tokensPerSecond;
    this.tokens = tokensPerSecond;
    this.lastRefill = Date.now();
  }

  async waitForToken(): Promise<void> {
    const now = Date.now();
    const ellapsedMs = now - this.lastRefill;
    this.tokens = Math.min(this.tokensPerSecond, this.tokens + ellapsedMs * (this.tokensPerSecond / 1000));
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitMs = (1 - this.tokens) * (1000 / this.tokensPerSecond);
      await sleep(waitMs);
      return this.waitForToken();
    }

    this.tokens -= 1;
  }
}

export const rateLimiter = new RateLimiter(2); // Reduce to 2 requests per second

export async function exponentialBackoff(retries: number): Promise<void> {
  const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
  await sleep(delay);
}