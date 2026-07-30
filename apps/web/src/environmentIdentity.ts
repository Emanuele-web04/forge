// FILE: environmentIdentity.ts
// Purpose: Cross-server environment identity for client-side transport state.
// Layer: Web transport
// Exports: the reserved local environment id.

import { EnvironmentId } from "@synara/contracts";

/**
 * Identity of the server that serves this page. Every client-side structure
 * that holds server-issued state (event sequences, resume cursors, replayed
 * pushes) is keyed by environment id, and the local server is simply the
 * default entry.
 *
 * This is a reserved client-side key, not the server's persisted
 * `environmentId` from `server.getEnvironment`: the local transport must be
 * addressable before any RPC has answered. Remote environments are registered
 * under their persisted id, which can never collide with this value because it
 * is not a UUID.
 */
export const LOCAL_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("local");
