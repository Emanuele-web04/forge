import type {
  GetHostSecretResponse,
  GetSyncKeyWrapResponse,
  ListDevicesResponse,
  ListHostsResponse,
  PutHostSecretRequest,
  PutHostSecretResponse,
  PutSyncKeyWrapRequest,
  PutSyncKeyWrapResponse,
  SyncKeyPairingCode,
  SyncKeyPairingRequest,
} from "@synara/contracts";
import {
  generatePairingKeyPair,
  generateSyncKey,
  pairingVerificationCode,
  rotateHostSecrets,
  unwrapSyncKey,
  wrapSyncKey,
  type HostSecretEntry,
  type PairingKeyPair,
  type WrappedSyncKey,
} from "@synara/shared/hostSecrets";

import {
  readHostSecretsPendingRotation,
  readHostSecretsSyncKey,
  writeHostSecretsPendingRotation,
  writeHostSecretsSyncKey,
  type HostSecretsPendingRotation,
} from "./syncKeyStore";

export interface HostSecretsCoordinatorApi {
  listHosts(): Promise<ListHostsResponse>;
  listDevices(): Promise<ListDevicesResponse>;
  getHostSecret(hostId: string): Promise<GetHostSecretResponse>;
  putHostSecret(hostId: string, request: PutHostSecretRequest): Promise<PutHostSecretResponse>;
  putSyncKeyWrap(request: PutSyncKeyWrapRequest): Promise<PutSyncKeyWrapResponse>;
  takeSyncKeyWrap(deviceId: string): Promise<GetSyncKeyWrapResponse>;
  revokeDevice(deviceId: string): Promise<void>;
}

interface PendingRecipientPairing {
  readonly keys: PairingKeyPair;
  received?: {
    readonly wrapped: WrappedSyncKey;
    readonly verificationCode: string;
  };
}

export class HostSecretsCoordinator {
  #pendingRecipient: PendingRecipientPairing | undefined;

  constructor(
    readonly options: {
      readonly accountUrl: string;
      readonly userId: string;
      readonly deviceId: string;
      readonly syncKeyFilePath: string;
      readonly api: HostSecretsCoordinatorApi;
    },
  ) {}

  async #readSyncKey(): Promise<CryptoKey | undefined> {
    return readHostSecretsSyncKey({
      filePath: this.options.syncKeyFilePath,
      accountUrl: this.options.accountUrl,
      userId: this.options.userId,
    });
  }

  async #writeSyncKey(syncKey: CryptoKey): Promise<void> {
    await writeHostSecretsSyncKey({
      filePath: this.options.syncKeyFilePath,
      accountUrl: this.options.accountUrl,
      userId: this.options.userId,
      syncKey,
    });
  }

  async #writePendingRotation(
    syncKey: CryptoKey,
    pendingRotation: HostSecretsPendingRotation,
  ): Promise<void> {
    await writeHostSecretsPendingRotation({
      filePath: this.options.syncKeyFilePath,
      accountUrl: this.options.accountUrl,
      userId: this.options.userId,
      syncKey,
      pendingRotation,
    });
  }

  /** New-device half: create the single-use ECDH request handed to an existing device. */
  async beginPairing(): Promise<SyncKeyPairingRequest> {
    if (await this.#readSyncKey()) {
      throw new Error("This device already has the Host Secrets Sync Key");
    }
    const keys = await generatePairingKeyPair();
    this.#pendingRecipient = { keys };
    return {
      recipientDeviceId: this.options.deviceId,
      recipientPublicJwk: keys.publicJwk,
    };
  }

  /** Existing-device half: wrap and upload, then show this returned code. */
  async offerSyncKey(request: SyncKeyPairingRequest): Promise<SyncKeyPairingCode> {
    let syncKey = await this.#readSyncKey();
    if (!syncKey) {
      syncKey = await generateSyncKey();
      await this.#writeSyncKey(syncKey);
    }
    const wrapped = await wrapSyncKey({
      syncKey,
      recipientPublicJwk: request.recipientPublicJwk,
    });
    const verificationCode = await pairingVerificationCode({
      senderPublicJwk: wrapped.ephemeralPublicJwk,
      recipientPublicJwk: wrapped.recipientPublicJwk,
    });
    await this.options.api.putSyncKeyWrap({
      recipientDeviceId: request.recipientDeviceId,
      wrap: wrapped,
    });
    return { verificationCode };
  }

  /** Consume the single-delivery wrap and show its code, without adopting its key yet. */
  async receiveSyncKey(): Promise<SyncKeyPairingCode> {
    const pending = this.#pendingRecipient;
    if (!pending) throw new Error("Start Sync-Key pairing on this device first");
    const { wrap } = await this.options.api.takeSyncKeyWrap(this.options.deviceId);
    const verificationCode = await pairingVerificationCode({
      senderPublicJwk: wrap.ephemeralPublicJwk,
      recipientPublicJwk: wrap.recipientPublicJwk,
    });
    pending.received = { wrapped: wrap, verificationCode };
    return { verificationCode };
  }

  /** The MITM gate: the user enters the other device's code before unwrap/persist. */
  async confirmSyncKey(input: { readonly verificationCode: string }): Promise<void> {
    const pending = this.#pendingRecipient?.received;
    const keys = this.#pendingRecipient?.keys;
    if (!pending || !keys) throw new Error("Receive a Sync-Key wrap before confirming pairing");
    if (input.verificationCode !== pending.verificationCode) {
      throw new Error("The pairing verification codes do not match");
    }
    const syncKey = await unwrapSyncKey({
      wrapped: pending.wrapped,
      recipientPrivateKey: keys.privateKey,
    });
    await this.#writeSyncKey(syncKey);
    this.#pendingRecipient = undefined;
  }

  async #ownedHostSecretEntries(): Promise<readonly HostSecretEntry[]> {
    const { hosts } = await this.options.api.listHosts();
    const owned = hosts.filter(
      (host) => host.mine === true && host.ownerUserId === this.options.userId,
    );
    const rows = await Promise.all(
      owned.map(async (host): Promise<HostSecretEntry | null> => {
        const { secret } = await this.options.api.getHostSecret(host.id);
        if (!secret) return null;
        return {
          hostId: host.id,
          ownerUserId: host.ownerUserId,
          envelope: {
            ciphertext: secret.ciphertext,
            iv: secret.iv,
            version: secret.version,
          },
        };
      }),
    );
    return rows.filter((entry): entry is HostSecretEntry => entry !== null);
  }

  async #continueRotation(
    oldSyncKey: CryptoKey,
    initial: HostSecretsPendingRotation,
  ): Promise<void> {
    let pending = initial;
    if (!pending.revocationCompleted) {
      const { devices } = await this.options.api.listDevices();
      const target = devices.find((device) => device.id === pending.deviceId);
      if (target?.revokedAt === null) {
        await this.options.api.revokeDevice(pending.deviceId);
      }
      // The journal is written only after the target was observed active. If
      // it is now absent/revoked, the DELETE completed before a prior process
      // stopped and must not be repeated (the API deliberately returns 404).
      pending = { ...pending, revocationCompleted: true };
      await this.#writePendingRotation(oldSyncKey, pending);
    }

    while (pending.entries.length > 0) {
      const [entry, ...remaining] = pending.entries;
      if (!entry) break;
      const current = (await this.options.api.getHostSecret(entry.hostId)).secret;
      if (!current) {
        throw new Error(`Host Secret disappeared during rotation for ${entry.hostId}`);
      }
      const alreadyUploaded =
        current.version === entry.envelope.version &&
        current.ciphertext === entry.envelope.ciphertext &&
        current.iv === entry.envelope.iv;
      if (!alreadyUploaded) {
        const expectedVersion = entry.envelope.version - 1;
        if (current.version !== expectedVersion) {
          throw new Error(`Host Secret changed during rotation for ${entry.hostId}`);
        }
        await this.options.api.putHostSecret(entry.hostId, {
          expectedVersion,
          envelope: entry.envelope,
        });
      }
      pending = { ...pending, entries: remaining };
      await this.#writePendingRotation(oldSyncKey, pending);
    }

    await this.#writeSyncKey(pending.nextSyncKey);
  }

  /**
   * Surviving-device removal path (ADR 0015). Crypto is prepared before the
   * irreversible DELETE, then every write is issued only after revocation.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    if (deviceId === this.options.deviceId) {
      throw new Error("Revoke this device from another device that is paired so it can rotate");
    }
    const oldSyncKey = await this.#readSyncKey();
    const unfinished = await readHostSecretsPendingRotation({
      filePath: this.options.syncKeyFilePath,
      accountUrl: this.options.accountUrl,
      userId: this.options.userId,
    });
    if (unfinished) {
      if (unfinished.deviceId !== deviceId) {
        throw new Error(
          `Finish rotating after device ${unfinished.deviceId} before another revoke`,
        );
      }
      if (!oldSyncKey) throw new Error("The Host Secrets rotation journal has no current key");
      await this.#continueRotation(oldSyncKey, unfinished);
      return;
    }

    const entries = await this.#ownedHostSecretEntries();
    if (entries.length === 0) {
      await this.options.api.revokeDevice(deviceId);
      return;
    }
    if (!oldSyncKey) {
      throw new Error("Pair this device before revoking another device with Host Secrets");
    }
    const { devices } = await this.options.api.listDevices();
    const target = devices.find((device) => device.id === deviceId && device.revokedAt === null);
    if (!target) throw new Error("Device not found or already revoked");
    const newSyncKey = await generateSyncKey();
    const rotated = await rotateHostSecrets({ oldSyncKey, newSyncKey, entries });
    const pending: HostSecretsPendingRotation = {
      deviceId,
      revocationCompleted: false,
      nextSyncKey: newSyncKey,
      entries: rotated,
    };
    await this.#writePendingRotation(oldSyncKey, pending);
    await this.#continueRotation(oldSyncKey, pending);
  }
}
