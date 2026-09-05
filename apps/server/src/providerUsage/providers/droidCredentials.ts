// FILE: providerUsage/providers/droidCredentials.ts
// Purpose: Read Factory CLI v2 credentials without modifying or refreshing them. Modern Droid
// stores an AES-256-GCM encrypted credential file whose key lives in the OS credential store
// (read through bounded OS utility processes), or beside it in keyfile mode.

import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import nodePath from "node:path";

import { credentialFingerprint, decodeJwtExpMs } from "../credentials";
import { asRecord, asString } from "../parse";
import type { ProviderUsageContext } from "../types";

import { readDroidSecureKey } from "./droidSecureStorage";

export interface DroidCredential {
  readonly accessToken: string;
  readonly activeOrganizationId?: string;
  readonly region?: string;
  readonly expiresAtMs: number | null;
  readonly source: "keyring" | "login-keychain" | "keyfile";
}

export interface DroidCredentialResolution {
  readonly credential: DroidCredential | null;
  readonly localLoginPresent: boolean;
}

type SecureKeyReader = (
  factoryHome: string,
  source: "keyring" | "login-keychain",
) => Promise<Buffer | null>;

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function decodeEncryptionKey(value: string): Buffer | null {
  const text = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(text)) return null;
  const key = Buffer.from(text, "base64");
  return key.length === 32 && key.toString("base64") === text ? key : null;
}

async function readCredentialFile(path: string): Promise<string | null> {
  // Reject pipes/devices and bound reads before allocating/decrypting untrusted local data.
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead > 64 * 1024 ? null : bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Factory's encrypted format is `base64(iv):base64(authTag):base64(ciphertext)`. */
export function decryptDroidCredentialFile(contents: string, key: Buffer): unknown | null {
  if (key.length !== 32 || contents.length > 64 * 1024) {
    return null;
  }
  const parts = contents.trim().split(":");
  if (parts.length !== 3) {
    return null;
  }
  const [ivText, authTagText, ciphertextText] = parts;
  if (!ivText || !authTagText || !ciphertextText) {
    return null;
  }
  try {
    if (
      [ivText, authTagText, ciphertextText].some(
        (part) => Buffer.from(part, "base64").toString("base64") !== part,
      )
    )
      return null;
    const iv = Buffer.from(ivText, "base64");
    const authTag = Buffer.from(authTagText, "base64");
    if (iv.length !== 16 || authTag.length !== 16) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    return null;
  }
}

function parseDroidCredential(
  value: unknown,
  source: DroidCredential["source"],
): DroidCredential | null {
  const record = asRecord(value);
  const accessToken = asString(record?.access_token);
  if (!accessToken) {
    return null;
  }
  const activeOrganizationId = asString(record?.active_organization_id);
  const region = asString(record?.region);
  return {
    accessToken,
    expiresAtMs: decodeJwtExpMs(accessToken),
    source,
    ...(activeOrganizationId ? { activeOrganizationId } : {}),
    ...(region ? { region } : {}),
  };
}

export async function resolveDroidLocalCredential(
  ctx: Pick<ProviderUsageContext, "homeDir" | "platform" | "env">,
  options: { readSecureKey?: SecureKeyReader } = {},
): Promise<DroidCredentialResolution> {
  const factoryHome = nodePath.join(ctx.homeDir, ".factory");
  const layouts = [
    { name: "auth.v2.loginkeychain", source: "login-keychain" },
    { name: "auth.v2.keyring", source: "keyring" },
    { name: "auth.v2.file", source: "keyfile" },
  ] as const;
  for (const layout of layouts) {
    const path = nodePath.join(factoryHome, layout.name);
    // A present but unreadable newer store must not select an older account's leftover file.
    try {
      if (!(await fileExists(path))) continue;
      const contents = await readCredentialFile(path);
      if (!contents) return { credential: null, localLoginPresent: true };
      let key: Buffer | null;
      if (layout.source === "keyfile") {
        const text = await readCredentialFile(nodePath.join(factoryHome, "auth.v2.key"));
        key = text ? decodeEncryptionKey(text) : null;
      } else {
        const text = options.readSecureKey ? null : await readDroidSecureKey(ctx, layout.source);
        key = options.readSecureKey
          ? await options.readSecureKey(factoryHome, layout.source)
          : text
            ? decodeEncryptionKey(text)
            : null;
      }
      if (!key) return { credential: null, localLoginPresent: true };
      try {
        return {
          credential: parseDroidCredential(
            decryptDroidCredentialFile(contents, key),
            layout.source,
          ),
          localLoginPresent: true,
        };
      } finally {
        key.fill(0);
      }
    } catch {
      return { credential: null, localLoginPresent: true };
    }
  }
  return { credential: null, localLoginPresent: false };
}

export function droidLocalIdentity(credential: DroidCredential): string {
  return credentialFingerprint(
    JSON.stringify([
      credential.accessToken,
      credential.activeOrganizationId ?? null,
      credential.region ?? "global",
    ]),
  );
}

export function droidCredentialCacheKey(
  ctx: Pick<ProviderUsageContext, "homeDir" | "nowMs">,
  resolution: DroidCredentialResolution,
  apiKey: string | undefined,
): string {
  const apiIdentity = apiKey ? credentialFingerprint(apiKey) : "none";
  if (apiKey) return `${ctx.homeDir}:api:${apiIdentity}`;
  if (resolution.credential) {
    const freshness =
      resolution.credential.expiresAtMs !== null && resolution.credential.expiresAtMs <= ctx.nowMs
        ? "expired"
        : "fresh";
    return `${ctx.homeDir}:local:${droidLocalIdentity(resolution.credential)}:${freshness}:api:${apiIdentity}`;
  }
  return `${ctx.homeDir}:${resolution.localLoginPresent ? "local-unreadable" : "none"}`;
}
