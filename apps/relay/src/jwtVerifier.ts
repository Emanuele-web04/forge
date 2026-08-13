import {
  ApiJwks,
  type GrantClaims as GrantClaimsType,
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  GrantClaims,
  JWT_CLOCK_TOLERANCE_SECONDS,
  type RelayTicketClaims as RelayTicketClaimsType,
  RELAY_TICKET_JWT_TYP,
  RELAY_TICKET_MAX_AGE_SECONDS,
  RelayTicketClaims,
  SYNARA_RELAY_AUDIENCE,
} from "@synara/contracts";
import { Schema } from "effect";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import type { RelayFetch } from "./http";

const DEFAULT_JWKS_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_UNKNOWN_KID_REFRESH_INTERVAL_MS = 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type Logger = Pick<Console, "error">;

export type ApiJwtVerifierOptions = {
  apiBaseUrl: string;
  issuer: string;
  fetch?: RelayFetch;
  refreshIntervalMs?: number;
  unknownKidRefreshMinIntervalMs?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  now?: () => number;
};

function assertProtectedHeader(token: string, typ: string): void {
  const header = decodeProtectedHeader(token);
  if (header.typ !== typ) throw new Error(`JWT typ must be ${typ}`);
  if (header.alg !== "EdDSA") throw new Error("JWT signing algorithm is not allowed");
}

function assertBoundedLifetime(
  payload: JWTPayload,
  maxAgeSeconds: number,
  nowSeconds: number,
): void {
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error("JWT requires integer iat and exp claims");
  }
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxAgeSeconds) {
    throw new Error("JWT lifetime exceeds its allowed bound");
  }
  if (issuedAt > nowSeconds + JWT_CLOCK_TOLERANCE_SECONDS) {
    throw new Error("JWT iat is too far in the future");
  }
  if (expiresAt < nowSeconds) {
    throw new Error("JWT has expired");
  }
}

function isUnknownKid(error: unknown): boolean {
  return (
    error instanceof errors.JWKSNoMatchingKey ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_JWKS_NO_MATCHING_KEY")
  );
}

export class ApiJwtVerifier {
  private readonly fetchImpl: RelayFetch;
  private readonly refreshIntervalMs: number;
  private readonly unknownKidRefreshMinIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private localJwks: JWTVerifyGetKey | undefined;
  private refreshPromise: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private lastUnknownKidRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: ApiJwtVerifierOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_JWKS_REFRESH_INTERVAL_MS;
    this.unknownKidRefreshMinIntervalMs =
      options.unknownKidRefreshMinIntervalMs ?? DEFAULT_UNKNOWN_KID_REFRESH_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        this.logger.error("[relay] JWKS refresh failed; retaining last-known-good keys", error);
      });
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async verifyRelayTicket(token: string): Promise<RelayTicketClaimsType> {
    const payload = await this.verifyBounded(
      token,
      RELAY_TICKET_JWT_TYP,
      RELAY_TICKET_MAX_AGE_SECONDS,
    );
    return Schema.decodeUnknownSync(RelayTicketClaims)(payload);
  }

  async verifyGrant(token: string): Promise<GrantClaimsType> {
    const payload = await this.verifyBounded(token, GRANT_JWT_TYP, GRANT_MAX_AGE_SECONDS);
    return Schema.decodeUnknownSync(GrantClaims)(payload);
  }

  private async verifyBounded(
    token: string,
    typ: string,
    maxAgeSeconds: number,
  ): Promise<JWTPayload> {
    assertProtectedHeader(token, typ);
    let verified;
    try {
      verified = await this.verifySignature(token);
    } catch (error) {
      if (!isUnknownKid(error)) throw error;
      const activeRefresh = this.refreshPromise;
      if (activeRefresh) {
        await activeRefresh;
      } else {
        const nowMs = this.now();
        if (nowMs - this.lastUnknownKidRefreshAt < this.unknownKidRefreshMinIntervalMs) {
          throw error;
        }
        this.lastUnknownKidRefreshAt = nowMs;
        await this.refresh();
      }
      verified = await this.verifySignature(token);
    }
    const nowSeconds = Math.floor(this.now() / 1_000);
    assertBoundedLifetime(verified.payload, maxAgeSeconds, nowSeconds);
    return verified.payload;
  }

  private async verifySignature(token: string) {
    if (!this.localJwks) throw new Error("JWKS has not been initialized");
    return jwtVerify(token, this.localJwks, {
      audience: SYNARA_RELAY_AUDIENCE,
      issuer: this.options.issuer,
      algorithms: ["EdDSA"],
      clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(this.now()),
    });
  }

  private refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const pending = this.fetchJwks();
    this.refreshPromise = pending;
    const clear = () => {
      if (this.refreshPromise === pending) this.refreshPromise = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async fetchJwks(): Promise<void> {
    const response = await this.fetchImpl(`${this.options.apiBaseUrl}/api/v1/keys/jwks`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`JWKS request failed with HTTP ${response.status}`);
    const jwks = Schema.decodeUnknownSync(ApiJwks)(await response.json());
    this.localJwks = createLocalJWKSet(jwks as JSONWebKeySet);
  }
}
