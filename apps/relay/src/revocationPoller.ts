import { RevocationEventsResponse, type RevocationEvent } from "@synara/contracts";
import { Schema } from "effect";

import type { RelayFetch } from "./http";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type Logger = Pick<Console, "error">;

export type RevocationPollerOptions = {
  apiBaseUrl: string;
  serviceToken: string;
  onEvents: (events: readonly RevocationEvent[]) => void;
  fetch?: RelayFetch;
  pollIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
};

export class RevocationPoller {
  private readonly fetchImpl: RelayFetch;
  private readonly pollIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private failures = 0;
  cursor = 0;

  constructor(private readonly options: RevocationPollerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? console;
  }

  async initialize(): Promise<void> {
    try {
      const baseline = await this.request(undefined);
      this.cursor = baseline.watermark;
      this.failures = 0;
    } catch (error) {
      // Cursor zero is the safe fallback: the first successful poll replays the
      // retained feed instead of skipping a revocation that landed while the
      // API was unavailable during relay startup.
      this.cursor = 0;
      this.failures = 1;
      this.logger.error("[relay] revocation baseline failed; retrying from cursor zero", error);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.failures > 0 ? this.backoffDelay() : this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async pollNow(): Promise<void> {
    const response = await this.request(this.cursor);
    if (response.events.length > 0) this.options.onEvents(response.events);
    this.cursor = Math.max(this.cursor, response.watermark);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.runScheduledPoll(), delayMs);
    this.timer.unref?.();
  }

  private async runScheduledPoll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollNow();
      this.failures = 0;
      this.schedule(this.pollIntervalMs);
    } catch (error) {
      this.failures += 1;
      this.logger.error("[relay] revocation poll failed; retrying", error);
      this.schedule(this.backoffDelay());
    }
  }

  private backoffDelay(): number {
    return Math.min(this.initialBackoffMs * 2 ** Math.max(0, this.failures - 1), this.maxBackoffMs);
  }

  private async request(after: number | undefined) {
    const suffix = after === undefined ? "" : `?after=${after}`;
    const response = await this.fetchImpl(
      `${this.options.apiBaseUrl}/internal/revocations${suffix}`,
      {
        headers: { authorization: `Bearer ${this.options.serviceToken}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`Revocation request failed with HTTP ${response.status}`);
    }
    return Schema.decodeUnknownSync(RevocationEventsResponse)(await response.json());
  }
}
