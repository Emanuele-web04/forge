// FILE: providerUsage/providers/droidCredentials.ts
// Purpose: Read Factory CLI v2 credentials without modifying or refreshing them. Modern Droid
// stores an AES-256-GCM encrypted credential file whose key lives in the OS credential store
// (accessed through Factory's bundled keytar native module), or beside it in keyfile mode.

import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import nodePath from "node:path";

import { credentialFingerprint, decodeJwtExpMs } from "../credentials";
import { asRecord, asString } from "../parse";
import type { ProviderUsageContext } from "../types";

const require = createRequire(import.meta.url);

const KEYTAR_SERVICE = "Factory CLI";
const KEYTAR_ACCOUNT = "auth-encryption-key";
const ENCRYPTED_CREDENTIAL_FILE = "auth.v2.keyring";
const KEYFILE_CREDENTIAL_FILE = "auth.v2.file";
const KEYFILE_KEY_FILE = "auth.v2.key";
const LOCAL_LOGIN_MARKERS = [
  ENCRYPTED_CREDENTIAL_FILE,
  "auth.v2.loginkeychain",
  KEYFILE_CREDENTIAL_FILE,
] as const;

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
}

export interface DroidCredential {
  readonly accessToken: string;
  readonly activeOrganizationId?: string;
  readonly region?: string;
  readonly expiresAtMs: number | null;
  readonly source: "keyring" | "keyfile";
}

export interface DroidCredentialResolution {
  readonly credential: DroidCredential | null;
  readonly localLoginPresent: boolean;
}

type SecureKeyReader = (factoryHome: string) => Promise<Buffer | null>;

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function decodeEncryptionKey(value: string | Buffer): Buffer | null {
  if (Buffer.isBuffer(value) && value.length === 32) {
    return value;
  }
  const text = value.toString("utf8").trim();
  for (const encoding of ["base64", "hex"] as const) {
    try {
      const decoded = Buffer.from(text, encoding);
      if (decoded.length === 32) {
        return decoded;
      }
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

async function readBundledKeytarKey(factoryHome: string): Promise<Buffer | null> {
  const keytarPath = nodePath.join(factoryHome, "bin", "keytar.node");
  try {
    const keytar = require(keytarPath) as KeytarModule;
    const value = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    return value ? decodeEncryptionKey(value) : null;
  } catch {
    return null;
  }
}

async function readKeyfileKey(factoryHome: string): Promise<Buffer | null> {
  try {
    return decodeEncryptionKey(await fs.readFile(nodePath.join(factoryHome, KEYFILE_KEY_FILE)));
  } catch {
    return null;
  }
}

/** Factory's encrypted format is `base64(iv):base64(authTag):base64(ciphertext)`. */
export function decryptDroidCredentialFile(contents: string, key: Buffer): unknown | null {
  if (key.length !== 32) {
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

async function readEncryptedCredential(input: {
  path: string;
  source: DroidCredential["source"];
  readKey: SecureKeyReader;
  factoryHome: string;
}): Promise<DroidCredential | null> {
  try {
    const [contents, key] = await Promise.all([
      fs.readFile(input.path, "utf8"),
      input.readKey(input.factoryHome),
    ]);
    if (!key) {
      return null;
    }
    return parseDroidCredential(decryptDroidCredentialFile(contents, key), input.source);
  } catch {
    return null;
  }
}

export async function resolveDroidLocalCredential(
  ctx: Pick<ProviderUsageContext, "homeDir">,
  options: { readSecureKey?: SecureKeyReader } = {},
): Promise<DroidCredentialResolution> {
  const factoryHome = nodePath.join(ctx.homeDir, ".factory");
  const markerChecks = await Promise.all(
    LOCAL_LOGIN_MARKERS.map((name) => fileExists(nodePath.join(factoryHome, name))),
  );
  const localLoginPresent = markerChecks.some(Boolean);

  const keyringPath = nodePath.join(factoryHome, ENCRYPTED_CREDENTIAL_FILE);
  if (await fileExists(keyringPath)) {
    const credential = await readEncryptedCredential({
      path: keyringPath,
      source: "keyring",
      readKey: options.readSecureKey ?? readBundledKeytarKey,
      factoryHome,
    });
    if (credential) {
      return { credential, localLoginPresent: true };
    }
  }

  const keyfilePath = nodePath.join(factoryHome, KEYFILE_CREDENTIAL_FILE);
  if (await fileExists(keyfilePath)) {
    const credential = await readEncryptedCredential({
      path: keyfilePath,
      source: "keyfile",
      readKey: readKeyfileKey,
      factoryHome,
    });
    if (credential) {
      return { credential, localLoginPresent: true };
    }
  }

  return { credential: null, localLoginPresent };
}

export function droidCredentialCacheKey(
  ctx: Pick<ProviderUsageContext, "homeDir" | "nowMs">,
  resolution: DroidCredentialResolution,
  apiKey: string | undefined,
): string {
  const apiIdentity = apiKey ? credentialFingerprint(apiKey) : "none";
  if (resolution.credential) {
    const freshness =
      resolution.credential.expiresAtMs !== null &&
      resolution.credential.expiresAtMs <= ctx.nowMs
        ? "expired"
        : "fresh";
    return `${ctx.homeDir}:local:${credentialFingerprint(resolution.credential.accessToken)}:${freshness}:api:${apiIdentity}`;
  }
  if (apiKey) return `${ctx.homeDir}:api:${apiIdentity}`;
  return `${ctx.homeDir}:${resolution.localLoginPresent ? "local-unreadable" : "none"}`;
}
