import { createHash, randomBytes } from "node:crypto";

export const HOST_TOKEN_PREFIX = "synhost_";

export function hashHostToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintHostToken(): { token: string; hash: string } {
  const token = `${HOST_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashHostToken(token) };
}
