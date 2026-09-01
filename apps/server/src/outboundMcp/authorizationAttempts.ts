import { randomBytes, timingSafeEqual } from "node:crypto";

import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export type AuthorizationAttempt = {
  readonly id: string;
  readonly connectionId: string;
  readonly state: string;
  readonly redirectUrl: URL;
  readonly createdAt: number;
  codeVerifier: string | null;
  oauthDiscoveryState: OAuthDiscoveryState | null;
};

export type AuthorizationAttemptRegistry = {
  readonly create: (connectionId: string, redirectUrl: URL) => AuthorizationAttempt;
  readonly saveVerifier: (attemptId: string, verifier: string) => void;
  readonly consume: (attemptId: string, state: string) => AuthorizationAttempt | null;
  readonly expire: (attemptId: string) => boolean;
  readonly cancel: (attemptId: string) => void;
};

const randomOpaqueValue = (): string => randomBytes(32).toString("hex");

export const MAX_AUTHORIZATION_ATTEMPT_TTL_MS = 10 * 60 * 1000;

function statesMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function makeAuthorizationAttemptRegistry(options: {
  readonly ttlMs: number;
}): AuthorizationAttemptRegistry {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error("Authorization attempt TTL must be a positive finite number.");
  }
  if (options.ttlMs > MAX_AUTHORIZATION_ATTEMPT_TTL_MS) {
    throw new Error(
      `Authorization attempt TTL must not exceed ${MAX_AUTHORIZATION_ATTEMPT_TTL_MS}ms.`,
    );
  }

  const attempts = new Map<string, AuthorizationAttempt>();
  const expired = (attempt: AuthorizationAttempt): boolean =>
    Date.now() - attempt.createdAt >= options.ttlMs;

  return {
    create: (connectionId, redirectUrl) => {
      const attempt: AuthorizationAttempt = {
        id: randomOpaqueValue(),
        connectionId,
        state: randomOpaqueValue(),
        redirectUrl: new URL(redirectUrl),
        createdAt: Date.now(),
        codeVerifier: null,
        oauthDiscoveryState: null,
      };
      attempts.set(attempt.id, attempt);
      return attempt;
    },
    saveVerifier: (attemptId, verifier) => {
      const attempt = attempts.get(attemptId);
      if (attempt === undefined) return;
      if (expired(attempt)) {
        attempts.delete(attemptId);
        return;
      }
      attempt.codeVerifier = verifier;
    },
    consume: (attemptId, state) => {
      const attempt = attempts.get(attemptId);
      if (attempt === undefined) return null;
      attempts.delete(attemptId);
      if (expired(attempt) || !statesMatch(attempt.state, state)) return null;
      return attempt;
    },
    expire: (attemptId) => {
      const attempt = attempts.get(attemptId);
      if (attempt === undefined || !expired(attempt)) return false;
      attempts.delete(attemptId);
      return true;
    },
    cancel: (attemptId) => {
      attempts.delete(attemptId);
    },
  };
}
