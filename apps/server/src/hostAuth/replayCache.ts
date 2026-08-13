import { JWT_CLOCK_TOLERANCE_SECONDS } from "@synara/contracts";

export class JwtReplayCache {
  readonly #entries = new Map<string, number>();

  /**
   * Remembers a jti until the token can no longer be accepted. Verification
   * allows `clockTolerance` past `exp`, so an entry retained only to `exp`
   * is swept while the JWT is still valid — and the token replays in that
   * window. Retention therefore extends by the same tolerance the verifier
   * grants, matching the shipped relay's cache.
   */
  consume(
    jti: string,
    expiresAtSeconds: number,
    nowSeconds = Math.floor(Date.now() / 1_000),
  ): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt < nowSeconds) this.#entries.delete(key);
    }
    if (this.#entries.has(jti)) throw new Error("JWT jti has already been used");
    this.#entries.set(jti, expiresAtSeconds + JWT_CLOCK_TOLERANCE_SECONDS);
  }
}
