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
  openHostSecret,
  pairingVerificationCode,
  rotateHostSecrets,
  sealHostSecret,
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
    remainingAttempts: number;
  };
}

/**
 * Confirmations allowed before the pairing is destroyed.
 *
 * A mismatch has two causes and they deserve different treatment: a typo,
 * which is common and harmless, and a code that genuinely differs — which
 * means the wrap being confirmed came from a device other than the one in
 * front of the user, the exact interception this code exists to catch.
 * Retries forgive the first; a cap denies the second an unlimited supply of
 * guesses and, more importantly, forces the user back to a fresh exchange
 * instead of grinding at a suspicious one. Enforced here rather than in the
 * UI: a client-side cap is not a cap.
 */
const MAX_PAIRING_CONFIRMATION_ATTEMPTS = 3;

/** Distinguishes "try again" from "start over" for the caller and the UI. */
export class PairingVerificationError extends Error {
  constructor(
    readonly remainingAttempts: number,
    message: string,
  ) {
    super(message);
    this.name = "PairingVerificationError";
  }
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
    pending.received = {
      wrapped: wrap,
      verificationCode,
      remainingAttempts: MAX_PAIRING_CONFIRMATION_ATTEMPTS,
    };
    return { verificationCode };
  }

  /** The MITM gate: the user enters the other device's code before unwrap/persist. */
  async confirmSyncKey(input: { readonly verificationCode: string }): Promise<void> {
    const pending = this.#pendingRecipient?.received;
    const keys = this.#pendingRecipient?.keys;
    if (!pending || !keys) throw new Error("Receive a Sync-Key wrap before confirming pairing");
    if (input.verificationCode !== pending.verificationCode) {
      pending.remainingAttempts -= 1;
      if (pending.remainingAttempts <= 0) {
        // Burn the whole pairing, not just the attempt: the wrap was already
        // single-delivery, so there is nothing safe to retry against, and a
        // fresh exchange is the only way back.
        this.#pendingRecipient = undefined;
        throw new PairingVerificationError(
          0,
          "Too many incorrect codes. Pairing was cancelled — start again on both devices. " +
            "If the codes kept differing, the request may not have come from the device you expect.",
        );
      }
      throw new PairingVerificationError(
        pending.remainingAttempts,
        `That code does not match. ${pending.remainingAttempts} ${
          pending.remainingAttempts === 1 ? "attempt" : "attempts"
        } left before pairing is cancelled.`,
      );
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
        // Host deletion wins. Keeping an entry that can never be uploaded
        // would wedge this journal forever and block every later device
        // revocation on the surviving device.
        pending = { ...pending, entries: remaining };
        await this.#writePendingRotation(oldSyncKey, pending);
        continue;
      }
      const alreadyUploaded =
        current.version === entry.envelope.version &&
        current.ciphertext === entry.envelope.ciphertext &&
        current.iv === entry.envelope.iv;
      if (!alreadyUploaded) {
        let expectedVersion = entry.envelope.version - 1;
        let uploadEntry = entry;
        if (current.version !== expectedVersion) {
          // Another surviving owner device edited this host while the rotation
          // was paused. Rebase the pending write onto that latest old-key
          // ciphertext instead of pinning the journal to an obsolete version.
          const secret = await openHostSecret({
            syncKey: oldSyncKey,
            hostId: entry.hostId,
            ownerUserId: entry.ownerUserId,
            version: current.version,
            envelope: current,
          });
          uploadEntry = {
            ...entry,
            envelope: await sealHostSecret({
              syncKey: pending.nextSyncKey,
              hostId: entry.hostId,
              ownerUserId: entry.ownerUserId,
              version: current.version + 1,
              secret,
            }),
          };
          expectedVersion = current.version;
          // Persist the exact randomized envelope before uploading it. A crash
          // after the CAS can then recognize the completed write byte-for-byte
          // instead of trying to decrypt new-key ciphertext with the old key.
          pending = { ...pending, entries: [uploadEntry, ...remaining] };
          await this.#writePendingRotation(oldSyncKey, pending);
        }
        await this.options.api.putHostSecret(uploadEntry.hostId, {
          expectedVersion,
          envelope: uploadEntry.envelope,
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
    let oldSyncKey = await this.#readSyncKey();
    const unfinished = await readHostSecretsPendingRotation({
      filePath: this.options.syncKeyFilePath,
      accountUrl: this.options.accountUrl,
      userId: this.options.userId,
    });
    if (unfinished) {
      if (!oldSyncKey) throw new Error("The Host Secrets rotation journal has no current key");
      await this.#continueRotation(oldSyncKey, unfinished);
      if (unfinished.deviceId === deviceId) return;
      // The completed rotation adopted its next key. A different revocation
      // starts from that newly persisted key instead of the stale handle that
      // opened the journal.
      oldSyncKey = await this.#readSyncKey();
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
