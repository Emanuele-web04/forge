// FILE: apiTokens.ts
// Purpose: Cryptographic API-token primitives for the future CORTEX cloud-control service.
//          This module has no database or HTTP dependency so persistence/auth adapters cannot
//          accidentally weaken token generation, hashing, or scope validation.
// Layer: Cloud-control security boundary

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CORTEX_API_TOKEN_SCOPES = [
  "cortex.ai.invoke",
  "projects.read",
  "projects.write",
  "workspaces.read",
  "workspaces.write",
  "repositories.read",
  "repositories.write",
  "tasks.read",
  "tasks.write",
  "organizations.read",
] as const;

export type CortexApiTokenScope = (typeof CORTEX_API_TOKEN_SCOPES)[number];

const TOKEN_PREFIX = "ctx_live_";
const TOKEN_SECRET_BYTES = 32;
const HASH_DOMAIN = "cortex-api-token:v1:";
const scopeSet = new Set<string>(CORTEX_API_TOKEN_SCOPES);

export type GeneratedApiToken = Readonly<{
  /** Secret shown exactly once by a create response; never persist or log it. */
  secret: string;
  /** Non-secret identifier safe to store and show in token lists. */
  prefix: string;
  /** Domain-separated SHA-256 digest, encoded as bytes for PostgreSQL BYTEA. */
  hash: Uint8Array;
}>;

export function isCortexApiTokenScope(value: string): value is CortexApiTokenScope {
  return scopeSet.has(value);
}

export function validateCortexApiTokenScopes(
  scopes: ReadonlyArray<string>,
): ReadonlyArray<CortexApiTokenScope> {
  if (scopes.length === 0) throw new Error("At least one API token scope is required.");
  const unique = [...new Set(scopes)];
  if (unique.some((scope) => !isCortexApiTokenScope(scope))) {
    throw new Error("API token scopes contain an unsupported capability.");
  }
  return unique as ReadonlyArray<CortexApiTokenScope>;
}

export function hashCortexApiToken(secret: string): Uint8Array {
  return createHash("sha256").update(HASH_DOMAIN).update(secret, "utf8").digest();
}

export function generateCortexApiToken(): GeneratedApiToken {
  // base64url is compact, URL/header-safe, and derived entirely from Node's CSPRNG.
  const secret = `${TOKEN_PREFIX}${randomBytes(TOKEN_SECRET_BYTES).toString("base64url")}`;
  return {
    secret,
    prefix: secret.slice(0, TOKEN_PREFIX.length + 8),
    hash: hashCortexApiToken(secret),
  };
}

/** Constant-time comparison for a syntactically valid candidate against a persisted digest. */
export function matchesCortexApiTokenHash(secret: string, persistedHash: Uint8Array): boolean {
  const candidateHash = hashCortexApiToken(secret);
  return (
    candidateHash.byteLength === persistedHash.byteLength &&
    timingSafeEqual(candidateHash, persistedHash)
  );
}
