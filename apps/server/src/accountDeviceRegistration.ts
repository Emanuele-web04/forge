import type { AccountDevicePlatform } from "@synara/contracts";
import type { AccountClient } from "@synara/shared/account";
import { signDeviceRegistration } from "@synara/shared/deviceKey";
import { Effect, Path as EffectPath } from "effect";

import {
  accountApiIssuer,
  readAccountCredentials,
  readAccountFile,
  SessionExpiredError,
  withFreshAccessToken,
  withLockedAccountFile,
  writeAccountCredentials,
} from "./accountAuth";
import { deriveServerPaths } from "./config";
import { deviceIdentityPath, loadOrCreateDeviceIdentity } from "./deviceIdentity";

export interface EnsureAccountDeviceRegistrationOptions {
  readonly baseDir: string;
  readonly accountUrl: string;
  readonly client: AccountClient;
  readonly displayName: string;
  readonly platform: AccountDevicePlatform;
  readonly devUrl?: URL;
  /** Supplied by a fresh `/me` read when upgrading a file that predates userId. */
  readonly userId?: string;
}

export interface RegisteredAccountDeviceIdentity {
  readonly deviceId: string;
  readonly jkt: string;
}

const runWithPath = <A, E>(effect: Effect.Effect<A, E, EffectPath.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(EffectPath.layer)));

/**
 * Registers the durable shell key with the active user session.
 *
 * POST /devices is intentionally called on every cold-launch enrollment:
 * the account service upserts an active (user,jkt) row, while a revoked row
 * causes it to create a fresh id for the same machine-retained key.
 */
export async function ensureAccountDeviceRegistration(
  options: EnsureAccountDeviceRegistrationOptions,
): Promise<RegisteredAccountDeviceIdentity> {
  const stored = await readAccountCredentials(options.baseDir);
  if (!stored || stored.accountUrl !== options.accountUrl) throw new SessionExpiredError();
  const userId = options.userId ?? stored.userId;
  if (!userId) throw new Error("The signed-in account is missing its user id");

  const { secretsDir } = await runWithPath(deriveServerPaths(options.baseDir, options.devUrl));
  const identity = await loadOrCreateDeviceIdentity(deviceIdentityPath(secretsDir));
  const response = await withFreshAccessToken(
    { baseDir: options.baseDir, client: options.client },
    async (accessToken) => {
      const proof = await signDeviceRegistration({
        key: identity.key,
        publicJwk: identity.publicJwk,
        userId,
        displayName: options.displayName,
        platform: options.platform,
        audience: accountApiIssuer(options.accountUrl),
      });
      return options.client.registerDevice(accessToken, proof);
    },
  );
  if (response.device.jkt !== identity.jkt) {
    throw new Error("The account registered a different device key than this shell retained");
  }

  const registration = { deviceId: response.device.id, jkt: identity.jkt };
  const persisted = await withLockedAccountFile(options.baseDir, async () => {
    const current = await readAccountFile(options.baseDir);
    if (
      !current ||
      current.accountUrl !== options.accountUrl ||
      (current.userId !== undefined && current.userId !== userId)
    ) {
      return false;
    }
    await writeAccountCredentials(options.baseDir, {
      ...current,
      userId,
      deviceId: registration.deviceId,
      deviceJkt: registration.jkt,
    });
    return true;
  });
  if (!persisted) throw new SessionExpiredError();
  return registration;
}
