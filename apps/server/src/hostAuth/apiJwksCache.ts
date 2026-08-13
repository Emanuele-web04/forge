import type { ApiJwks } from "@synara/contracts";

/** Shortest gap between forced refreshes, so an unknown kid cannot be a DoS. */
const MIN_FORCED_REFRESH_INTERVAL_MS = 60_000;

/** Refreshes API signing keys opportunistically while retaining last-known-good keys offline. */
export class ApiJwksCache {
  #cached: { readonly value: ApiJwks; readonly fetchedAtMs: number } | undefined;
  #lastForcedMs = 0;
  #inFlight: Promise<ApiJwks> | undefined;

  constructor(
    readonly fetchJwks: () => Promise<ApiJwks>,
    readonly options: { readonly refreshAfterMs?: number; readonly nowMs?: () => number } = {},
  ) {}

  async get(): Promise<ApiJwks> {
    const now = this.options.nowMs?.() ?? Date.now();
    if (
      this.#cached &&
      now - this.#cached.fetchedAtMs < (this.options.refreshAfterMs ?? 5 * 60_000)
    ) {
      return this.#cached.value;
    }
    return this.#fetch(now);
  }

  /**
   * Refetches because a token referenced a `kid` we do not hold — the API
   * rotated its signing key. Without this every mint fails until the periodic
   * refresh window elapses (up to five minutes of total outage). Rate-limited
   * and single-flighted so an attacker cannot turn unknown kids into a
   * request amplifier against the API.
   */
  async refreshForUnknownKid(): Promise<ApiJwks | undefined> {
    const now = this.options.nowMs?.() ?? Date.now();
    if (now - this.#lastForcedMs < MIN_FORCED_REFRESH_INTERVAL_MS) return undefined;
    this.#lastForcedMs = now;
    try {
      return await this.#fetch(now);
    } catch {
      return undefined;
    }
  }

  async #fetch(now: number): Promise<ApiJwks> {
    this.#inFlight ??= this.fetchJwks()
      .then((value) => {
        this.#cached = { value, fetchedAtMs: now };
        return value;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    try {
      return await this.#inFlight;
    } catch (error) {
      if (this.#cached) return this.#cached.value;
      throw error;
    }
  }
}
