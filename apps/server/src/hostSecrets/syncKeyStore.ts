import fs from "node:fs/promises";
import path from "node:path";

import { decodeBase64Url, encodeBase64Url, type HostSecretEntry } from "@synara/shared/hostSecrets";
import { Effect } from "effect";

import { withCredentialFileLock } from "../accountCredentialLock";
import { writeFileStringAtomically } from "../atomicWrite";
import { ensurePrivateDirectorySync, PRIVATE_FILE_MODE } from "../privatePathPermissions";

const HOST_SECRETS_SYNC_KEY_FILE = "host-secrets-sync-key.json";

interface StoredSyncKey {
  readonly version: 1;
  readonly accountUrl: string;
  readonly userId: string;
  readonly key: string;
  readonly pendingRotation?: {
    readonly deviceId: string;
    readonly revocationCompleted: boolean;
    readonly nextKey: string;
    readonly entries: readonly HostSecretEntry[];
  };
}

export interface HostSecretsPendingRotation {
  readonly deviceId: string;
  readonly revocationCompleted: boolean;
  readonly nextSyncKey: CryptoKey;
  readonly entries: readonly HostSecretEntry[];
}

export function hostSecretsSyncKeyPath(secretsDir: string): string {
  return path.join(secretsDir, HOST_SECRETS_SYNC_KEY_FILE);
}

async function importSyncKey(encoded: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(encoded);
  if (bytes.byteLength !== 32) throw new Error("Stored Host Secrets Sync Key is invalid");
  return globalThis.crypto.subtle.importKey("raw", bytes, { name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

function decodeStoredSyncKey(raw: string): StoredSyncKey {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("Stored Host Secrets Sync Key is invalid");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.accountUrl !== "string" ||
    record.accountUrl.length === 0 ||
    typeof record.userId !== "string" ||
    record.userId.length === 0 ||
    typeof record.key !== "string" ||
    record.key.length === 0
  ) {
    throw new Error("Stored Host Secrets Sync Key is invalid");
  }
  const pending = record.pendingRotation;
  let pendingRotation: StoredSyncKey["pendingRotation"];
  if (pending !== undefined) {
    if (!pending || typeof pending !== "object") {
      throw new Error("Stored Host Secrets rotation is invalid");
    }
    const rotation = pending as Record<string, unknown>;
    if (
      typeof rotation.deviceId !== "string" ||
      rotation.deviceId.length === 0 ||
      typeof rotation.revocationCompleted !== "boolean" ||
      typeof rotation.nextKey !== "string" ||
      rotation.nextKey.length === 0 ||
      !Array.isArray(rotation.entries)
    ) {
      throw new Error("Stored Host Secrets rotation is invalid");
    }
    const entries = rotation.entries.map((entry): HostSecretEntry => {
      if (!entry || typeof entry !== "object") {
        throw new Error("Stored Host Secrets rotation is invalid");
      }
      const candidate = entry as Record<string, unknown>;
      const envelope = candidate.envelope;
      if (!envelope || typeof envelope !== "object") {
        throw new Error("Stored Host Secrets rotation is invalid");
      }
      const sealed = envelope as Record<string, unknown>;
      if (
        typeof candidate.hostId !== "string" ||
        candidate.hostId.length === 0 ||
        typeof candidate.ownerUserId !== "string" ||
        candidate.ownerUserId.length === 0 ||
        typeof sealed.ciphertext !== "string" ||
        typeof sealed.iv !== "string" ||
        !Number.isSafeInteger(sealed.version) ||
        (sealed.version as number) < 1
      ) {
        throw new Error("Stored Host Secrets rotation is invalid");
      }
      return {
        hostId: candidate.hostId,
        ownerUserId: candidate.ownerUserId,
        envelope: {
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          version: sealed.version as number,
        },
      };
    });
    pendingRotation = {
      deviceId: rotation.deviceId,
      revocationCompleted: rotation.revocationCompleted,
      nextKey: rotation.nextKey,
      entries,
    };
  }
  return {
    version: 1,
    accountUrl: record.accountUrl,
    userId: record.userId,
    key: record.key,
    ...(pendingRotation ? { pendingRotation } : {}),
  };
}

async function readStoredSyncKey(filePath: string): Promise<StoredSyncKey | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  return decodeStoredSyncKey(raw);
}

function belongsTo(
  stored: StoredSyncKey,
  input: { readonly accountUrl: string; readonly userId: string },
): boolean {
  return stored.accountUrl === input.accountUrl && stored.userId === input.userId;
}

async function exportSyncKey(syncKey: CryptoKey): Promise<string> {
  const exported = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", syncKey));
  if (exported.byteLength !== 32) throw new Error("Host Secrets Sync Key must be 256 bits");
  return encodeBase64Url(exported);
}

async function writeStoredSyncKey(filePath: string, stored: StoredSyncKey): Promise<void> {
  ensurePrivateDirectorySync(path.dirname(filePath));
  await withCredentialFileLock(filePath, () =>
    Effect.runPromise(
      writeFileStringAtomically({
        filePath,
        contents: `${JSON.stringify(stored, null, 2)}\n`,
        mode: PRIVATE_FILE_MODE,
      }),
    ),
  );
}

export async function readHostSecretsSyncKey(input: {
  readonly filePath: string;
  readonly accountUrl: string;
  readonly userId: string;
}): Promise<CryptoKey | undefined> {
  const stored = await readStoredSyncKey(input.filePath);
  if (!stored || !belongsTo(stored, input)) return undefined;
  return importSyncKey(stored.key);
}

export async function readHostSecretsPendingRotation(input: {
  readonly filePath: string;
  readonly accountUrl: string;
  readonly userId: string;
}): Promise<HostSecretsPendingRotation | undefined> {
  const stored = await readStoredSyncKey(input.filePath);
  if (!stored || !belongsTo(stored, input) || !stored.pendingRotation) return undefined;
  return {
    deviceId: stored.pendingRotation.deviceId,
    revocationCompleted: stored.pendingRotation.revocationCompleted,
    nextSyncKey: await importSyncKey(stored.pendingRotation.nextKey),
    entries: stored.pendingRotation.entries,
  };
}

export async function writeHostSecretsSyncKey(input: {
  readonly filePath: string;
  readonly accountUrl: string;
  readonly userId: string;
  readonly syncKey: CryptoKey;
}): Promise<void> {
  if (!input.accountUrl || !input.userId) throw new Error("Sync-Key ownership is required");
  const stored: StoredSyncKey = {
    version: 1,
    accountUrl: input.accountUrl,
    userId: input.userId,
    key: await exportSyncKey(input.syncKey),
  };
  await writeStoredSyncKey(input.filePath, stored);
}

/** Durably retains both keys and unfinished ciphertexts across a partial rotation. */
export async function writeHostSecretsPendingRotation(input: {
  readonly filePath: string;
  readonly accountUrl: string;
  readonly userId: string;
  readonly syncKey: CryptoKey;
  readonly pendingRotation: HostSecretsPendingRotation;
}): Promise<void> {
  if (!input.accountUrl || !input.userId) throw new Error("Sync-Key ownership is required");
  const stored: StoredSyncKey = {
    version: 1,
    accountUrl: input.accountUrl,
    userId: input.userId,
    key: await exportSyncKey(input.syncKey),
    pendingRotation: {
      deviceId: input.pendingRotation.deviceId,
      revocationCompleted: input.pendingRotation.revocationCompleted,
      nextKey: await exportSyncKey(input.pendingRotation.nextSyncKey),
      entries: input.pendingRotation.entries,
    },
  };
  await writeStoredSyncKey(input.filePath, stored);
}
