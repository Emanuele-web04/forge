import fs from "node:fs/promises";
import path from "node:path";

import type { Es256PublicKeyJwk } from "@synara/contracts";
import {
  DEVICE_KEY_ALGORITHM,
  deviceThumbprint,
  exportPublicJwk,
  generateDeviceKey,
} from "@synara/shared/deviceKey";
import { Effect } from "effect";

import { withCredentialFileLock } from "../accountCredentialLock";
import { writeFileStringAtomically } from "../atomicWrite";
import { ensurePrivateDirectorySync, PRIVATE_FILE_MODE } from "../privatePathPermissions";

const DEVICE_IDENTITY_FILE_NAME = "device-identity.json";

type Es256PrivateKeyJwk = Es256PublicKeyJwk & { readonly d: string };

interface PersistedDeviceIdentity {
  readonly version: 1;
  readonly privateKeyJwk: Es256PrivateKeyJwk;
  readonly publicKeyJwk: Es256PublicKeyJwk;
}

export interface DeviceIdentity {
  /** Non-extractable runtime signing handle. */
  readonly key: CryptoKey;
  readonly publicJwk: Es256PublicKeyJwk;
  readonly jkt: string;
}

export function deviceIdentityPath(secretsDir: string): string {
  return path.join(secretsDir, DEVICE_IDENTITY_FILE_NAME);
}

function stringMember(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function decodePublicJwk(value: unknown): Es256PublicKeyJwk {
  if (typeof value !== "object" || value === null) throw new Error("public JWK is not an object");
  const record = value as Record<string, unknown>;
  if (record.kty !== "EC" || record.crv !== "P-256") {
    throw new Error("public JWK is not an ES256 key");
  }
  return { kty: "EC", crv: "P-256", x: stringMember(record, "x"), y: stringMember(record, "y") };
}

function decodePersisted(raw: string): PersistedDeviceIdentity {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("document is not an object");
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.privateKeyJwk !== "object" ||
    record.privateKeyJwk === null
  ) {
    throw new Error("document shape is invalid");
  }
  const publicKeyJwk = decodePublicJwk(record.publicKeyJwk);
  const privateRecord = record.privateKeyJwk as Record<string, unknown>;
  const privatePublic = decodePublicJwk(privateRecord);
  if (privatePublic.x !== publicKeyJwk.x || privatePublic.y !== publicKeyJwk.y) {
    throw new Error("private and public JWKs do not match");
  }
  return {
    version: 1,
    privateKeyJwk: { ...privatePublic, d: stringMember(privateRecord, "d") },
    publicKeyJwk,
  };
}

async function hydrate(persisted: PersistedDeviceIdentity): Promise<DeviceIdentity> {
  try {
    const [key, verificationKey] = await Promise.all([
      globalThis.crypto.subtle.importKey(
        "jwk",
        persisted.privateKeyJwk,
        DEVICE_KEY_ALGORITHM,
        false,
        ["sign"],
      ),
      globalThis.crypto.subtle.importKey(
        "jwk",
        persisted.publicKeyJwk,
        DEVICE_KEY_ALGORITHM,
        true,
        ["verify"],
      ),
    ]);
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const signature = await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      challenge,
    );
    if (
      !(await globalThis.crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verificationKey,
        signature,
        challenge,
      ))
    ) {
      throw new Error("private and public keys do not match");
    }
    return {
      key,
      publicJwk: persisted.publicKeyJwk,
      jkt: await deviceThumbprint(persisted.publicKeyJwk),
    };
  } catch (cause) {
    throw new Error("Stored device identity is invalid", { cause });
  }
}

export async function readDeviceIdentity(filePath: string): Promise<DeviceIdentity | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    return await hydrate(decodePersisted(raw));
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Stored device identity is invalid")
      throw cause;
    throw new Error("Stored device identity is invalid", { cause });
  }
}

async function generateAndPersistDeviceIdentity(filePath: string): Promise<DeviceIdentity> {
  // The generated private key is extractable only long enough to cross the
  // atomic persistence boundary. `hydrate` immediately turns the durable JWK
  // back into a non-extractable runtime signer.
  const generated = await generateDeviceKey({ extractable: true });
  const publicKeyJwk = await exportPublicJwk(generated);
  const exportedPrivate = await globalThis.crypto.subtle.exportKey("jwk", generated.privateKey);
  if (typeof exportedPrivate.d !== "string" || exportedPrivate.d.length === 0) {
    throw new Error("Generated device key did not contain private key material");
  }
  const persisted: PersistedDeviceIdentity = {
    version: 1,
    privateKeyJwk: { ...publicKeyJwk, d: exportedPrivate.d },
    publicKeyJwk,
  };
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(persisted, null, 2)}\n`,
      mode: PRIVATE_FILE_MODE,
    }),
  );
  return hydrate(persisted);
}

/** Loads this shell's key, or creates it exactly once across local processes. */
export async function loadOrCreateDeviceIdentity(filePath: string): Promise<DeviceIdentity> {
  ensurePrivateDirectorySync(path.dirname(filePath));
  return withCredentialFileLock(filePath, async () => {
    return (await readDeviceIdentity(filePath)) ?? generateAndPersistDeviceIdentity(filePath);
  });
}
