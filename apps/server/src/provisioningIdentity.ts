// FILE: provisioningIdentity.ts
// Purpose: What a bootstrapped remote server answers when the broker asks "are
//          you the environment I provisioned?". The reading half of
//          remoteBootstrap/provisioningHandshake.ts, which is the deciding half.
// Layer: Server security policy
// Exports: ENVIRONMENT_ID_FILE_ENV, parseEnvironmentIdFile, readEnvironmentIdFile,
//          buildProvisioningIdentity, ProvisioningIdentityError
//
// Read from a FILE, and from a path named EXPLICITLY in the unit, for the same
// two reasons the credential is: `/proc/<pid>/environ` is readable by the
// process owner and inherited by every provider CLI we spawn, and a value
// derived from SYNARA_HOME by convention would silently follow a future change
// to the layout to a path nobody wrote.

import { readFileSync } from "node:fs";

export const ENVIRONMENT_ID_FILE_ENV = "SYNARA_ENVIRONMENT_ID_FILE";

export class ProvisioningIdentityError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ProvisioningIdentityError";
  }
}

/**
 * Extract the environment id from the file bootstrap wrote.
 *
 * Empty is an ERROR, not "no environment": the broker's verdict on a missing
 * environmentId is a refusal, and answering with an absent one would turn a
 * truncated write into a puzzling handshake failure rather than a clear one.
 */
export function parseEnvironmentIdFile(contents: string, filePath: string): string {
  const value = contents.trim();
  if (value.length === 0) {
    throw new ProvisioningIdentityError(
      `${ENVIRONMENT_ID_FILE_ENV} ${filePath} is empty; this server cannot say which environment it is.`,
    );
  }
  if (/[\n\r]/.test(value)) {
    throw new ProvisioningIdentityError(
      `${ENVIRONMENT_ID_FILE_ENV} ${filePath} must contain a single-line environment id.`,
    );
  }
  return value;
}

export function readEnvironmentIdFile(filePath: string): string {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new ProvisioningIdentityError(`Failed to read ${ENVIRONMENT_ID_FILE_ENV} ${filePath}.`, {
      cause,
    });
  }
  return parseEnvironmentIdFile(contents, filePath);
}

export interface ProvisioningIdentity {
  readonly environmentId: string | undefined;
  readonly serverVersion: string;
  /**
   * Echo of the credential the caller presented and this server ACCEPTED.
   *
   * Safe to return only because it is returned exclusively to a caller that
   * already authenticated with it — this route is behind the same bearer check
   * as everything else. What it proves is the thing an `authenticated: true`
   * flag cannot: that the token in the file this server read is the token the
   * broker minted, and not a leftover from an earlier install.
   */
  readonly acceptedToken: string | undefined;
  readonly authenticated: boolean;
}

/**
 * Assemble the claim. A server that cannot read its environment id still
 * answers — with the field ABSENT — because the broker's default-deny check is
 * where that becomes a refusal, and a 500 here would be indistinguishable from
 * a server that is not up yet.
 */
export function buildProvisioningIdentity(input: {
  readonly environmentIdFile: string | undefined;
  readonly serverVersion: string;
  readonly presentedToken: string | undefined;
  /**
   * Reads the file's RAW bytes. Deliberately the raw read and not the parsed
   * result: a seam that returned a finished id would skip `parseEnvironmentIdFile`
   * entirely, so the trimming and the single-line rule would be untested here
   * and a test could pass on a value the real path would reject.
   */
  readonly readFile?: (filePath: string) => string;
}): ProvisioningIdentity {
  let environmentId: string | undefined;
  if (input.environmentIdFile !== undefined && input.environmentIdFile.trim().length > 0) {
    const filePath = input.environmentIdFile.trim();
    try {
      environmentId =
        input.readFile === undefined
          ? readEnvironmentIdFile(filePath)
          : parseEnvironmentIdFile(input.readFile(filePath), filePath);
    } catch {
      environmentId = undefined;
    }
  }
  return {
    environmentId,
    serverVersion: input.serverVersion,
    acceptedToken: input.presentedToken,
    authenticated: input.presentedToken !== undefined,
  };
}
