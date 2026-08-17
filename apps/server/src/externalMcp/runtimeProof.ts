import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const externalMcpRuntimeSecret = randomBytes(32).toString("base64url");
export const EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER = "x-synara-runtime-challenge";

export function computeExternalMcpRuntimeProof(secret: string, nonce: string): string {
  return createHmac("sha256", secret)
    .update("synara.external-mcp.runtime\0")
    .update(nonce)
    .digest("base64url");
}

export function runtimeProofsMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
