import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { HostPublicKeyJwk, type HostPublicKeyJwk as HostPublicKeyJwkType } from "@synara/contracts";
import { Effect, Schema } from "effect";

import { writeFileStringAtomically } from "../atomicWrite";
import { PRIVATE_FILE_MODE } from "../privatePathPermissions";

const HOST_IDENTITY_FILE_NAME = "host-identity.json";

type PersistedHostIdentity = {
  readonly version: 1;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
};

export interface HostIdentity extends PersistedHostIdentity {
  readonly publicKeyJwk: HostPublicKeyJwkType;
}

export function hostIdentityPath(secretsDir: string): string {
  return path.join(secretsDir, HOST_IDENTITY_FILE_NAME);
}

function publicJwk(publicKey: KeyObject): HostPublicKeyJwkType {
  const jwk = publicKey.export({ format: "jwk" });
  return Schema.decodeUnknownSync(HostPublicKeyJwk)(jwk);
}

function decodeHostIdentity(raw: string): HostIdentity {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("document is not an object");
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.privateKeyPem !== "string" ||
      typeof record.publicKeyPem !== "string"
    ) {
      throw new Error("document shape is invalid");
    }
    const privateKey = createPrivateKey(record.privateKeyPem);
    const persistedPublicKey = createPublicKey(record.publicKeyPem);
    const derivedPublicKey = createPublicKey(privateKey);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      persistedPublicKey.asymmetricKeyType !== "ed25519" ||
      !derivedPublicKey.equals(persistedPublicKey)
    ) {
      throw new Error("keypair is not a matching Ed25519 pair");
    }
    return {
      version: 1,
      privateKeyPem: record.privateKeyPem,
      publicKeyPem: record.publicKeyPem,
      publicKeyJwk: publicJwk(persistedPublicKey),
    };
  } catch (cause) {
    throw new Error("Stored host identity is invalid", { cause });
  }
}

export async function readHostIdentity(filePath: string): Promise<HostIdentity | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  return decodeHostIdentity(raw);
}

function generateHostIdentity(): HostIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeyJwk: publicJwk(publicKey),
  };
}

/** Generates a fresh identity and atomically makes it the persisted keypair. */
export async function generateAndPersistHostIdentity(filePath: string): Promise<HostIdentity> {
  const identity = generateHostIdentity();
  const persisted: PersistedHostIdentity = {
    version: identity.version,
    privateKeyPem: identity.privateKeyPem,
    publicKeyPem: identity.publicKeyPem,
  };
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(persisted, null, 2)}\n`,
      mode: PRIVATE_FILE_MODE,
    }),
  );
  return identity;
}

export async function deleteHostIdentity(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
