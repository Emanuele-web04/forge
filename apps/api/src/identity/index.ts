// FILE: identity/index.ts
// Purpose: The one place an identity provider is chosen. Routes and app
// wiring call this factory and receive the four adapters; which concrete
// provider sits behind them is decided here, from config, and nowhere else.
// Layer: API identity (factory)
// Depends on: interfaces.ts, the provider implementations, the db-backed
// stores.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ApiConfig } from "../config";
import type * as schema from "../db/schema";
import { createDevIdentityProvider } from "./devProvider";
import { createDeviceRegistry } from "./deviceRegistry";
import { createHostGrantIssuer } from "./grantIssuer";
import { createHostKeyRegistry } from "./hostKeyRegistry";
import type { IdentityAdapters } from "./interfaces";
import { createRevocationLog } from "./revocationLog";
import { createApiSigningService } from "./signing";
import { createWorkosIdentityProvider } from "./workos";

export async function createIdentityAdapters(
  config: ApiConfig,
  db: NodePgDatabase<typeof schema>,
): Promise<IdentityAdapters> {
  const signing = await createApiSigningService({
    issuer: config.apiPublicUrl,
    seed: config.apiSigningKey,
    ...(config.apiSigningKeyPrevious ? { previousSeed: config.apiSigningKeyPrevious } : {}),
  });
  const hostKeys = createHostKeyRegistry(db, config.apiPublicUrl);
  const devices = createDeviceRegistry(db, config.apiPublicUrl);
  const hostGrants = createHostGrantIssuer(signing);
  const revocations = createRevocationLog(db);

  if (config.identityProvider === "dev") {
    const { verifier, grants, close } = await createDevIdentityProvider();
    return {
      verifier,
      grants,
      signing,
      hostKeys,
      devices,
      hostGrants,
      revocations,
      close,
    };
  }

  const { verifier, grants } = createWorkosIdentityProvider(config);
  return {
    verifier,
    grants,
    signing,
    hostKeys,
    devices,
    hostGrants,
    revocations,
    close: async () => {},
  };
}
