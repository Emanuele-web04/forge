import { JWT_CLOCK_TOLERANCE_SECONDS } from "@synara/contracts";

export class GrantReplayCache {
  private readonly expiryByJti = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.expiryByJti.size;
  }

  consume(jti: string, expiresAtSeconds: number): boolean {
    const nowMs = this.now();
    for (const [cachedJti, expiryMs] of this.expiryByJti) {
      if (expiryMs <= nowMs) this.expiryByJti.delete(cachedJti);
    }
    if (this.expiryByJti.has(jti)) return false;
    this.expiryByJti.set(jti, (expiresAtSeconds + JWT_CLOCK_TOLERANCE_SECONDS) * 1_000);
    return true;
  }
}
